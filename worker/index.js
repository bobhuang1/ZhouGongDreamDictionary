/**
 * Zhou Gong Dream Dictionary -- AI proxy.
 *
 * Holds the Gemini API key so the key never reaches a browser, and so a static
 * site can offer AI readings without asking every reader to paste a key.
 *
 * What crosses the network: one question, the matched book entries, the display
 * language. Nothing else. The book itself is public domain and served statically.
 *
 * The key lives in a Worker secret (`wrangler secret put GEMINI_API_KEY`).
 * Nothing here reads process.env, and there is no binding for the key, so it
 * cannot end up in a checked-in file.
 */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';
/**
 * Order matters. flash-lite leads because it is the model that has actually
 * answered reliably here: gemini-3.6-flash returns a fast 503 under load often
 * enough that leading with it made roughly 8 of 10 readings fail. Putting the
 * steady model first and the faster one second gives the common path a high
 * success rate, and 3.6 still gets used whenever it is healthy.
 */
const MODELS = ['gemini-3.1-flash-lite', 'gemini-3.6-flash'];

/** Allowed browser origins. Keep this to origins you actually deploy. */
const ALLOWED_ORIGINS = [
  'https://bobhuang1.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // Vary on Origin so a cache cannot serve one origin's response to another.
  Vary: 'Origin',
  'X-Content-Type-Options': 'nosniff',
};

/* ------------------------------------------------------------------ *
 * Rate limiting
 *
 * A shared public key plus no limit is an open invitation to drain the
 * quota. Two layers:
 *  - AI_RATE_LIMIT, the Workers rate-limit binding (wrangler.toml), is
 *    enforced at the edge and stops bursts, including parallel requests that
 *    a KV read-modify-write cannot see.
 *  - The KV sliding window below adds the 10 readings/hour/IP budget. KV is
 *    eventually consistent and has a daily write quota, so it is best-effort:
 *    if KV fails the request is allowed (the binding still bounds abuse)
 *    instead of the whole Worker throwing for every user.
 * ------------------------------------------------------------------ */

const WINDOW_SECONDS = 3600;
const MAX_PER_WINDOW = 10;

async function clientKey(request, env) {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For') ||
    'unknown';
  // Hash so the store holds a digest rather than a raw address.
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip + env.RATE_SALT)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
  return `rl:${digest}`;
}

async function checkRateLimit(request, env) {
  const key = await clientKey(request, env);

  if (env.AI_RATE_LIMIT) {
    const { success } = await env.AI_RATE_LIMIT.limit({ key });
    if (!success) return { allowed: false, retryAfter: 60 };
  }

  if (!env.RATE_LIMITER) return { allowed: true };
  try {
    return await checkHourlyWindow(env, key);
  } catch (err) {
    // KV write quota exhausted or KV unavailable: fail open, deliberately.
    console.error('KV rate limiter unavailable, allowing request:', err);
    return { allowed: true };
  }
}

async function checkHourlyWindow(env, key) {
  // Sliding window: a list of recent request timestamps rather than a counter.
  // A fixed window is wrong here because the reset only happens on the next
  // request, so a reader who used their quota was locked out for a full hour
  // from their first request and Retry-After had no honest value to give. With
  // timestamps, the oldest entry ages out on its own and Retry-After is exact.
  const raw = await env.RATE_LIMITER.get(key);
  let stamps = [];
  try {
    const parsed = raw === null ? [] : JSON.parse(raw);
    if (Array.isArray(parsed)) stamps = parsed.filter((n) => typeof n === 'number');
  } catch { /* corrupt or legacy counter: start clean */ }

  const cutoff = Date.now() - WINDOW_SECONDS * 1000;
  stamps = stamps.filter((t) => t > cutoff);

  if (stamps.length >= MAX_PER_WINDOW) {
    const oldest = Math.min(...stamps);
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((oldest + WINDOW_SECONDS * 1000 - Date.now()) / 1000)),
    };
  }

  stamps.push(Date.now());
  await env.RATE_LIMITER.put(key, JSON.stringify(stamps), {
    expirationTtl: WINDOW_SECONDS,
  });
  return { allowed: true };
}

