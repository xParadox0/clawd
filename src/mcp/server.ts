import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPendingMessages, getConversations, getHistory } from '../store/db.js';
import type { ChannelAdapter } from '../types.js';
import type { WebChatChannel } from '../channels/webchat.js';

const ADMIN = 'http://127.0.0.1:18791';

async function adminGet(path: string): Promise<any> {
  const res = await fetch(`${ADMIN}${path}`);
  return res.json();
}

async function adminSend(channel: string, contactId: string, message: string): Promise<any> {
  const res = await fetch(`${ADMIN}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel, contactId, message }),
  });
  return res.json();
}

export async function startMcpServer(adapters: ChannelAdapter[]): Promise<void> {
  const server = new McpServer({ name: 'clawd', version: '1.0.0' });
  const webchat = adapters.find(a => a.name === 'webchat') as WebChatChannel | undefined;

  server.tool(
    'clawd_get_pending_messages',
    'Get all unread inbound messages from WhatsApp, Telegram, and WebChat.',
    { limit: z.number().optional().default(50) },
    async ({ limit }) => {
      const msgs = getPendingMessages(limit);
      if (!msgs.length) return { content: [{ type: 'text', text: 'No pending messages.' }] };
      return {
        content: [{
          type: 'text',
          text: msgs.map(m =>
            `[${m.channel.toUpperCase()}] ${m.contactName} (${m.contactId}) @ ${new Date(m.timestamp).toLocaleString()}:\n${m.content}`
          ).join('\n\n---\n\n')
        }]
      };
    }
  );

  server.tool(
    'clawd_send_message',
    'Send a reply to a contact on whatsapp, telegram, or webchat.',
    {
      channel:   z.enum(['whatsapp', 'telegram', 'webchat']),
      contactId: z.string().describe('Phone number (WhatsApp), chat ID (Telegram), or session ID (WebChat)'),
      message:   z.string(),
    },
    async ({ channel, contactId, message }) => {
      try {
        const r = await adminSend(channel, contactId, message);
        return { content: [{ type: 'text', text: r.ok ? `✓ Sent on ${channel} to ${contactId}` : `✗ Failed: ${r.error}` }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `✗ Admin API error: ${e.message}` }] };
      }
    }
  );

  server.tool(
    'clawd_list_conversations',
    'List all conversations across all channels, sorted by most recent.',
    {},
    async () => {
      const convs = getConversations();
      if (!convs.length) return { content: [{ type: 'text', text: 'No conversations yet.' }] };
      return {
        content: [{
          type: 'text',
          text: convs.map(c =>
            `[${c.channel.toUpperCase()}] ${c.contactName} (${c.contactId})${c.unreadCount > 0 ? ` — ${c.unreadCount} unread` : ''}\n  Last: "${c.lastMessage}"`
          ).join('\n\n')
        }]
      };
    }
  );

  server.tool(
    'clawd_get_history',
    'Get message history for a specific conversation.',
    {
      channel:   z.enum(['whatsapp', 'telegram', 'webchat']),
      contactId: z.string(),
      limit:     z.number().optional().default(30),
    },
    async ({ channel, contactId, limit }) => {
      const msgs = getHistory(channel, contactId, limit);
      if (!msgs.length) return { content: [{ type: 'text', text: 'No messages found.' }] };
      return {
        content: [{
          type: 'text',
          text: msgs.map(m =>
            `${m.direction === 'inbound' ? `← ${m.contactName}` : '→ You'} [${new Date(m.timestamp).toLocaleTimeString()}]: ${m.content}`
          ).join('\n')
        }]
      };
    }
  );

  server.tool(
    'clawd_get_status',
    'Check connection status of all messaging channels.',
    {},
    async () => {
      try {
        const statuses = await adminGet('/status');
        return {
          content: [{
            type: 'text',
            text: statuses.map((s: any) =>
              `${s.channel.toUpperCase()}: ${s.connected ? '✓ Connected' : '✗ Disconnected'} — ${s.detail}`
            ).join('\n')
          }]
        };
      } catch {
        return { content: [{ type: 'text', text: adapters.map(a => { const s = a.getStatus(); return `${s.channel.toUpperCase()}: ${s.connected ? '✓' : '✗'} ${s.detail}`; }).join('\n') }] };
      }
    }
  );

  server.tool(
    'clawd_get_webchat_url',
    'Get the local URL for the browser WebChat interface.',
    {},
    async () => ({
      content: [{ type: 'text', text: `WebChat: ${webchat?.getUrl() ?? 'not running'}` }]
    })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('[CLAWD] MCP server ready — Claude Desktop tools active.\n');
}
