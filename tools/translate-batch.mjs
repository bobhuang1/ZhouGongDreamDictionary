/**
 * Translate all book entries into a target language with Gemini 2.5 Flash.
 *
 * Resumable and idempotent: each language writes data/translations/<lang>.json
 * after every batch, and finished entries are skipped on restart. Reruns cost
 * nothing once complete.
 *
 * Usage:
 *   GEMINI_API_KEY=... node tools/translate-batch.mjs --lang=en
 *   GEMINI_API_KEY=... node tools/translate-batch.mjs --lang=all
 *   node tools/translate-batch.mjs --status
 *
 * Optional: --limit=N, --batch=N, --from=N, --concurrency=N
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOOK = join(ROOT, 'data', 'dreambook.json');
const OUT_DIR = join(ROOT, 'data', 'translations');
/** gemini-2.5-flash is retired for new API keys (404: "no longer available to
 *  new users"). 3.7/3.8 answer but intermittently 503 under load, so lead with
 *  3.6 and fall back rather than stalling the whole run. */
const MODELS = (process.env.GEMINI_MODEL || 'gemini-3.6-flash')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean);
const MODEL = MODELS[0];
const ENDPOINTS = MODELS.map((m) => ({
  model: m,
  url: `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`,
}));

export const LANGS = ['en', 'ja', 'es', 'ru', 'fr'];

const NAMES = {
  en: 'English', ja: 'Japanese', es: 'Spanish', ru: 'Russian', fr: 'French',
};
const TONE_WORDS = {
  en: { good: 'auspicious', bad: 'inauspicious', mixed: 'depends on context' },
  ja: { good: '吉', bad: '凶', mixed: '文脈による' },
  es: { good: 'favorable', bad: 'desfavorable', mixed: 'depende del contexto' },
  ru: { good: 'благоприятный', bad: 'неблагоприятный', mixed: 'зависит от контекста' },
  fr: { good: 'favorable', bad: 'défavorable', mixed: 'dépend du contexte' },
};

function parseArgs(argv) {
  const args = { lang: 'en', status: false, limit: 0, batch: 25, from: 0, concurrency: 3 };
  for (const arg of argv) {
    const [k, v] = arg.replace(/^--/, '').split('=');
    if (k === 'status') args.status = true;
    else if (k in args) args[k] = v === undefined ? true : (Number.isNaN(+v) ? v : +v);
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Prompt asks for the two things the site actually needs: a faithful
 *  translation, and a plain-modern restatement that a reader can act on. */
function buildPrompt(lang, entries) {
  return `You are translating entries from 周公解夢 (Zhougong Jie Meng), a classical
Chinese dream-interpretation book. The book is public domain.

For each entry you receive, produce JSON with these fields:

- "literal": faithful translation of the classical phrase, ${NAMES[lang]}.
  Keep the compact, oracular register. Example for English:
  "Tianmen opens, a noble introduces" -> "The Gate of Heaven opens; a patron appears."
- "modern": one plain sentence, ${NAMES[lang]}, explaining what the entry means
  for someone who had this dream. Write it the way a thoughtful friend would
  explain it. Address the reader as "you". Do not claim scientific validity.
- "tone": exactly one of "good", "bad", "mixed". Judge the classical verdict, not
  the modern gloss. Use "mixed" when the text pairs opposites (e.g. auspicious
  and inauspicious in one phrase, or a conditional reading).
- "keywords": 2-5 lowercase ${NAMES[lang]} search keywords for this entry, so a
  user typing a free-text dream description can find it. Use everyday words,
  not classical ones.

Rules:
- Translate meaning, not word-for-word padding.
- "modern" must be understandable to someone who has never heard of this book.
- Never invent a different omen than the text states.
- tone reference: ${JSON.stringify(TONE_WORDS[lang])}

Return ONLY a JSON array, same length and order as the input, no commentary:
[{"id":"<id>","literal":"...","modern":"...","tone":"good|bad|mixed","keywords":["..."]}]

ENTRIES:
${JSON.stringify(entries.map((e) => ({ id: e.id, text: e.zhHant, section: sectionTitles[e.section] })), null, 0)}`;
}

let sectionTitles = {};

async function callGemini(apiKey, lang, entries, attempt = 0, modelIdx = 0) {
  const { model, url } = ENDPOINTS[modelIdx];
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(lang, entries) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 8192,
      },
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      ],
    }),
  });

  if (res.status === 429 || res.status >= 500) {
    // 503 here is usually transient load on a preview model, so try the next
    // configured model before spending a backoff cycle on this one.
    if (res.status >= 500 && modelIdx + 1 < ENDPOINTS.length) {
      console.log(`    ${model} ${res.status}, switching to ${ENDPOINTS[modelIdx + 1].model}`);
      return callGemini(apiKey, lang, entries, attempt, modelIdx + 1);
    }
    if (attempt >= 5) throw new Error(`gemini ${res.status} after retries`);
    const wait = 5000 * 2 ** attempt;
    console.log(`    gemini ${res.status}, retrying in ${wait / 1000}s`);
    await sleep(wait);
    return callGemini(apiKey, lang, entries, attempt + 1, modelIdx);
  }
  if (res.status === 404 && modelIdx + 1 < ENDPOINTS.length) {
    console.log(`    ${model} retired (404), switching to ${ENDPOINTS[modelIdx + 1].model}`);
    return callGemini(apiKey, lang, entries, attempt, modelIdx + 1);
  }
  if (!res.ok) {
    throw new Error(`gemini ${model} ${res.status}: ${(await res.text()).slice(0, 400)}`);
  }

  const json = await res.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  if (!text) throw new Error('gemini returned no text');

  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Truncated array: salvage the complete objects.
    const salvaged = cleaned.match(/\{\s*"id"[\s\S]*?\}/g) ?? [];
    parsed = salvaged.map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
    if (!parsed.length) throw new Error('could not parse gemini response as JSON');
    console.log(`    salvaged ${parsed.length}/${entries.length} objects from a truncated response`);
  }
  if (!Array.isArray(parsed)) throw new Error('gemini did not return an array');
  return parsed;
}