/* ------------------------------------------------------------------ *
 * CORS
 * ------------------------------------------------------------------ */

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : null;
  if (!allowed) return {};
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(request, status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request) },
  });
}

/* ------------------------------------------------------------------ *
 * Upstream call
 * ------------------------------------------------------------------ */

function describeUpstreamError(status, body) {
  if (status === 400 && /API key not valid/i.test(body)) {
    return { message: 'The server key was rejected by Google.', retryable: false };
  }
  if (status === 400) {
    // A malformed request will never succeed, so surface the reason instead of
    // reporting it as a temporary outage.
    // Keep Google's error text in the logs, not in the response.
    console.error('Gemini rejected the request:', body.slice(0, 500));
    return { message: 'Google rejected the request.', retryable: false };
  }
  if (status === 403) {
    return { message: 'The server key is not allowed to use this model.', retryable: false };
  }
  if (status === 429) {
    return { message: 'The reading service is busy. Please try again in a moment.', retryable: true };
  }
  if (status >= 500) {
    return { message: 'The reading service had a problem. Please try again.', retryable: true };
  }
  return { message: `The reading service failed (HTTP ${status}).`, retryable: false };
}

async function callGemini(env, payload) {
  let lastError = { message: 'The reading service is unavailable.', retryable: true };

  for (const model of MODELS) {
    let res;
    try {
      res = await fetch(`${GEMINI_HOST}/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': env.GEMINI_API_KEY,
        },
        body: JSON.stringify(payload),
      });
    } catch {
      lastError = { message: 'Could not reach the reading service.', retryable: true };
      continue;
    }

    if (res.ok) {
      const json = await res.json();
      const block = json.candidates?.[0];
      const text = block?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text) {
        const reason = block?.finishReason ?? 'unknown';
        return {
          ok: false,
          // SAFETY is the model's own refusal; that is not a service failure.
          status: reason === 'SAFETY' ? 422 : 502,
          message:
            reason === 'SAFETY'
              ? 'The model declined to answer this one. Try describing the dream with fewer details.'
              : 'The model returned an empty answer. Try again.',
        };
      }
      return { ok: true, text, model };
    }

    lastError = describeUpstreamError(res.status, await res.text());
    // A retired (404) or overloaded (5xx) model means try the next one, not retry
    // the same one. Log the real status: without it, an upstream 429 and a 500
    // both surface as the same generic "busy" message.
    console.warn(`upstream ${res.status} from ${model}`);
    if (res.status === 404 || res.status >= 500) continue;
    break;
  }

  return { ok: false, status: lastError.retryable ? 503 : 502, message: lastError.message };
}

/* ------------------------------------------------------------------ *
 * Request handling
 * ------------------------------------------------------------------ */

const LANGUAGES = new Set(['en', 'ja', 'es', 'ru', 'fr', 'zh-Hant', 'zh-Hans']);

const LANGUAGE_NAMES = {
  en: 'English', ja: 'Japanese', es: 'Spanish', ru: 'Russian', fr: 'French',
  'zh-Hant': 'Traditional Chinese', 'zh-Hans': 'Simplified Chinese',
};

/**
 * The Worker owns the system prompt rather than trusting the client to send one.
 *
 * Two reasons. The safety framing is the product here -- a request that arrives
 * with a caller-chosen system instruction could drop the "folklore, not a
 * prediction, not medical advice" rule and have the model comply, since we are
 * the one paying for it. And the reply contract is fixed: the client parses
 * {summary, points, caveat}, so the instruction to emit exactly that shape has
 * to be non-negotiable rather than advisory.
 */
function systemPrompt(lang) {
  const name = LANGUAGE_NAMES[lang] ?? 'English';
  return `You are explaining passages from Zhougong Jie Meng (Zhou Gong Dream Dictionary), a classical Chinese dream-interpretation book compiled more than a thousand years ago. The book is public domain. It is folklore written down over centuries, not science, and it does not predict the future.

You are writing for a reader whose interface language is ${name}. Write your whole answer in ${name}, including every point in the list and the caveat.

Rules:
- Explain the passages in plain modern ${name}. The originals are terse seven-character formulae.
- Be concrete about what the book actually says. Where a passage is ambiguous or conditional, say so plainly instead of picking the luckier reading.
- Never state or imply a prediction. No "this means you will...", no certainties about the future.
- Never give medical, psychological, legal or financial advice. If the dream concerns illness, anxiety, danger or money, treat it as the book does and note that a qualified person is the right one to ask.
- Do not invent passages, sources or extra symbolism that are not in the text you were given.

Reply with JSON only, no prose and no code fence, in exactly this shape:
{"summary": string, "points": string[], "caveat": string}

- "summary": two or three sentences on what these passages mean together.
- "points": an array of two to five short strings, one per distinct point the passages make.
- "caveat": one sentence stating that this is traditional folklore rather than a prediction, and not professional advice.`;
}

function userPrompt({ question, lang, passages }) {
  const lines = passages.map(
    (p, i) => `${i + 1}. ${p.zhHant} (simplified: ${p.zhHans})`,
  );
  return `Reader's question: ${question}

Book passages:
${lines.join('\n')}`;
}

function readRequest(body) {
  if (typeof body?.question !== 'string' || !body.question.trim()) {
    return { error: 'A question is required.' };
  }
  if (body.question.length > 2000) {
    return { error: 'That question is too long.' };
  }
  const lang = LANGUAGES.has(body.lang) ? body.lang : 'en';
  if (!Array.isArray(body.passages) || body.passages.length === 0) {
    return { error: 'No passages to interpret.' };
  }
  if (body.passages.length > 40) {
    return { error: 'Too many passages.' };
  }
  // Each passage is {zhHant, zhHans}; cap the text so a hostile client cannot
  // bill us for a megabyte of "passages".
  const passages = body.passages.slice(0, 40).map((p) => ({
    zhHant: String(p?.zhHant ?? '').slice(0, 500),
    zhHans: String(p?.zhHans ?? '').slice(0, 500),
  }));
  return { question: body.question.trim(), lang, passages };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json(request, 200, { ok: true, models: MODELS, rateLimitPerHour: MAX_PER_WINDOW });
    }

    if (request.method === 'OPTIONS') {
      const origin = request.headers.get('Origin');
      if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (url.pathname !== '/interpret' || request.method !== 'POST') {
      return json(request, 404, { error: 'Not found.' });
    }

    const origin = request.headers.get('Origin');
    if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
      return json(request, 403, { error: 'Origin not allowed.' });
    }

    if (!env.RATE_SALT) {
      // Without the salt the KV keys would be plain hashes of IP addresses.
      return json(request, 500, { error: 'The reading service is not configured.' });
    }

    // Count before the API key check, so an unconfigured or misconfigured Worker
    // cannot be used to hammer Google for free once a key is added later.
    const limit = await checkRateLimit(request, env);
    if (!limit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Too many readings from this connection. Please try again later.' }),
        {
          status: 429,
          headers: {
            ...JSON_HEADERS,
            ...corsHeaders(request),
            'Retry-After': String(limit.retryAfter),
          },
        },
      );
    }

    if (!env.GEMINI_API_KEY) {
      return json(request, 500, { error: 'The reading service is not configured.' });
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json(request, 400, { error: 'Invalid JSON body.' });
    }

    const checked = readRequest(payload);
    if (checked.error) return json(request, 400, { error: checked.error });

    const result = await callGemini(env, {
      systemInstruction: { parts: [{ text: systemPrompt(checked.lang) }] },
      contents: [
        { role: 'user', parts: [{ text: userPrompt(checked) }] },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.5,
        maxOutputTokens: 1024,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    });

    if (!result.ok) return json(request, result.status, { error: result.message });
    return json(request, 200, { text: result.text });
  },
};
