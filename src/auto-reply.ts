import type { ChannelAdapter } from './types.js';
import { markRead } from './store/db.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── Token resolution ────────────────────────────────────────────────────────
// Priority: ANTHROPIC_API_KEY env → claude.ai OAuth token (from Claude Code)
function resolveToken(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;

  // Read claude.ai OAuth token from Claude Code credentials
  const credPaths = [
    join(process.env.USERPROFILE ?? '', '.claude', '.credentials.json'),
    join(process.env.HOME ?? '', '.claude', '.credentials.json'),
  ];
  for (const p of credPaths) {
    if (!existsSync(p)) continue;
    try {
      const creds = JSON.parse(readFileSync(p, 'utf8'));
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) {
        process.stderr.write('[CLAWD] Auto-reply using claude.ai OAuth token.\n');
        return token;
      }
    } catch { /* skip */ }
  }
  return '';
}

// ── In-memory conversation memory (last 40 messages = 20 turns) ────────────
const memory = new Map<string, Array<{ role: string; content: string }>>();
function getMemory(key: string) {
  if (!memory.has(key)) memory.set(key, []);
  return memory.get(key)!;
}
function pushMemory(key: string, role: 'user' | 'assistant', content: string) {
  const mem = getMemory(key);
  mem.push({ role, content });
  if (mem.length > 40) mem.splice(0, mem.length - 40);
}

// ── Claude API call ─────────────────────────────────────────────────────────
async function callClaude(
  system: string,
  messages: Array<{ role: string; content: string }>,
  token: string
): Promise<string> {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': token,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json() as any;
  return (data.content?.[0]?.text ?? '').trim() || '(no response)';
}

// ── Public types & class ────────────────────────────────────────────────────
export type InboundMessage = {
  id: string; channel: string; contactId: string;
  contactName: string; content: string; timestamp: number;
};

export class AutoReplyEngine {
  private token: string;
  private system: string;
  private adapters: Map<string, ChannelAdapter>;
  private inFlight = new Set<string>();
  private active: boolean;

  constructor(opts: { systemPrompt?: string; adapters: ChannelAdapter[] }) {
    this.token = resolveToken();
    this.adapters = new Map(opts.adapters.map(a => [a.name, a]));
    this.system = opts.systemPrompt ?? [
      'You are Clawd, a helpful personal AI assistant.',
      'Reply concisely and naturally.',
      'Keep answers short unless detail is asked for.',
      'Support Bahasa Indonesia and English — reply in the same language as the user.',
    ].join(' ');
    this.active = !!this.token;
    if (this.token) {
      process.stderr.write('[CLAWD] Auto-reply engine ready.\n');
    } else {
      process.stderr.write('[CLAWD] Auto-reply disabled — no API token found.\n');
      process.stderr.write('[CLAWD] Set ANTHROPIC_API_KEY in .env, or log in to Claude Code.\n');
    }
  }

  setAdapters(adapters: ChannelAdapter[]): void {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.active || !this.token) return;
    if (this.inFlight.has(msg.id)) return;
    this.inFlight.add(msg.id);
    try {
      markRead([msg.id]);
      const memKey = `${msg.channel}:${msg.contactId}`;
      pushMemory(memKey, 'user', msg.content);

      const adapter = this.adapters.get(msg.channel);
      if (!adapter?.getStatus().connected) {
        process.stderr.write(`[CLAWD] Auto-reply skipped — ${msg.channel} not connected\n`);
        return;
      }

      process.stderr.write(`[CLAWD] Auto-reply ← ${msg.contactName} [${msg.channel}]: "${msg.content}"\n`);

      // Re-read token each time in case it was refreshed
      const currentToken = resolveToken();
      const reply = await callClaude(this.system, getMemory(memKey), currentToken);
      pushMemory(memKey, 'assistant', reply);

      const result = await adapter.send(msg.contactId, reply);
      if (result.ok) {
        process.stderr.write(`[CLAWD] Auto-reply → "${reply.slice(0, 80)}"\n`);
      } else {
        process.stderr.write(`[CLAWD] Auto-reply send failed: ${result.error}\n`);
      }
    } catch (e: any) {
      process.stderr.write(`[CLAWD] Auto-reply error: ${e.message}\n`);
    } finally {
      this.inFlight.delete(msg.id);
    }
  }

  stop()     { this.active = false; process.stderr.write('[CLAWD] Auto-reply paused.\n'); }
  resume()   { this.active = !!this.token; process.stderr.write('[CLAWD] Auto-reply resumed.\n'); }
  isActive() { return this.active; }
}
