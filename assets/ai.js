/**
 * AI layer: asks a small serverless proxy for a plain-language reading.
 *
 * Why a proxy: the Gemini key belongs to the site owner, not to each reader. A
 * key in browser JavaScript cannot be hidden -- everything shipped to a client
 * is readable in view-source or devtools, and this repository is public, so a
 * committed key would live in git history permanently. worker/index.js holds the
 * key as a Cloudflare Worker secret instead and never returns it.
 *
 * The proxy only sees what the reader already typed plus the matched public-domain
 * passages. It applies rate limiting, because a public proxy with no limit is an
 * open invitation to drain the quota.
 *
 * Everything else still runs locally: retrieval, prompt construction, JSON
 * validation, and the safety framing in the system prompt. The Worker forwards
 * the prompt text and returns raw JSON text, so it holds no interpretation logic.
 *
 * Fallback: if the proxy is unreachable or unconfigured, set a personal key in
 * Settings and it talks to Google directly again.
 */

const PROXY_URL = 'https://zhou-dream-ai.oemscarf.workers.dev';
const KEY_STORAGE = 'zgd.geminiKey';

/** Only for the direct-to-Google fallback path, when a reader supplies their own
 *  key. The proxy picks its own model server-side. flash-lite leads because
 *  3.6 answers with a fast 503 too often to be first; gemini-2.5-flash is
 *  retired for new keys (404). */
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.6-flash'];
let modelIdx = 0;
const endpoint = (m) => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

/** Names the model should use for itself, so the reply reads naturally. */
const LANGUAGE_NAMES = {
  en: 'English', ja: 'Japanese', es: 'Spanish', ru: 'Russian', fr: 'French',
  'zh-Hant': 'Traditional Chinese', 'zh-Hans': 'Simplified Chinese',
};

export class AiError extends Error {
  constructor(message, { retryable = false, status = 0 } = {}) {
    super(message);
    this.name = 'AiError';
    this.retryable = retryable;
    this.status = status;
  }
}

export function loadKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function saveKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch { /* private browsing: the key just will not persist */ }
}

function systemPrompt(lang) {
  const name = LANGUAGE_NAMES[lang] ?? 'English';
  return `You are explaining passages from 周公解夢 (Zhougong Jie Meng), a classical Chinese
dream-interpretation book. The book is public domain. It is folklore, not science,
and it does not predict the future.

You will be given:
- a short section heading, in Chinese
- several entries, each a classical Chinese line pairing a dream symbol with a verdict
- optionally, a machine translation of those entries, which may be rough

Write the interpretation in ${name}, for one reader, using second person ("you").

The reader is asking a practical question, not a scholarly one. So:
- Start with the single most useful sentence: what this dream is traditionally read
  as pointing at, in plain terms.
- Then give the specifics, in a few short bullets, tied to the entries above.
- Say plainly when the book is ambiguous or when an entry is a conditional reading.
- Never present a verdict as a prediction, and never give medical, legal or financial
  advice. If the dream is about illness, anxiety, or danger, say plainly that the book
  is folklore and suggest the reader talk to a real person who can help.
- Do not add omens the entries do not state. If the passages are only loosely related
  to the question, say so instead of forcing a reading.
- Keep it under 220 words. No preamble, no headings with symbols, no sign-off.

Return ONLY JSON:
{
  "summary": "one or two sentences, plain language",
  "points": ["short bullet", "short bullet", "short bullet"],
  "caveat": "one short sentence on what this is and is not"
}`;
}

function userPrompt({ question, lang, passages }) {
  const lines = passages.map((p, i) => {
    const parts = [`${i + 1}. [${p.sectionTitle}] ${p.zhHant}`];
    if (p.zhHans && p.zhHans !== p.zhHant) parts.push(`   (simplified: ${p.zhHans})`);
    if (p.literal) parts.push(`   (rough translation: ${p.literal})`);
    return parts.join('\n');
  });
  return `The reader's question, written in ${LANGUAGE_NAMES[lang] ?? 'their own language'}:
"""
${question}
"""

Matching entries from the book:
${lines.join('\n')}

Interpret these entries for this reader in ${LANGUAGE_NAMES[lang] ?? 'English'}.`;
}

/** Strip markdown fences and pull the JSON object out of a chatty reply. */
function parseJson(text) {
  const cleaned = text
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch { /* fall through to extraction */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch { /* give up below */ }
  }
  throw new AiError('The model did not return usable JSON.');
}

