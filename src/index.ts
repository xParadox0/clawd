import 'dotenv/config';
import { WhatsAppChannel } from './channels/whatsapp.js';
import { TelegramChannel } from './channels/telegram.js';
import { WebChatChannel }  from './channels/webchat.js';
import { startMcpServer }  from './mcp/server.js';
import type { ChannelAdapter } from './types.js';

async function main() {
  process.stderr.write('[CLAWD] Starting...\n');

  const adapters: ChannelAdapter[] = [
    new WhatsAppChannel(),
    new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN ?? ''),
    new WebChatChannel(parseInt(process.env.WEBCHAT_PORT ?? '18790', 10)),
  ];

  await Promise.allSettled(
    adapters.map(a => a.connect().catch(e =>
      process.stderr.write(`[CLAWD] ${a.name} failed: ${e.message}\n`)
    ))
  );

  const shutdown = async () => {
    process.stderr.write('[CLAWD] Shutting down...\n');
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
