import initSqlJs from 'sql.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Message, Conversation } from '../types.js';

const DATA_DIR  = process.env.CLAWD_DATA_DIR ?? join(homedir(), '.clawd');
export const AUTH_DIR = join(DATA_DIR, 'whatsapp-auth');
const DB_PATH   = join(DATA_DIR, 'clawd.db');

for (const d of [DATA_DIR, AUTH_DIR]) {
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// ── Bootstrap sql.js (sync wrapper around the async init) ──────────────────
const SQL = await initSqlJs();

let db: InstanceType<typeof SQL.Database>;
if (existsSync(DB_PATH)) {
  db = new SQL.Database(readFileSync(DB_PATH));
} else {
  db = new SQL.Database();
}

function persist(): void {
  writeFileSync(DB_PATH, db.export());
}

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id           TEXT PRIMARY KEY,
    channel      TEXT NOT NULL,
    contact_id   TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,
    direction    TEXT NOT NULL,
    read         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_msg_ch_ct  ON messages(channel, contact_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_msg_unread ON messages(read, direction);
`);
persist();

// ── Helpers ────────────────────────────────────────────────────────────────

function run(sql: string, params: any[] = []): void {
  db.run(sql, params);
  persist();
}

function all(sql: string, params: any[] = []): any[] {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows: any[] = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function rowToMessage(r: any): Message {
  return {
    id: r.id, channel: r.channel, contactId: r.contact_id,
    contactName: r.contact_name || r.contact_id,
    content: r.content, timestamp: r.timestamp,
    direction: r.direction, read: r.read === 1,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function insertMessage(msg: Message): void {
  run(
    `INSERT OR IGNORE INTO messages
       (id,channel,contact_id,contact_name,content,timestamp,direction,read)
     VALUES (?,?,?,?,?,?,?,?)`,
    [msg.id, msg.channel, msg.contactId, msg.contactName,
     msg.content, msg.timestamp, msg.direction, msg.read ? 1 : 0]
  );
}

export function getPendingMessages(limit = 50): Message[] {
  const rows = all(
    `SELECT * FROM messages WHERE direction='inbound' AND read=0
     ORDER BY timestamp ASC LIMIT ?`, [limit]
  );
  if (rows.length) markRead(rows.map(r => r.id));
  return rows.map(rowToMessage);
}

export function markRead(ids: string[]): void {
  if (!ids.length) return;
  run(`UPDATE messages SET read=1 WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}

export function getConversations(): Conversation[] {
  return all(`
    SELECT
      channel || ':' || contact_id AS id,
      channel, contact_id,
      MAX(contact_name)  AS contact_name,
      MAX(content)       AS last_message,
      MAX(timestamp)     AS last_timestamp,
      SUM(CASE WHEN direction='inbound' AND read=0 THEN 1 ELSE 0 END) AS unread_count
    FROM messages
    GROUP BY channel, contact_id
    ORDER BY last_timestamp DESC LIMIT 100
  `).map(r => ({
    id: r.id, channel: r.channel, contactId: r.contact_id,
    contactName: r.contact_name || r.contact_id,
    lastMessage: r.last_message, lastTimestamp: r.last_timestamp,
    unreadCount: r.unread_count,
  }));
}

export function getHistory(channel: string, contactId: string, limit = 50): Message[] {
  return all(
    `SELECT * FROM messages WHERE channel=? AND contact_id=?
     ORDER BY timestamp DESC LIMIT ?`, [channel, contactId, limit]
  ).reverse().map(rowToMessage);
}

export default db;
