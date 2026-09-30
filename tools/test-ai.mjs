/**
 * Browser-side tests for the AI layer.
 *
 * There is no API key in CI, so Gemini itself is stubbed: fetch is replaced with
 * a fake that returns canned responses. What is actually under test is the code
 * around the model -- prompt construction, JSON extraction, error mapping, and
 * the retry policy -- because that is the part we wrote and can break.
 *
 * The canned 200 response mirrors the real generateContent envelope.
 *
 * Usage: node tools/test-ai.mjs
 */
import assert from 'node:assert/strict';
import { AiError, interpret, testKey, loadKey, saveKey } from '../assets/ai.js';

/** Minimal localStorage so the key helpers work outside a browser. */
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null; },
  setItem(k, v) { this.store.set(k, String(v)); },
  removeItem(k) { this.store.delete(k); },
};

const OK_BODY = {
  candidates: [{
    content: { parts: [{ text: JSON.stringify({
      summary: 'The book reads this as a sign of good fortune coming through family.',
      points: ['Snake in the house points to a son.', 'A red-black snake warns of gossip.'],
      caveat: 'This is a classical folk text, not a prediction.',
    }) }] },
    finishReason: 'STOP',
  }],
};

let lastRequest = null;

function stubFetch(handler) {
  globalThis.fetch = async (url, init) => {
    lastRequest = { url, init, body: JSON.parse(init.body) };
    return handler(url, init);
  };
}

function json200(payload) {
  return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
}

function httpError(status, text) {
  return { ok: false, status, json: async () => ({}), text: async () => text };
}

const passages = [{
  zhHant: '蛇入懷中生貴子',
  zhHans: '蛇怀中生贵子',
  sectionTitle: '龍蛇禽獸等類',
  literal: 'A snake in the bosom means a noble son.',
}];

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

console.log('ai layer:');

await test('a well-formed reply parses into summary/points/caveat', async () => {
  stubFetch(() => json200(OK_BODY));
  const reading = await interpret({ question: 'I saw a snake', lang: 'en', passages, apiKey: 'k' });
  assert.match(reading.summary, /good fortune/);
  assert.equal(reading.points.length, 2);
  assert.match(reading.caveat, /not a prediction/);
});

await test('the request names the model and the reader\'s language', async () => {
  stubFetch(() => json200(OK_BODY));
  await interpret({ question: 'Soñé de una serpiente', lang: 'es', passages, apiKey: 'k' });
  assert.match(lastRequest.url, /gemini-2\.5-flash:generateContent$/);
  assert.equal(lastRequest.init.headers['x-goog-api-key'], 'k');
  const text = lastRequest.body.contents[0].parts[0].text;
  assert.match(text, /Spanish/);
  assert.match(text, /Soñé de una serpiente/);
  assert.match(text, /蛇入懷中生貴子/);
});

await test('the system prompt forbids prediction and advice', async () => {
  stubFetch(() => json200(OK_BODY));
  await interpret({ question: 'I saw a snake', lang: 'en', passages, apiKey: 'k' });
  const system = lastRequest.body.systemInstruction.parts[0].text;
  assert.match(system, /never present a verdict as a prediction/i);
  assert.match(system, /medical, legal or financial/i);
  assert.match(system, /public domain/i);
});

await test('fenced JSON is unwrapped', async () => {
  stubFetch(() => json200({
    candidates: [{ content: { parts: [{ text: '```json\n{"summary":"S","points":["p"],"caveat":"c"}\n```' }] } }],
  }));
  const reading = await interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' });
  assert.equal(reading.summary, 'S');
});

await test('JSON embedded in prose is extracted', async () => {
  stubFetch(() => json200({
    candidates: [{ content: { parts: [{ text: 'Sure! Here you go:\n{"summary":"S","points":["p"],"caveat":"c"}\nHope that helps.' }] } }],
  }));
  const reading = await interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' });
  assert.equal(reading.summary, 'S');
});

await test('an unparseable reply is an error, not a crash', async () => {
  stubFetch(() => json200({ candidates: [{ content: { parts: [{ text: 'no json here' }] } }] }));
  await assert.rejects(() => interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' }), AiError);
});

await test('an empty reply is an error', async () => {
  stubFetch(() => json200({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }));
  await assert.rejects(() => interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' }), AiError);
});

await test('a safety refusal says so in plain words', async () => {
  stubFetch(() => json200({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }));
  await assert.rejects(
    () => interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' }),
    (err) => err.message.includes('declined') && !err.retryable,
  );
});

await test('a bad key is rejected immediately without retrying', async () => {
  let calls = 0;
  stubFetch(() => { calls++; return httpError(400, '{"error":{"message":"API key not valid"}}'); });
  await assert.rejects(
    () => interpret({ question: 'q', lang: 'en', passages, apiKey: 'bad' }),
    (err) => err.status === 400 && !err.retryable,
  );
  assert.equal(calls, 1, `expected 1 call, made ${calls}`);
});

await test('rate limiting is retried and then succeeds', async () => {
  let calls = 0;
  stubFetch(() => {
    calls++;
    if (calls < 3) return httpError(429, 'slow down');
    return json200(OK_BODY);
  });
  const reading = await interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' });
  assert.equal(calls, 3);
  assert.match(reading.summary, /good fortune/);
});

await test('rate limiting gives up after three attempts', async () => {
  let calls = 0;
  stubFetch(() => { calls++; return httpError(429, 'slow down'); });
  await assert.rejects(
    () => interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' }),
    (err) => err.retryable && err.status === 429,
  );
  assert.equal(calls, 3, `expected 3 calls, made ${calls}`);
});

await test('a 403 is not retried', async () => {
  let calls = 0;
  stubFetch(() => { calls++; return httpError(403, 'forbidden'); });
  await assert.rejects(() => interpret({ question: 'q', lang: 'en', passages, apiKey: 'k' }), AiError);
  assert.equal(calls, 1);
});

await test('a missing key fails before any network call', async () => {
  let calls = 0;
  stubFetch(() => { calls++; return json200(OK_BODY); });
  await assert.rejects(() => interpret({ question: 'q', lang: 'en', passages, apiKey: '', }), AiError);
  assert.equal(calls, 0);
});

await test('no passages fails before any network call', async () => {
  let calls = 0;
  stubFetch(() => { calls++; return json200(OK_BODY); });
  await assert.rejects(() => interpret({ question: 'q', lang: 'en', passages: [], apiKey: 'k' }), AiError);
  assert.equal(calls, 0);
});

await test('the key round-trips through storage and can be cleared', () => {
  saveKey('abc123');
  assert.equal(loadKey(), 'abc123');
  saveKey('');
  assert.equal(localStorage.getItem('zgd.geminiKey'), null);
});

await test('testKey asks for one word', async () => {
  stubFetch(() => json200({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
  assert.equal(await testKey('k'), true);
  assert.match(lastRequest.body.contents[0].parts[0].text, /single word/);
});

await test('testKey does not retry, so a bad key is reported fast', async () => {
  let calls = 0;
  stubFetch(() => { calls++; return httpError(400, 'API key not valid'); });
  await assert.rejects(() => testKey('bad'), AiError);
  assert.equal(calls, 1);
});

console.log(failures ? `\n${failures} failure(s)` : '\nall ai checks passed');
process.exit(failures ? 1 : 0);