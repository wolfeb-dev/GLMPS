import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from '../shims/better-sqlite3.js';
import { v4 } from '../shims/uuid.js';
import axios from '../shims/axios.js';
import OpenAI, { setChatCompletion, AzureOpenAI } from '../shims/openai.js';

test('better-sqlite3 shim over node:sqlite: prepare/run/get/all/exec/transaction', () => {
  const db = new Database(':memory:');
  db.exec('create table t (id text primary key, v text)');
  db.prepare('insert into t values (?, ?)').run('a', '1');
  assert.deepEqual({ ...db.prepare('select v from t where id = ?').get('a') }, { v: '1' });
  db.transaction((id) => db.prepare('insert into t values (?, ?)').run(id, '2'))('b');
  assert.equal(db.prepare('select * from t').all().length, 2);
  db.close();
});

test('uuid shim returns a v4 uuid', () => {
  assert.match(v4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('axios shim refuses every request', async () => {
  await assert.rejects(axios.post('https://us.i.posthog.com/capture', {}), /network access is disabled/);
  await assert.rejects(axios({ url: 'http://127.0.0.1' }), /network access is disabled/);
});

test('openai shim routes chat.completions.create to the host; embeddings are refused', async () => {
  setChatCompletion(async (body) => ({ choices: [{ message: { role: 'assistant', content: body.messages[0].content } }] }));
  const c = new OpenAI({ apiKey: 'x', baseURL: 'ignored' });
  assert.equal((await c.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'echo' }] })).choices[0].message.content, 'echo');
  await assert.rejects(c.embeddings.create({ input: 'x' }), /embeddings are not available/);
});

test('openai shim exports a throwing AzureOpenAI stub, needed only so the bundle links', () => {
  assert.throws(() => new AzureOpenAI(), /azure openai is not available/);
});