/** Keep only rows that are complete and reference a real entry id. */
function validateRows(rows, entries) {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const clean = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    if (!byId.has(row.id)) continue;
    if (typeof row.literal !== 'string' || !row.literal.trim()) continue;
    if (typeof row.modern !== 'string' || !row.modern.trim()) continue;
    const tone = ['good', 'bad', 'mixed'].includes(row.tone) ? row.tone : 'mixed';
    const keywords = Array.isArray(row.keywords)
      ? row.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim().toLowerCase()).slice(0, 5)
      : [];
    clean.set(row.id, {
      literal: row.literal.trim(),
      modern: row.modern.trim(),
      tone,
      keywords,
    });
  }
  return clean;
}

async function loadExisting(lang) {
  const path = join(OUT_DIR, `${lang}.json`);
  if (!existsSync(path)) return { lang, entries: {} };
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return { lang, entries: {} };
  }
}

async function save(lang, data, book) {
  data.meta = {
    lang,
    name: NAMES[lang],
    model: MODEL,
    entryCount: Object.keys(data.entries).length,
    totalEntries: book.entries.length,
    complete: Object.keys(data.entries).length === book.entries.length,
    source: book.meta.source,
  };
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, `${lang}.json`), JSON.stringify(data), 'utf8');
}

async function translateLang(lang, book, apiKey, args) {
  const data = await loadExisting(lang);
  const done = new Set(Object.keys(data.entries));
  let pending = book.entries.filter((e) => !done.has(e.id));
  if (args.from) pending = pending.slice(args.from);
  if (args.limit) pending = pending.slice(0, args.limit);

  const total = Object.keys(data.entries).length;
  console.log(`\n[${lang}] ${NAMES[lang]}: ${total}/${book.entries.length} done, ${pending.length} to go`);

  const batches = [];
  for (let i = 0; i < pending.length; i += args.batch) batches.push(pending.slice(i, i + args.batch));
  let processed = 0;
  let failures = 0;

  for (let i = 0; i < batches.length; i += args.concurrency) {
    const group = batches.slice(i, i + args.concurrency);
    const results = await Promise.allSettled(
      group.map((batch) => callGemini(apiKey, lang, batch).then((rows) => validateRows(rows, batch))),
    );
    for (let g = 0; g < group.length; g++) {
      const r = results[g];
      if (r.status === 'rejected') {
        failures++;
        console.log(`  batch ${i + g} FAILED: ${r.reason.message}`);
        continue;
      }
      for (const [id, value] of r.value) data.entries[id] = value;
      processed += group[g].length;
    }
    await save(lang, data, book);
    const pct = ((Object.keys(data.entries).length / book.entries.length) * 100).toFixed(1);
    console.log(`  ${Object.keys(data.entries).length}/${book.entries.length} (${pct}%)  ${failures} failed`);
  }
  await save(lang, data, book);
  const count = Object.keys(data.entries).length;
  console.log(`[${lang}] finished: ${count}/${book.entries.length}`);
  return count === book.entries.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const book = JSON.parse(await readFile(BOOK, 'utf8'));
  sectionTitles = Object.fromEntries(book.sections.map((s) => [s.id, s.zhHant]));

  if (args.status) {
    console.log(`book: ${book.entries.length} entries in ${book.sections.length} sections\n`);
    for (const lang of LANGS) {
      const data = await loadExisting(lang);
      const n = Object.keys(data.entries).length;
      const pct = ((n / book.entries.length) * 100).toFixed(1);
      console.log(`  ${lang}  ${String(n).padStart(4)}/${book.entries.length}  ${pct.padStart(5)}%  ${n === book.entries.length ? 'complete' : 'partial'}`);
    }
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('GEMINI_API_KEY is not set.\nGet a free key at https://aistudio.google.com/apikey');
    process.exit(1);
  }

  const targets = args.lang === 'all' ? LANGS : [args.lang];
  for (const lang of targets) {
    if (!LANGS.includes(lang)) throw new Error(`unknown language: ${lang}`);
    await translateLang(lang, book, apiKey, args);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
