import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'linq-blue-agent-example';

const TIMEZONE = process.env.USAGE_TIMEZONE || 'America/Los_Angeles';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const USAGE_LIMITS = {
  messagesPerSender: envInt('DAILY_MESSAGE_LIMIT_PER_SENDER', 25),
  messagesPerChat: envInt('DAILY_MESSAGE_LIMIT_PER_CHAT', 50),
  messagesGlobal: envInt('DAILY_MESSAGE_LIMIT_GLOBAL', 500),
  imagesPerSender: envInt('DAILY_IMAGE_LIMIT_PER_SENDER', 3),
  imagesGlobal: envInt('DAILY_IMAGE_LIMIT_GLOBAL', 30),
  rateLimitMessages: envInt('RATE_LIMIT_MESSAGES', 8),
  rateLimitWindowSeconds: envInt('RATE_LIMIT_WINDOW_SECONDS', 600),
};

const UNLIMITED_SENDERS = new Set(
  (process.env.UNLIMITED_SENDERS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
);

const recentHits = new Map<string, number[]>();
const rateLimitNotifiedUntil = new Map<string, number>();

export type QuotaDenialReason = 'rate' | 'user' | 'chat' | 'global';

export type QuotaResult =
  | { allowed: true }
  | { allowed: false; reason: QuotaDenialReason; notify: boolean; message: string };

function todayKey(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function ttlUnix(): number {
  return Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 3;
}

function isUnlimited(handle: string): boolean {
  return UNLIMITED_SENDERS.has(handle);
}

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

function userPk(handle: string): string {
  return `USAGE#${todayKey()}#USER#${handle}`;
}

function globalPk(): string {
  return `USAGE#${todayKey()}#GLOBAL`;
}

function chatPk(chatId: string): string {
  return `USAGE#${todayKey()}#CHAT#${chatId}`;
}

/**
 * Increment an attribute if it is still under the cap.
 * limit <= 0 disables the cap but still records usage.
 * Fails open if DynamoDB errors so a storage blip doesn't kill the bot.
 */
async function incrementWithCap(
  pk: string,
  attr: 'messages' | 'images',
  limit: number
): Promise<{ allowed: boolean; count: number }> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = ttlUnix();

  try {
    if (limit <= 0) {
      const result = await docClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk },
        UpdateExpression: 'ADD #attr :one SET #ttl = if_not_exists(#ttl, :ttl), lastActive = :now',
        ExpressionAttributeNames: { '#attr': attr, '#ttl': 'ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': ttl, ':now': now },
        ReturnValues: 'ALL_NEW',
      }));
      return { allowed: true, count: (result.Attributes?.[attr] as number) ?? 1 };
    }

    const result = await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk },
      UpdateExpression: 'ADD #attr :one SET #ttl = if_not_exists(#ttl, :ttl), lastActive = :now',
      ConditionExpression: 'attribute_not_exists(#attr) OR #attr < :limit',
      ExpressionAttributeNames: { '#attr': attr, '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':one': 1,
        ':limit': limit,
        ':ttl': ttl,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    }));
    return { allowed: true, count: (result.Attributes?.[attr] as number) ?? 1 };
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return { allowed: false, count: limit };
    }
    console.error('[usage] increment error:', error);
    return { allowed: true, count: 0 };
  }
}

type NotifyFlag = 'userNotified' | 'chatNotified' | 'globalNotified' | 'imageUserNotified' | 'imageGlobalNotified';

async function claimNotification(pk: string, flag: NotifyFlag): Promise<boolean> {
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk },
      UpdateExpression: 'SET #flag = :true, #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#flag)',
      ExpressionAttributeNames: { '#flag': flag, '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':true': true, ':ttl': ttlUnix() },
    }));
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return false;
    }
    console.error('[usage] notify flag error:', error);
    return true;
  }
}

function checkRateLimit(handle: string): { allowed: boolean; notify: boolean } {
  const { rateLimitMessages, rateLimitWindowSeconds } = USAGE_LIMITS;
  if (rateLimitMessages <= 0) return { allowed: true, notify: false };

  const now = Date.now();
  const windowMs = rateLimitWindowSeconds * 1000;
  const timestamps = (recentHits.get(handle) || []).filter(t => now - t < windowMs);

  if (timestamps.length >= rateLimitMessages) {
    recentHits.set(handle, timestamps);
    const notifiedUntil = rateLimitNotifiedUntil.get(handle) ?? 0;
    const notify = now >= notifiedUntil;
    if (notify) {
      rateLimitNotifiedUntil.set(handle, now + windowMs);
    }
    return { allowed: false, notify };
  }

  timestamps.push(now);
  recentHits.set(handle, timestamps);
  return { allowed: true, notify: false };
}

const USER_MESSAGE_LIMIT_TEXT =
  "yo ive hit my daily limit with u - this is just a linq demo bot, not a full-time ai. try again tomorrow or hop on claude.ai for the real thing";
const CHAT_MESSAGE_LIMIT_TEXT =
  "this chat hit my daily demo limit - im just a linq demo bot so i gotta cap it here. resets tomorrow!";
