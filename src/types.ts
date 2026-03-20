export type Channel = 'whatsapp' | 'telegram' | 'webchat';
export type Direction = 'inbound' | 'outbound';

export interface Message {
  id: string;
  channel: Channel;
  contactId: string;
  contactName: string;
  content: string;
  timestamp: number;
  direction: Direction;
  read: boolean;
}

export interface Conversation {
  id: string;
  channel: Channel;
  contactId: string;
  contactName: string;
  lastMessage: string;
  lastTimestamp: number;
  unreadCount: number;
}

export interface ChannelStatus {
  channel: Channel;
  connected: boolean;
  detail: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export type ChannelAdapter = {
  name: Channel;
  connect(): Promise<void>;
  send(contactId: string, text: string): Promise<SendResult>;
  getStatus(): ChannelStatus;
  disconnect(): Promise<void>;
};
