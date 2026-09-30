/**
 * AI layer: Gemini 2.5 Flash, called straight from the browser.
 *
 * Why the browser and not a server: this is a static site on GitHub Pages with
 * no backend to hold a secret, and no key means no leak. The user pastes their
 * own free key, it lives in localStorage, and the only request it is attached to
 * is the one that asks for a dream reading. A site that wanted to be a hosted
 * service would move this file behind a small proxy and keep the key server
 * side -- the rest of the app would not change, because everything else already
 * runs locally.
 *
 * What is sent: the user's question, the matched book entries, and the display
 * language. Nothing else. The book is public domain and already downloaded.
 */

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const KEY_STORAGE = 'zgd.geminiKey';

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
      res = await fetch(ENDPOINT, {
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
    if (!err.retryable) throw err;
    lastError = err;
    await sleep(900 * 2 ** attempt);
  }
  throw lastError ?? new AiError('The request failed.');
}

/** Cheap call used only to check whether a pasted key works. */
export async function testKey(apiKey) {
  await callGemini(apiKey, {
    contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
    generationConfig: { maxOutputTokens: 8 },
  }, { attempts: 1 });
  return true;
}

/**
 * Ask the model to read the matched entries for this reader.
 * @returns {{summary: string, points: string[], caveat: string}}
 */
export async function interpret({ question, lang, passages, apiKey, signal }) {
  if (!apiKey) throw new AiError('No API key set.');
  if (!passages.length) throw new AiError('No passages to interpret.');

  const text = await callGemini(apiKey, {
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
  }, { attempts: 3 });

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