const GLOBAL_MESSAGE_LIMIT_TEXT =
  "this demo is at capacity for today, check back tomorrow. for actual ai stuff claude.ai is the move";
const RATE_LIMIT_TEXT =
  "woah easy 😅 im a demo bot so i gotta pace myself. try again in a few";
const USER_IMAGE_LIMIT_TEXT =
  "i can only make a couple images a day on this demo, try again tomorrow";
const GLOBAL_IMAGE_LIMIT_TEXT =
  "hit the demo's image cap for today, try again tomorrow";

export async function consumeMessageQuota(handle: string, chatId: string): Promise<QuotaResult> {
  if (isUnlimited(handle)) {
    return { allowed: true };
  }

  const rate = checkRateLimit(handle);
  if (!rate.allowed) {
    console.log(`[usage] ${handle} rate limited`);
    return {
      allowed: false,
      reason: 'rate',
      notify: rate.notify,
      message: RATE_LIMIT_TEXT,
    };
  }

  // Chat cap first so a capped group chat doesn't burn each member's own DM quota
  const chatQuota = await incrementWithCap(chatPk(chatId), 'messages', USAGE_LIMITS.messagesPerChat);
  if (!chatQuota.allowed) {
    const notify = await claimNotification(chatPk(chatId), 'chatNotified');
    console.log(`[usage] chat ${chatId} hit daily message limit (${USAGE_LIMITS.messagesPerChat})`);
    return {
      allowed: false,
      reason: 'chat',
      notify,
      message: CHAT_MESSAGE_LIMIT_TEXT,
    };
  }

  const user = await incrementWithCap(userPk(handle), 'messages', USAGE_LIMITS.messagesPerSender);
  if (!user.allowed) {
    const notify = await claimNotification(userPk(handle), 'userNotified');
    console.log(`[usage] ${handle} hit daily message limit (${USAGE_LIMITS.messagesPerSender})`);
    return {
      allowed: false,
      reason: 'user',
      notify,
      message: USER_MESSAGE_LIMIT_TEXT,
    };
  }

  const global = await incrementWithCap(globalPk(), 'messages', USAGE_LIMITS.messagesGlobal);
  if (!global.allowed) {
    const notify = await claimNotification(userPk(handle), 'globalNotified');
    console.log(`[usage] ${handle} blocked by global message limit (${USAGE_LIMITS.messagesGlobal})`);
    return {
      allowed: false,
      reason: 'global',
      notify,
      message: GLOBAL_MESSAGE_LIMIT_TEXT,
    };
  }

  console.log(`[usage] ${handle} message ${user.count}/${USAGE_LIMITS.messagesPerSender || '∞'} (chat ${chatQuota.count}/${USAGE_LIMITS.messagesPerChat || '∞'}, global ${global.count}/${USAGE_LIMITS.messagesGlobal || '∞'})`);
  return { allowed: true };
}

export async function consumeImageQuota(handle: string): Promise<QuotaResult> {
  if (isUnlimited(handle)) {
    return { allowed: true };
  }

  const user = await incrementWithCap(userPk(handle), 'images', USAGE_LIMITS.imagesPerSender);
  if (!user.allowed) {
    const notify = await claimNotification(userPk(handle), 'imageUserNotified');
    console.log(`[usage] ${handle} hit daily image limit (${USAGE_LIMITS.imagesPerSender})`);
    return {
      allowed: false,
      reason: 'user',
      notify,
      message: USER_IMAGE_LIMIT_TEXT,
    };
  }

  const global = await incrementWithCap(globalPk(), 'images', USAGE_LIMITS.imagesGlobal);
  if (!global.allowed) {
    const notify = await claimNotification(userPk(handle), 'imageGlobalNotified');
    console.log(`[usage] ${handle} blocked by global image limit (${USAGE_LIMITS.imagesGlobal})`);
    return {
      allowed: false,
      reason: 'global',
      notify,
      message: GLOBAL_IMAGE_LIMIT_TEXT,
    };
  }

  console.log(`[usage] ${handle} image ${user.count}/${USAGE_LIMITS.imagesPerSender || '∞'} (global ${global.count}/${USAGE_LIMITS.imagesGlobal || '∞'})`);
  return { allowed: true };
}

export function logUsageConfig(): void {
  const unlimited = UNLIMITED_SENDERS.size > 0
    ? [...UNLIMITED_SENDERS].join(', ')
    : '(none)';
  console.log(`[usage] limits: ${USAGE_LIMITS.messagesPerSender}/sender/day, ${USAGE_LIMITS.messagesPerChat}/chat/day, ${USAGE_LIMITS.messagesGlobal} global/day, ${USAGE_LIMITS.imagesPerSender} images/sender/day, ${USAGE_LIMITS.imagesGlobal} images global/day, ${USAGE_LIMITS.rateLimitMessages} msgs / ${USAGE_LIMITS.rateLimitWindowSeconds}s`);
  console.log(`[usage] unlimited senders: ${unlimited}`);
  console.log(`[usage] daily reset timezone: ${TIMEZONE}`);
}
