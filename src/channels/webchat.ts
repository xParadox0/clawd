import express from 'express';
import { createServer } from 'http';
import { Server as IOServer, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { insertMessage, getHistory } from '../store/db.js';
import type { ChannelAdapter, ChannelStatus, SendResult } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
type Session = { socket: Socket; sessionId: string; name: string };

export class WebChatChannel implements ChannelAdapter {
  name = 'webchat' as const;
  private httpServer: ReturnType<typeof createServer> | null = null;
  private io: IOServer | null = null;
  private sessions = new Map<string, Session>();
  private status: ChannelStatus = { channel: 'webchat', connected: false, detail: 'Not started' };

  constructor(private port = 18790) {}

  async connect(): Promise<void> {
    const app = express();
    this.httpServer = createServer(app);
    this.io = new IOServer(this.httpServer, { cors: { origin: '*' } });

    // Serve webchat static files from webchat/ folder (two levels up from dist/channels/)
    const webDir = join(__dirname, '..', '..', 'webchat');
    app.use(express.static(webDir));

    this.io.on('connection', (socket: Socket) => {
      const sessionId = randomUUID();
      const name = (socket.handshake.query.name as string) || 'User';
      this.sessions.set(sessionId, { socket, sessionId, name });

      // Send history for this session
      socket.emit('history', getHistory('webchat', sessionId));

      socket.on('message', (text: string) => {
        if (typeof text !== 'string' || !text.trim()) return;
        insertMessage({
          id: randomUUID(), channel: 'webchat',
          contactId: sessionId, contactName: name,
          content: text.trim(), timestamp: Date.now(),
          direction: 'inbound', read: false,
        });
        socket.emit('ack', { ok: true });
        process.stderr.write(`[CLAWD] WebChat message from ${name}: ${text.trim()}\n`);
      });

      socket.on('disconnect', () => this.sessions.delete(sessionId));
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, () => {
        this.status = { channel: 'webchat', connected: true, detail: `http://localhost:${this.port}` };
        process.stderr.write(`[CLAWD] WebChat running at http://localhost:${this.port}\n`);
        resolve();
      });
    });
  }

  async send(contactId: string, text: string): Promise<SendResult> {
    const id = randomUUID();
    insertMessage({
      id, channel: 'webchat', contactId, contactName: 'Clawd',
      content: text, timestamp: Date.now(), direction: 'outbound', read: true,
    });
    this.sessions.get(contactId)?.socket.emit('bot_message', { content: text, timestamp: Date.now() });
    return { ok: true, messageId: id };
  }

  getStatus(): ChannelStatus { return this.status; }
  getUrl(): string { return this.status.detail; }

  async disconnect(): Promise<void> {
    this.io?.close();
    this.httpServer?.close();
    this.status = { channel: 'webchat', connected: false, detail: 'Disconnected' };
  }
}
