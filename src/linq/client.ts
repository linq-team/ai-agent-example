// Linq Blue V3 API Client
// Ref: https://apidocs.linqapp.com/models

const BASE_URL = process.env.LINQ_API_BASE_URL || 'https://api.linqapp.com/api/partner/v3';
const API_TOKEN = process.env.LINQ_API_TOKEN;

// Truncate error messages (especially HTML error pages)
function truncateError(text: string, maxLen = 100): string {
  if (text.includes('<!DOCTYPE') || text.includes('<html')) {
    return '[HTML error page - likely Linq backend issue]';
  }
  return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
}

// Chat info cache
const chatInfoCache = new Map<string, ChatInfo>();

export interface ChatHandle {
  handle: string;
  service: string;
}

export interface ChatInfo {
  id: string;
  display_name: string | null;
  handles: ChatHandle[];
  is_group: boolean;
  service: string;
}

export async function getChat(chatId: string): Promise<ChatInfo> {
  // Check cache first
  const cached = chatInfoCache.get(chatId);
  if (cached) {
    return cached;
  }

  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}`;

  console.log(`[linq] Fetching chat info for ${chatId}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as ChatInfo;

  // Cache it
  chatInfoCache.set(chatId, data);
  console.log(`[linq] Chat info cached: ${data.handles.length} participants, is_group=${data.is_group}`);

  return data;
}

export type ScreenEffect = 'confetti' | 'fireworks' | 'lasers' | 'sparkles' | 'celebration' | 'hearts' | 'love' | 'balloons' | 'happy_birthday' | 'echo' | 'spotlight';
export type BubbleEffect = 'slam' | 'loud' | 'gentle' | 'invisible_ink';
export type MessageEffect = { type: 'screen' | 'bubble'; name: string };
export type ReplyTo = { message_id: string; part_index?: number };

export interface SendMessageResponse {
  chat_id: string;
  message: {
    id: string;
    parts: Array<{ type: string; value?: string }>;
    sent_at: string;
    delivery_status: 'pending' | 'queued' | 'sent' | 'delivered' | 'failed';
    is_read: boolean;
  };
}

export interface MediaAttachment {
  url: string;
}

export async function sendMessage(chatId: string, text: string, effect?: MessageEffect, replyTo?: ReplyTo, media?: MediaAttachment[]): Promise<SendMessageResponse> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/messages`;

  const extras: string[] = [];
  if (effect) extras.push('effect');
  if (replyTo) extras.push('reply');
  if (media?.length) extras.push(`${media.length} image(s)`);
  console.log(`[linq] Sending message to chat ${chatId}${extras.length ? ` with ${extras.join(', ')}` : ''}`);

  // Build message parts: text first, then any media
  const parts: Array<{ type: string; value?: string; url?: string }> = [];

  if (text) {
    parts.push({ type: 'text', value: text });
  }

  if (media) {
    for (const m of media) {
      parts.push({ type: 'media', url: m.url });
    }
  }

  const message: Record<string, unknown> = { parts };

  if (effect) {
    message.effect = effect;
  }

  if (replyTo) {
    message.reply_to = replyTo;
    console.log(`[linq] Replying to message: ${replyTo.message_id.slice(0, 8)}...`);
  }

  const body = { message };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as SendMessageResponse;
  console.log(`[linq] Message sent: ${data.message.id}`);

  return data;
}

export async function renameGroupChat(chatId: string, displayName: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}`;

  console.log(`[linq] Renaming chat ${chatId} to "${displayName}"`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      display_name: displayName,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[linq] Chat renamed to "${displayName}"`);
}

export async function setGroupChatIcon(chatId: string, iconUrl: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}`;

  console.log(`[linq] Setting chat ${chatId} icon to ${iconUrl.substring(0, 50)}...`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      group_chat_icon: iconUrl,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[linq] Chat icon updated`);
}

export async function shareContactCard(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/share_contact_card`;

  console.log(`[linq] Sharing contact card with chat ${chatId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[linq] Contact card shared`);
}

export async function markAsRead(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/read`;

  console.log(`[linq] Marking chat ${chatId} as read`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[linq] Chat marked as read`);
}

export async function startTyping(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/typing`;

  console.log(`[linq] Starting typing indicator for chat ${chatId}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[linq] Typing indicator started`);
}

export async function stopTyping(chatId: string): Promise<void> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/chats/${chatId}/typing`;

  console.log(`[linq] Stopping typing indicator for chat ${chatId}`);

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  console.log(`[linq] Typing indicator stopped`);
}

export type StandardReactionType = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';
export type ReactionType = StandardReactionType | 'custom';

export type Reaction = {
  type: StandardReactionType;
} | {
  type: 'custom';
  emoji: string;
};

export interface SendReactionResponse {
  is_me: boolean;
  handle: string;
  type: ReactionType;
}

export async function sendReaction(
  messageId: string,
  reaction: Reaction,
  operation: 'add' | 'remove' = 'add'
): Promise<SendReactionResponse> {
  if (!API_TOKEN) {
    throw new Error('LINQ_API_TOKEN not configured');
  }

  const url = `${BASE_URL}/messages/${messageId}/reactions`;

  const isCustom = reaction.type === 'custom';
  const displayName = isCustom ? (reaction as { type: 'custom'; emoji: string }).emoji : reaction.type;
  console.log(`[linq] Sending ${displayName} reaction to message ${messageId}`);

  const body: Record<string, string> = {
    operation,
    type: reaction.type,
  };

  if (isCustom) {
    body.custom_emoji = (reaction as { type: 'custom'; emoji: string }).emoji;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[linq] API error ${response.status}: ${truncateError(errorText)}`);
    throw new Error(`Linq API error: ${response.status} ${truncateError(errorText)}`);
  }

  const data = await response.json() as SendReactionResponse;
  console.log(`[linq] Reaction sent: ${displayName}`);

  return data;
}
