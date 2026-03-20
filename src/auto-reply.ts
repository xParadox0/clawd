import type { ChannelAdapter } from './types.js';
import { markRead } from './store/db.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── Token resolution — re-reads from disk every call so refresh is picked up ─
function resolveToken(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const credPaths = [
    join(process.env.USERPROFILE ?? '', '.claude', '.credentials.json'),
    join(process.env.HOME ?? '', '.claude', '.credentials.json'),
  ];
  for (const p of credPaths) {
    if (!existsSync(p)) continue;
    try {
      const creds = JSON.parse(readFileSync(p, 'utf8'));
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) return token;
    } catch { /* skip */ }
  }
  return '';
}

// ── Conversation memory (last 40 messages = 20 turns) ──────────────────────
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

// ── Claude API call with retry ──────────────────────────────────────────────
async function callClaude(
  system: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const maxRetries = 3;
  const delays = [2000, 5000, 10000]; // 2s, 5s, 10s backoff

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const token = resolveToken(); // fresh token each attempt
    if (!token) throw new Error('No auth token found — log in to Claude Code or set ANTHROPIC_API_KEY');

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

    // Success
    if (res.ok) {
      const data = await res.json() as any;
      return (data.content?.[0]?.text ?? '').trim() || '(no response)';
    }

    const body = await res.text();

    // 401 — token expired, re-read on next attempt (already done above)
    if (res.status === 401) {
      process.stderr.write(`[CLAWD] Auth error (attempt ${attempt + 1}/${maxRetries + 1}) — token may have expired, retrying...\n`);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw new Error(`Auth failed after ${maxRetries + 1} attempts — please re-login to Claude Code: claude /login`);
    }

    // 429 — rate limited
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10) * 1000;
      process.stderr.write(`[CLAWD] Rate limited, waiting ${retryAfter / 1000}s...\n`);
      await new Promise(r => setTimeout(r, retryAfter));
      continue;
    }

    // 5xx — transient server error, retry
    if (res.status >= 500 && attempt < maxRetries) {
      process.stderr.write(`[CLAWD] API server error ${res.status} (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delays[attempt] / 1000}s...\n`);
      await new Promise(r => setTimeout(r, delays[attempt]));
      continue;
    }

    throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
  }

  throw new Error('Max retries exceeded');
}

// ── Types ───────────────────────────────────────────────────────────────────
export type InboundMessage = {
  id: string; channel: string; contactId: string;
  contactName: string; content: string; timestamp: number;
};

type PendingReply = {
  timer: ReturnType<typeof setTimeout>;
  lastMsgId: string;
  lastContent: string;
  contactName: string;
};

export class AutoReplyEngine {
  private system: string;
  private adapters: Map<string, ChannelAdapter>;
  private active: boolean;
  private delayMs: number;
  private pending = new Map<string, PendingReply>();

  constructor(opts: { systemPrompt?: string; adapters: ChannelAdapter[]; delayMs?: number }) {
    this.adapters = new Map(opts.adapters.map(a => [a.name, a]));
    this.delayMs = opts.delayMs ?? parseInt(process.env.CLAWD_REPLY_DELAY_MS ?? '300000', 10);
    this.system = opts.systemPrompt ?? [
      'You are Clawd, a personal AI assistant gateway running on the user\'s own computer.',
      'You have access to their WhatsApp, Telegram, and WebChat channels.',
      'Reply concisely and naturally.',
      'Support Bahasa Indonesia and English — reply in the same language the user writes in.',
    ].join(' ');

    const hasToken = !!resolveToken();
    this.active = hasToken;
    if (hasToken) {
      process.stderr.write(`[CLAWD] Auto-reply engine ready (delay: ${Math.round(this.delayMs / 60000)} min).\n`);
    } else {
      process.stderr.write('[CLAWD] Auto-reply disabled — no token found. Log in to Claude Code or set ANTHROPIC_API_KEY.\n');
    }
  }

  setAdapters(adapters: ChannelAdapter[]): void {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  async handleInbound(msg: InboundMessage): Promise<void> {
    if (!this.active) return;

    markRead([msg.id]);
    const memKey = `${msg.channel}:${msg.contactId}`;
    pushMemory(memKey, 'user', msg.content);

    const existing = this.pending.get(memKey);
    if (existing) {
      clearTimeout(existing.timer);
      process.stderr.write(`[CLAWD] Timer reset for ${msg.contactName} [${msg.channel}]\n`);
    }

    const timer = setTimeout(() => this.fireReply(memKey, msg), this.delayMs);
    this.pending.set(memKey, { timer, lastMsgId: msg.id, lastContent: msg.content, contactName: msg.contactName });
    process.stderr.write(`[CLAWD] Auto-reply scheduled in ${Math.round(this.delayMs / 1000)}s → ${msg.contactName} [${msg.channel}]\n`);
  }

  cancelPending(channel: string, contactId: string): void {
    const memKey = `${channel}:${contactId}`;
    const p = this.pending.get(memKey);
    if (p) {
      clearTimeout(p.timer);
      this.pending.delete(memKey);
      process.stderr.write(`[CLAWD] Auto-reply cancelled (manual reply) → ${p.contactName}\n`);
    }
  }

  private async fireReply(memKey: string, msg: InboundMessage): Promise<void> {
    this.pending.delete(memKey);
    if (!this.active) return;

    const adapter = this.adapters.get(msg.channel);
    if (!adapter?.getStatus().connected) {
      process.stderr.write(`[CLAWD] Auto-reply skipped — ${msg.channel} disconnected\n`);
      return;
    }

    process.stderr.write(`[CLAWD] Auto-reply firing → ${msg.contactName} [${msg.channel}]: "${msg.content}"\n`);
    try {
      const reply = await callClaude(this.system, getMemory(memKey));
      pushMemory(memKey, 'assistant', reply);
      const result = await adapter.send(msg.contactId, reply);
      if (result.ok) {
        process.stderr.write(`[CLAWD] Sent → "${reply.slice(0, 80)}"\n`);
      } else {
        process.stderr.write(`[CLAWD] Send failed: ${result.error}\n`);
      }
    } catch (e: any) {
      process.stderr.write(`[CLAWD] Auto-reply FAILED for ${msg.contactName}: ${e.message}\n`);
    }
  }

  pendingCount(): number { return this.pending.size; }

  stop(): void {
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    this.active = false;
    process.stderr.write('[CLAWD] Auto-reply paused.\n');
  }

  resume(): void {
    this.active = !!resolveToken();
    process.stderr.write('[CLAWD] Auto-reply resumed.\n');
  }

  isActive(): boolean { return this.active; }
}
