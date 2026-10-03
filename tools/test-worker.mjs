// Checks the Worker's rate limiting without Cloudflare: the env bindings are
// replaced by small fakes. Run with `node tools/test-worker.mjs`.
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

const ORIGIN = 'https://bobhuang1.github.io';

function request(ip = '203.0.113.7') {
  return new Request('https://zhou-dream-ai.example.workers.dev/interpret', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ question: 'I dreamt of a river', lang: 'en', passages: [] }),
  });
}

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
  };
}

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

// No GEMINI_API_KEY in these envs, so a request that passes the limiter ends
// in the 500 "not configured" response instead of calling Google.

await test('a KV write failure does not take the Worker down', async () => {
  const kv = memoryKv();
  kv.put = async () => { throw new Error('KV put() limit exceeded for the day'); };
  const res = await worker.fetch(request(), { RATE_LIMITER: kv, RATE_SALT: 'salt' });
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /not configured/);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

await test('the edge rate-limit binding returns 429 with Retry-After', async () => {
  const binding = { limit: async () => ({ success: false }) };
  const res = await worker.fetch(request(), { AI_RATE_LIMIT: binding, RATE_LIMITER: memoryKv(), RATE_SALT: 'salt' });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '60');
});

await test('the KV hourly window still limits to 10 per IP', async () => {
  const env = { RATE_LIMITER: memoryKv(), RATE_SALT: 'salt' };
  for (let i = 0; i < 10; i++) {
    assert.equal((await worker.fetch(request(), env)).status, 500);
  }
  assert.equal((await worker.fetch(request(), env)).status, 429);
});

await test('a missing RATE_SALT refuses to serve', async () => {
  const kv = memoryKv();
  const res = await worker.fetch(request(), { RATE_LIMITER: kv });
  assert.equal(res.status, 500);
  assert.equal(kv.store.size, 0);
});

if (failures > 0) {
  console.log(`\n${failures} worker test(s) failed`);
  process.exit(1);
}
console.log('\nworker tests passed');
