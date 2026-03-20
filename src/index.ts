import 'dotenv/config';
import http from 'http';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { TelegramChannel } from './channels/telegram.js';
import { WebChatChannel }  from './channels/webchat.js';
import { startMcpServer }  from './mcp/server.js';
import { AutoReplyEngine } from './auto-reply.js';
import { getPendingMessages, getConversations, getHistory } from './store/db.js';
import type { ChannelAdapter } from './types.js';

async function main() {
  process.stderr.write('[CLAWD] Starting...\n');

  // ── Auto-reply engine — resolves token automatically from claude.ai OAuth ──
  const autoReply = new AutoReplyEngine({
    systemPrompt: process.env.CLAWD_SYSTEM_PROMPT,
    adapters: [],
  });

  const onMsg = autoReply.isActive()
    ? (m: any) => autoReply.handleInbound(m)
    : undefined;

  // ── Channels ───────────────────────────────────────────────────────────────
  const wa = new WhatsAppChannel({ onMessage: onMsg });
  const tg = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN ?? '', { onMessage: onMsg });
  const wc = new WebChatChannel(parseInt(process.env.WEBCHAT_PORT ?? '18790', 10), { onMessage: onMsg });
  const adapters: ChannelAdapter[] = [wa, tg, wc];

  autoReply.setAdapters(adapters);

  await Promise.allSettled(
    adapters.map(a => a.connect().catch(e =>
      process.stderr.write(`[CLAWD] ${a.name} failed: ${e.message}\n`)
    ))
  );

  // ── Admin REST API ─────────────────────────────────────────────────────────
  const adminPort = parseInt(process.env.ADMIN_PORT ?? '18791', 10);
  const admin = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${adminPort}`);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'GET' && url.pathname === '/status') {
      res.end(JSON.stringify({
        channels: adapters.map(a => a.getStatus()),
        autoReply: autoReply.isActive(),
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/messages') {
      res.end(JSON.stringify(getPendingMessages(50))); return;
    }
    if (req.method === 'GET' && url.pathname === '/conversations') {
      res.end(JSON.stringify(getConversations())); return;
    }
    if (req.method === 'GET' && url.pathname === '/history') {
      const ch  = url.searchParams.get('channel')   ?? 'whatsapp';
      const cid = url.searchParams.get('contactId') ?? '';
      const lim = parseInt(url.searchParams.get('limit') ?? '30', 10);
      res.end(JSON.stringify(getHistory(ch, cid, lim))); return;
    }
    if (req.method === 'POST' && url.pathname === '/send') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', async () => {
        try {
          const { channel, contactId, message } = JSON.parse(body);
          const adapter = adapters.find(a => a.name === channel);
          if (!adapter) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: `Unknown channel: ${channel}` }));
            return;
          }
          res.end(JSON.stringify(await adapter.send(contactId, message)));
        } catch (e: any) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/autoreply/disable') {
      autoReply.stop();
      res.end(JSON.stringify({ ok: true, autoReply: false }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/autoreply/enable') {
      autoReply.resume();
      res.end(JSON.stringify({ ok: true, autoReply: autoReply.isActive() }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  admin.listen(adminPort, '127.0.0.1', () => {
    process.stderr.write(`[CLAWD] Admin API at http://127.0.0.1:${adminPort}\n`);
  });

  const shutdown = async () => {
    process.stderr.write('[CLAWD] Shutting down...\n');
    autoReply.stop();
    admin.close();
    await Promise.allSettled(adapters.map(a => a.disconnect()));
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);

  await startMcpServer(adapters);
}

main().catch(e => {
  process.stderr.write(`[CLAWD] Fatal: ${e.message}\n`);
  process.exit(1);
});
