import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// DynamoDB setup
const client = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'linq-blue-agent-example';

// TTL: 1 hour for conversations
const CONVERSATION_TTL_SECONDS = 60 * 60;

// Message with sender tracking for group chats
export interface StoredMessage {
  role: 'user' | 'assistant';
  content: string;
  handle?: string; // Who sent this message (for user messages in group chats)
}

interface ConversationRecord {
  pk: string;
  messages: StoredMessage[];
  lastActive: number;
  ttl: number;
}

export async function getConversation(chatId: string): Promise<StoredMessage[]> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `CHAT#${chatId}` },
    }));

    if (!result.Item) return [];

    const record = result.Item as ConversationRecord;
    return record.messages || [];
  } catch (error) {
    console.error('[conversation] Error getting conversation:', error);
    return [];
  }
}

export async function addMessage(chatId: string, role: 'user' | 'assistant', content: string, handle?: string): Promise<void> {
  try {
    // Get existing conversation
    const messages = await getConversation(chatId);

    // Add new message with optional sender handle
    const newMessage: StoredMessage = { role, content };
    if (handle) {
      newMessage.handle = handle;
    }
    messages.push(newMessage);

    // Keep only last 20 messages
    const trimmedMessages = messages.slice(-20);

    const now = Math.floor(Date.now() / 1000);

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `CHAT#${chatId}`,
        messages: trimmedMessages,
        lastActive: now,
        ttl: now + CONVERSATION_TTL_SECONDS,
      },
    }));
  } catch (error) {
    console.error('[conversation] Error adding message:', error);
  }
}

export async function clearConversation(chatId: string): Promise<void> {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: `CHAT#${chatId}` },
    }));
  } catch (error) {
    console.error('[conversation] Error clearing conversation:', error);
  }
}

// Not really needed with DynamoDB (TTL handles cleanup), but keep for compatibility
export async function clearAllConversations(): Promise<void> {
  console.log('[conversation] clearAllConversations not implemented for DynamoDB');
}

// ============================================================================
// User Profiles - persistent facts about people (no TTL, kept forever)
// ============================================================================

export interface UserProfile {
  handle: string;
  name: string | null;
  facts: string[];
  firstSeen: number;
  lastSeen: number;
}

export async function getUserProfile(handle: string): Promise<UserProfile | null> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `USER#${handle}` },
    }));

    if (!result.Item) return null;

    return {
      handle: result.Item.handle,
      name: result.Item.name || null,
      facts: result.Item.facts || [],
      firstSeen: result.Item.firstSeen,
      lastSeen: result.Item.lastSeen,
    };
  } catch (error) {
    console.error('[conversation] Error getting user profile:', error);
    return null;
  }
}

export async function updateUserProfile(
  handle: string,
  updates: { name?: string; facts?: string[] }
): Promise<void> {
  try {
    const existing = await getUserProfile(handle);
    const now = Math.floor(Date.now() / 1000);

    const profile = {
      pk: `USER#${handle}`,
      handle,
      name: updates.name ?? existing?.name ?? null,
      facts: updates.facts ?? existing?.facts ?? [],
      firstSeen: existing?.firstSeen ?? now,
      lastSeen: now,
      // No TTL - user profiles persist forever
    };

    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: profile,
    }));

    console.log(`[conversation] Updated profile for ${handle}: name=${profile.name}, facts=${profile.facts.length}`);
  } catch (error) {
    console.error('[conversation] Error updating user profile:', error);
  }
}

export async function addUserFact(handle: string, fact: string): Promise<boolean> {
  try {
    const existing = await getUserProfile(handle);
    const facts = existing?.facts ?? [];

    // Don't add duplicate facts
    if (!facts.includes(fact)) {
      facts.push(fact);
      await updateUserProfile(handle, { facts });
      console.log(`[conversation] Added fact for ${handle}: "${fact}"`);
      return true;
    }
    console.log(`[conversation] Fact for ${handle} already exists, skipping: "${fact}"`);
    return false;
  } catch (error) {
    console.error('[conversation] Error adding user fact:', error);
    return false;
  }
}

export async function setUserName(handle: string, name: string): Promise<boolean> {
  try {
    const existing = await getUserProfile(handle);
    // Skip if name is already the same
    if (existing?.name === name) {
      console.log(`[conversation] Name for ${handle} already "${name}", skipping`);
      return false;
    }
    await updateUserProfile(handle, { name });
    console.log(`[conversation] Set name for ${handle}: "${name}"`);
    return true;
  } catch (error) {
    console.error('[conversation] Error setting user name:', error);
    return false;
  }
}

export async function clearUserProfile(handle: string): Promise<boolean> {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: `USER#${handle}` },
    }));
    console.log(`[conversation] Cleared profile for ${handle}`);
    return true;
  } catch (error) {
    console.error('[conversation] Error clearing user profile:', error);
    return false;
  }
}