function describeError(status, body) {
  if (status === 400 && /API key not valid/i.test(body)) {
    return new AiError('That key was rejected by Google.', { status });
  }
  if (status === 400 && /API key/i.test(body)) {
    return new AiError('That key was rejected by Google. Check that it was copied whole.', { status });
  }
  if (status === 403) return new AiError('That key is not allowed to use this model.', { status });
  if (status === 429) {
    return new AiError('Google is rate-limiting this key. Wait a moment and try again.', { retryable: true, status });
  }
  if (status >= 500) {
    return new AiError('Google had a server problem. Try again in a moment.', { retryable: true, status });
  }
  return new AiError(`The request failed (HTTP ${status}).`, { status });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(apiKey, body, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetch(endpoint(MODELS[modelIdx]), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = new AiError('Could not reach Google. Check your connection.', { retryable: true });
      await sleep(800 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const block = json.candidates?.[0];
      const text = block?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) {
        const reason = block?.finishReason ?? 'unknown';
        throw new AiError(
          reason === 'SAFETY'
            ? 'The model declined to answer this one. Try describing the dream with fewer details.'
            : 'The model returned an empty answer. Try again.',
          { retryable: reason !== 'SAFETY' },
        );
      }
      return text;
    }

    const err = describeError(res.status, await res.text());
    // A retired (404) or overloaded (5xx) model is a routing problem, not a
    // failure worth retrying on the same model: move to the next one.
    if ((res.status === 404 || res.status >= 500) && modelIdx + 1 < MODELS.length) {
      modelIdx += 1;
      lastError = err;
      continue;
    }
    if (!err.retryable) throw err;
    lastError = err;
    await sleep(900 * 2 ** attempt);
  }
  throw lastError ?? new AiError('The request failed.');
}

async function callProxy(body, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let res;
    try {
      res = await fetch(`${PROXY_URL}/interpret`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastError = new AiError('Could not reach the reading service. Check your connection.', { retryable: true });
      await sleep(800 * 2 ** attempt);
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const text = typeof json.text === 'string' ? json.text : '';
      if (!text) throw new AiError('The reading service returned an empty answer. Try again.', { retryable: true });
      return text;
    }

    const err = await describeProxyError(res);
    if (!err.retryable) throw err;
    lastError = err;
    await sleep(900 * 2 ** attempt);
  }
  throw lastError ?? new AiError('The reading service did not respond.');
}

async function describeProxyError(res) {
  let message = `The reading service failed (HTTP ${res.status}).`;
  try {
    const json = await res.json();
    if (typeof json?.error === 'string' && json.error) message = json.error;
  } catch { /* keep the generic message */ }

  if (res.status === 429) {
    const after = Number(res.headers.get('Retry-After') ?? 0);
    return new AiError(
      after
        ? `Too many readings from this connection. Try again in ${Math.ceil(after / 60)} minute(s).`
        : 'The reading service is busy. Wait a moment and try again.',
      { retryable: false, status: 429 },
    );
  }
  if (res.status >= 500) {
    return new AiError(message, { retryable: true, status: res.status });
  }
  if (res.status === 422) return new AiError(message, { status: 422 });
  return new AiError(message, { status: res.status });
}

/** True when the reader has opted into a personal key as a fallback. */
export function hasPersonalKey() {
  return Boolean(loadKey());
}

/** Probes the proxy. Used to report availability in Settings, not to gate a reading. */
export async function checkService() {
  try {
    const res = await fetch(`${PROXY_URL}/health`, { method: 'GET' });
    if (!res.ok) return { ok: false };
    return { ok: true, ...(await res.json()) };
  } catch {
    return { ok: false };
  }
}

/**
 * Cheap call used only to check whether a pasted personal key works.
 *
 * Uses the first model only. A rate-limited key (429) is not an invalid key, and
 * saying so would send the reader off to re-copy a perfectly good key, so the
 * caller distinguishes the two.
 */
export async function testKey(apiKey) {
  const result = await callGemini(
    apiKey,
    {
      contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { maxOutputTokens: 8 },
    },
    { attempts: 1 },
  ).catch((err) => {
    if (err instanceof AiError && err.status === 429) return 'rate-limited';
    throw err;
  });
  if (result === 'rate-limited') {
    throw new AiError('Google is rate-limiting this key right now. It may still be valid — try the reading.', {
      status: 429,
    });
  }
  return true;
}

/**
 * Ask the model to read the matched entries for this reader.
 * @returns {{summary: string, points: string[], caveat: string}}
 */
export async function interpret({ question, lang, passages, apiKey, signal }) {
  if (!passages.length) throw new AiError('No passages to interpret.');

  const request = {
    systemInstruction: { parts: [{ text: systemPrompt(lang) }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt({ question, lang, passages }) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.5,
      maxOutputTokens: 1024,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  // Proxy by default. A personal key is an explicit opt-in, and takes over when
  // the reader has set one -- useful for beating the proxy's rate limit.
  let text;
  if (apiKey) {
    text = await callGemini(apiKey, request, { attempts: 3 });
  } else {
    // The Worker builds the system prompt and the passage block itself: it owns
    // the safety framing and the JSON reply contract, so those are not sent from
    // a client that could be modified to drop them.
    text = await callProxy({
      question,
      lang,
      passages: passages.map((p) => ({ zhHant: p.zhHant, zhHans: p.zhHans })),
    });
  }

  if (signal?.aborted) throw new AiError('Cancelled.');

  const parsed = parseJson(text);
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  const points = Array.isArray(parsed.points)
    ? parsed.points.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).slice(0, 6)
    : [];
  const caveat = typeof parsed.caveat === 'string' ? parsed.caveat.trim() : '';

  if (!summary && !points.length) throw new AiError('The model returned an empty answer. Try again.');
  return { summary, points, caveat };
}
