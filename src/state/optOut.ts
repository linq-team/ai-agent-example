import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({ region: 'us-east-1' });
const docClient = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME || 'linq-blue-agent-example';

const PENDING_TTL_SECONDS = 24 * 60 * 60;

// Standard SMS keyword set — Linq fires `message.opt_out` for these too, so
// we use this list to skip Claude inference and let the webhook drive state.
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

export type OptOutSource = 'webhook' | 'soft_intent';
export type OptStatus = 'pending' | 'opted_out';

export interface OptRecord {
  status: OptStatus;
  source?: OptOutSource;
  createdAt: number;
  ttl?: number;
}

export function isOptOutKeyword(text: string): boolean {
  return OPT_OUT_KEYWORDS.has(text.trim().toLowerCase());
}

export async function getOptStatus(handle: string): Promise<OptRecord | null> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: { pk: `OPT#${handle}` },
    }));
    if (!result.Item) return null;
    return {
      status: result.Item.status,
      source: result.Item.source,
      createdAt: result.Item.createdAt,
      ttl: result.Item.ttl,
    };
  } catch (error) {
    console.error('[optOut] Error getting opt status:', error);
    return null;
  }
}

// Returns true if a new pending record was created, false if one already existed
// (idempotent — first writer wins).
export async function setPending(handle: string, source: OptOutSource): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await docClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `OPT#${handle}`,
        status: 'pending',
        source,
        createdAt: now,
        ttl: now + PENDING_TTL_SECONDS,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    console.log(`[optOut] Pending set for ${handle} (source=${source})`);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'name' in error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    console.error('[optOut] Error setting pending:', error);
    return false;
  }
}

export async function confirmOptOut(handle: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await docClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { pk: `OPT#${handle}` },
      UpdateExpression: 'SET #s = :s, createdAt = :n REMOVE #t',
      ExpressionAttributeNames: { '#s': 'status', '#t': 'ttl' },
      ExpressionAttributeValues: { ':s': 'opted_out', ':n': now },
    }));
    console.log(`[optOut] Confirmed opt-out for ${handle}`);
  } catch (error) {
    console.error('[optOut] Error confirming opt-out:', error);
  }
}

export async function clearOpt(handle: string): Promise<void> {
  try {
    await docClient.send(new DeleteCommand({
      TableName: TABLE_NAME,
      Key: { pk: `OPT#${handle}` },
    }));
    console.log(`[optOut] Cleared opt record for ${handle}`);
  } catch (error) {
    console.error('[optOut] Error clearing opt:', error);
  }
}
