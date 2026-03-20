import makeWASocket, {
  useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore, isJidBroadcast,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import { randomUUID } from 'crypto';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { insertMessage, AUTH_DIR } from '../store/db.js';
import type { ChannelAdapter, ChannelStatus, SendResult } from '../types.js';

const logger = pino({ level: 'silent' });

export class WhatsAppChannel implements ChannelAdapter {
  name = 'whatsapp' as const;
  private sock: ReturnType<typeof makeWASocket> | null = null;
  private status: ChannelStatus = { channel: 'whatsapp', connected: false, detail: 'Not started' };
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  async connect(): Promise<void> { await this._start(); }

  private async _start(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version, logger,
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      browser: ['Clawd', 'Desktop', '1.0.0'],
      getMessage: async () => undefined,
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.status = { channel: 'whatsapp', connected: false, detail: 'Scan QR in terminal' };
        process.stderr.write('\n[CLAWD] ======= WHATSAPP QR CODE =======\n');
        process.stderr.write('[CLAWD] Scan with: WhatsApp > Settings > Linked Devices > Link a Device\n\n');
        qrcode.generate(qr, { small: true });
        process.stderr.write('\n[CLAWD] =====================================\n\n');
      }
      if (connection === 'open') {
        this.status = { channel: 'whatsapp', connected: true, detail: 'Connected' };
        process.stderr.write('[CLAWD] WhatsApp connected!\n');
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const retry = code !== DisconnectReason.loggedOut;
        this.status = { channel: 'whatsapp', connected: false, detail: retry ? 'Reconnecting...' : 'Logged out' };
        if (retry) {
          process.stderr.write('[CLAWD] WhatsApp disconnected, reconnecting in 5s...\n');
          this.retryTimer = setTimeout(() => this._start(), 5000);
        } else {
          process.stderr.write('[CLAWD] WhatsApp logged out.\n');
        }
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe || isJidBroadcast(msg.key.remoteJid ?? '')) continue;
        const jid  = msg.key.remoteJid ?? '';
        const text = msg.message.conversation
          || msg.message.extendedTextMessage?.text
          || msg.message.imageMessage?.caption
          || '[media]';
        insertMessage({
          id: msg.key.id ?? randomUUID(), channel: 'whatsapp',
          contactId: jid, contactName: msg.pushName ?? jid.split('@')[0],
          content: text, timestamp: (msg.messageTimestamp as number) * 1000,
          direction: 'inbound', read: false,
        });
        process.stderr.write(`[CLAWD] WhatsApp message from ${msg.pushName ?? jid}: ${text}\n`);
      }
    });
  }

  async send(contactId: string, text: string): Promise<SendResult> {
    if (!this.sock || !this.status.connected) return { ok: false, error: 'WhatsApp not connected' };
    try {
      const jid  = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`;
      const sent = await this.sock.sendMessage(jid, { text });
      const msgId = sent?.key.id ?? undefined;
      insertMessage({
        id: msgId ?? randomUUID(), channel: 'whatsapp',
        contactId: jid, contactName: jid.split('@')[0],
        content: text, timestamp: Date.now(), direction: 'outbound', read: true,
      });
      return { ok: true, messageId: msgId };
    } catch (e: any) { return { ok: false, error: e.message }; }
  }

  getStatus(): ChannelStatus { return this.status; }

  async disconnect(): Promise<void> {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.sock?.logout();
    this.sock = null;
    this.status = { channel: 'whatsapp', connected: false, detail: 'Disconnected' };
  }
}
