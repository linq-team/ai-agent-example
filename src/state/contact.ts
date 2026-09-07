import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const TableName = process.env.DYNAMODB_TABLE_NAME || 'linq-blue-agent-example';
const key = (bot: string, person: string) => ({ pk: `CONTACTSHARE#${bot}#USER#${person}` });

export type ContactShareStatus = 'shared' | 'not_shared' | 'unknown';

export async function getContactShareStatus(bot: string, person: string): Promise<ContactShareStatus> {
  try {
    const data = await client.send(new GetCommand({ TableName, Key: key(bot, person), ConsistentRead: true }));
    return data.Item?.sharedAt ? 'shared' : 'not_shared';
  } catch {
    console.error('[contact] Could not read share history; suppressing proactive sharing');
    return 'unknown';
  }
}

// A short lease prevents different app instances from introducing the contact
// simultaneously. The completed record has no TTL and survives /clear/restarts.
export async function claimContactShare(bot: string, person: string, requestId: string, owner: string, requested: boolean): Promise<boolean> {
  const now = Date.now();
  try {
    await client.send(new UpdateCommand({
      TableName, Key: key(bot, person),
      UpdateExpression: 'SET leaseOwner = :owner, leaseUntil = :until',
      ConditionExpression: '(attribute_not_exists(leaseUntil) OR leaseUntil < :now) AND (attribute_not_exists(lastRequestId) OR lastRequestId <> :request)' +
        (requested ? '' : ' AND attribute_not_exists(sharedAt)'),
      ExpressionAttributeValues: { ':owner': owner, ':until': now + 120_000, ':now': now, ':request': requestId },
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
}

export async function completeContactShare(bot: string, person: string, requestId: string, owner: string, service: string, messageId: string): Promise<void> {
  await client.send(new UpdateCommand({
    TableName, Key: key(bot, person),
    UpdateExpression: 'SET sharedAt = if_not_exists(sharedAt, :now), lastSharedAt = :now, lastRequestId = :request, lastService = :service, lastMessageId = :message REMOVE leaseOwner, leaseUntil',
    ConditionExpression: 'leaseOwner = :owner',
    ExpressionAttributeValues: { ':now': Date.now(), ':request': requestId, ':service': service, ':message': messageId, ':owner': owner },
  }));
}

export async function releaseContactShare(bot: string, person: string, owner: string): Promise<void> {
  await client.send(new UpdateCommand({
    TableName, Key: key(bot, person), UpdateExpression: 'REMOVE leaseOwner, leaseUntil',
    ConditionExpression: 'leaseOwner = :owner', ExpressionAttributeValues: { ':owner': owner },
  }));
}
