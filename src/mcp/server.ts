import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getPendingMessages, getConversations, getHistory } from '../store/db.js';
import type { ChannelAdapter } from '../types.js';
import type { WebChatChannel } from '../channels/webchat.js';

export async function startMcpServer(adapters: ChannelAdapter[]): Promise<void> {
  const server = new McpServer({ name: 'clawd', version: '1.0.0' });
  const adapterMap = new Map(adapters.map(a => [a.name, a]));
  const webchat = adapterMap.get('webchat') as WebChatChannel | undefined;

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
      const adapter = adapterMap.get(channel);
      if (!adapter) return { content: [{ type: 'text', text: `Channel "${channel}" not enabled.` }] };
      const r = await adapter.send(contactId, message);
      return { content: [{ type: 'text', text: r.ok ? `✓ Sent on ${channel} to ${contactId}` : `✗ Failed: ${r.error}` }] };
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
    async () => ({
      content: [{
        type: 'text',
        text: adapters.map(a => {
          const s = a.getStatus();
          return `${s.channel.toUpperCase()}: ${s.connected ? '✓ Connected' : '✗ Disconnected'} — ${s.detail}`;
        }).join('\n')
      }]
    })
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
