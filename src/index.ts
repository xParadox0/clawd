import 'dotenv/config';
import http from 'http';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { TelegramChannel } from './channels/telegram.js';
import { WebChatChannel }  from './channels/webchat.js';
import { startMcpServer }  from './mcp/server.js';
import { getPendingMessages, getConversations, getHistory } from './store/db.js';
import type { ChannelAdapter } from './types.js';

async function main() {
  process.stderr.write('[CLAWD] Starting...\n');

  const wa = new WhatsAppChannel();
  const tg = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN ?? '');
  const wc = new WebChatChannel(parseInt(process.env.WEBCHAT_PORT ?? '18790', 10));

  const adapters: ChannelAdapter[] = [wa, tg, wc];

  await Promise.allSettled(
    adapters.map(a => a.connect().catch(e =>
      process.stderr.write(`[CLAWD] ${a.name} failed: ${e.message}\n`)
    ))
  );

  // ── Internal admin REST API on port 18791 ──────────────────────────────────
  const adminPort = parseInt(process.env.ADMIN_PORT ?? '18791', 10);
  const admin = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${adminPort}`);
    res.setHeader('Content-Type', 'application/json');

    // GET /status
    if (req.method === 'GET' && url.pathname === '/status') {
      res.end(JSON.stringify(adapters.map(a => a.getStatus())));
      return;
    }

    // GET /messages
    if (req.method === 'GET' && url.pathname === '/messages') {
      res.end(JSON.stringify(getPendingMessages(50)));
      return;
    }

    // GET /conversations
    if (req.method === 'GET' && url.pathname === '/conversations') {
      res.end(JSON.stringify(getConversations()));
      return;
    }

    // GET /history?channel=whatsapp&contactId=xxx&limit=30
    if (req.method === 'GET' && url.pathname === '/history') {
      const channel = url.searchParams.get('channel') ?? 'whatsapp';
      const contactId = url.searchParams.get('contactId') ?? '';
      const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
      res.end(JSON.stringify(getHistory(channel, contactId, limit)));
      return;
    }

    // POST /send  body: { channel, contactId, message }
    if (req.method === 'POST' && url.pathname === '/send') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { channel, contactId, message } = JSON.parse(body);
          const adapter = adapters.find(a => a.name === channel);
          if (!adapter) { res.statusCode = 400; res.end(JSON.stringify({ ok: false, error: `Unknown channel: ${channel}` })); return; }
          const result = await adapter.send(contactId, message);
          res.end(JSON.stringify(result));
        } catch (e: any) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
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
