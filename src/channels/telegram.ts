import { Bot, Context } from 'grammy';
import { randomUUID } from 'crypto';
import { insertMessage } from '../store/db.js';
import type { ChannelAdapter, ChannelStatus, SendResult } from '../types.js';
import type { InboundMessage } from '../auto-reply.js';

export class TelegramChannel implements ChannelAdapter {
  name = 'telegram' as const;
  private bot: Bot | null = null;
  private status: ChannelStatus = { channel: 'telegram', connected: false, detail: 'Not started' };
  private onMessage?: (msg: InboundMessage) => void;

  constructor(private readonly token: string, opts?: { onMessage?: (msg: InboundMessage) => void }) {
    this.onMessage = opts?.onMessage;
  }

  async connect(): Promise<void> {
    if (!this.token) {
      this.status = { channel: 'telegram', connected: false, detail: 'No TELEGRAM_BOT_TOKEN — skipped' };
      process.stderr.write('[CLAWD] Telegram skipped (no token)\n');
      return;
    }
    this.bot = new Bot(this.token);
    this.bot.on('message:text', (ctx: Context) => {
      const msg  = ctx.message!;
      const from = msg.from!;
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || String(from.id);
      const text = msg.text ?? '';
      const id   = String(msg.message_id);
      const ts   = msg.date * 1000;

      insertMessage({ id, channel: 'telegram', contactId: String(msg.chat.id), contactName: name, content: text, timestamp: ts, direction: 'inbound', read: false });
      process.stderr.write(`[CLAWD] Telegram from ${name}: ${text}\n`);

      this.onMessage?.({ id, channel: 'telegram', contactId: String(msg.chat.id), contactName: name, content: text, timestamp: ts });
    });
    this.bot.catch((err) => {
      process.stderr.write(`[CLAWD] Telegram error: ${err.message}\n`);
      this.status = { channel: 'telegram', connected: false, detail: err.message };
    });
    this.bot.start({
      onStart: (info) => {
        this.status = { channel: 'telegram', connected: true, detail: `@${info.username} connected` };
        process.stderr.write(`[CLAWD] Telegram @${info.username} online\n`);
      },
    });
  }

  async send(contactId: string, text: string): Promise<SendResult> {
    if (!this.bot || !this.status.connected) return { ok: false, error: 'Telegram not connected' };
    try {
      const sent = await this.bot.api.sendMessage(Number(contactId), text);
      insertMessage({ id: String(sent.message_id), channel: 'telegram', contactId: String(sent.chat.id), contactName: String(sent.chat.id), content: text, timestamp: sent.date * 1000, direction: 'outbound', read: true });
      return { ok: true, messageId: String(sent.message_id) };
    } catch (e: any) { return { ok: false, error: e.message }; }
  }

  getStatus(): ChannelStatus { return this.status; }

  async disconnect(): Promise<void> {
    await this.bot?.stop();
    this.bot = null;
    this.status = { channel: 'telegram', connected: false, detail: 'Disconnected' };
  }
}
