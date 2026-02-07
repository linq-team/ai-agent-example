// Linq Blue V3 Webhook Types
// Ref: https://apidocs.linqapp.com/webhook-events

export interface WebhookEvent {
  api_version: 'v3';
  event_id: string;
  created_at: string;
  trace_id: string;
  partner_id: string;
  event_type: string;
  data: unknown;
}

export interface MessageReceivedEvent extends WebhookEvent {
  event_type: 'message.received';
  data: MessageReceivedData;
}

export interface MessageReceivedData {
  chat_id: string;
  from: string;
  recipient_phone: string;
  received_at: string;
  is_from_me: boolean;
  service: 'iMessage' | 'SMS' | 'RCS';
  message: IncomingMessage;
}

export interface IncomingMessage {
  id: string;
  parts: MessagePart[];
  effect?: MessageEffect;
  reply_to?: ReplyTo;
}

export interface TextPart {
  type: 'text';
  value: string;
}

export interface MediaPart {
  type: 'media';
  url?: string;
  attachment_id?: string;
  filename?: string;
  mime_type?: string;
  size?: number;
}

export type MessagePart = TextPart | MediaPart;

export interface MessageEffect {
  type: 'screen' | 'bubble';
  name: string;
}

export interface ReplyTo {
  message_id: string;
  part_index?: number;
}

export function isMessageReceivedEvent(event: WebhookEvent): event is MessageReceivedEvent {
  return event.event_type === 'message.received';
}

export function extractTextContent(parts: MessagePart[]): string {
  return parts
    .filter((part): part is TextPart => part.type === 'text')
    .map(part => part.value)
    .join('\n');
}

export interface ExtractedMedia {
  url: string;
  mimeType: string;
}

export function extractImageUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('image/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type! }));
}

export function extractAudioUrls(parts: MessagePart[]): ExtractedMedia[] {
  return parts
    .filter((part): part is MediaPart =>
      part.type === 'media' &&
      !!part.url &&
      !!part.mime_type &&
      part.mime_type.startsWith('audio/')
    )
    .map(part => ({ url: part.url!, mimeType: part.mime_type! }));
}
