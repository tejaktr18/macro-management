// Storage adapters. The app syncs plain key/value records (same keys the
// frontend keeps in localStorage: log-YYYY-MM-DD, weigh-..., meals-..., shop).
//
// DynamoDB layout (single table):
//   PK = "U#<userId>"   SK = "KV#<key>"   value = JSON string   updatedAt = epoch ms
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand,
  QueryCommand, BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';

const MAX_KEY = 200;
const MAX_VALUE = 350_000; // DynamoDB item limit is 400 KB

export function validKey(k) {
  return typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY && /^[A-Za-z0-9._:-]+$/.test(k);
}
export function validValue(v) {
  return typeof v === 'string' && v.length <= MAX_VALUE;
}

/* ---------------- in-memory (local dev + tests) ---------------- */
export function memoryStore() {
  const m = new Map(); // `${user}|${key}` -> {key, value, updatedAt}
  const id = (u, k) => `${u}|${k}`;
  return {
    kind: 'memory',
    async get(user, key) { return m.get(id(user, key)) || null; },
    async put(user, key, value, updatedAt) {
      const cur = m.get(id(user, key));
      if (cur && cur.updatedAt > updatedAt) return { applied: false, current: cur };
      const rec = { key, value, updatedAt };
      m.set(id(user, key), rec);
      return { applied: true, current: rec };
    },
    async del(user, key) { m.delete(id(user, key)); },
    async list(user, { prefix = '', since = 0 } = {}) {
      return [...m.entries()]
        .filter(([k, r]) => k.startsWith(user + '|') && r.key.startsWith(prefix) && r.updatedAt > since)
        .map(([, r]) => r)
        .sort((a, b) => a.key.localeCompare(b.key));
    },
    async putMany(user, records) {
      for (const r of records) await this.put(user, r.key, r.value, r.updatedAt);
      return records.length;
    },
  };
}

/* ---------------- DynamoDB ---------------- */
export function dynamoStore({ tableName, region }) {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const pk = (u) => `U#${u}`;
  const sk = (k) => `KV#${k}`;
  const toRec = (it) => ({ key: it.SK.slice(3), value: it.value, updatedAt: Number(it.updatedAt) });

  return {
    kind: 'dynamodb',
    async get(user, key) {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: { PK: pk(user), SK: sk(key) } }));
      return r.Item ? toRec(r.Item) : null;
    },
    // Last-writer-wins on updatedAt, enforced server-side with a condition.
    async put(user, key, value, updatedAt) {
      try {
        await doc.send(new PutCommand({
          TableName: tableName,
          Item: { PK: pk(user), SK: sk(key), value, updatedAt },
          ConditionExpression: 'attribute_not_exists(SK) OR updatedAt <= :u',
          ExpressionAttributeValues: { ':u': updatedAt },
        }));
        return { applied: true, current: { key, value, updatedAt } };
      } catch (e) {
        if (e.name === 'ConditionalCheckFailedException') {
          return { applied: false, current: await this.get(user, key) };
        }
        throw e;
      }
    },
    async del(user, key) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { PK: pk(user), SK: sk(key) } }));
    },
    async list(user, { prefix = '', since = 0 } = {}) {
      const out = [];
      let ExclusiveStartKey;
      do {
        const r = await doc.send(new QueryCommand({
          TableName: tableName,
          KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)',
          FilterExpression: since ? 'updatedAt > :since' : undefined,
          ExpressionAttributeValues: { ':p': pk(user), ':s': sk(prefix), ...(since ? { ':since': since } : {}) },
          ExclusiveStartKey,
        }));
        (r.Items || []).forEach((it) => out.push(toRec(it)));
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return out;
    },
    // Used by /api/import (account migration). Overwrites unconditionally.
    async putMany(user, records) {
      let n = 0;
      for (let i = 0; i < records.length; i += 25) {
        let items = records.slice(i, i + 25).map((r) => ({
          PutRequest: { Item: { PK: pk(user), SK: sk(r.key), value: r.value, updatedAt: r.updatedAt } },
        }));
        for (let attempt = 0; items.length && attempt < 6; attempt++) {
          const res = await doc.send(new BatchWriteCommand({ RequestItems: { [tableName]: items } }));
          const left = res.UnprocessedItems?.[tableName] || [];
          n += items.length - left.length;
          items = left;
          if (items.length) await new Promise((s) => setTimeout(s, 100 * 2 ** attempt));
        }
        if (items.length) throw new Error(`import: ${items.length} items left unprocessed`);
      }
      return n;
    },
  };
}
