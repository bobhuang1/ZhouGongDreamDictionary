/**
 * Validate every data file before it ships.
 *
 * Checks the things that actually broke during development:
 *   - JSON parses, and i18n files all have the same keys as the English one
 *   - no translation value contains a stray Latin word inside CJK text, an
 *     HTML tag, or a replacement character (the symptom of a botched edit)
 *   - the book has the expected shape: 27 sections, ~988 unique entries,
 *     every entry has both scripts and a valid section reference
 *   - every lexicon `book` substring really occurs in the book text, so a
 *     concept cannot silently stop matching
 *   - translation files, when present, cover only real entry ids
 *
 * Usage: node tools/validate.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const I18N = join(ROOT, 'data', 'i18n');
const TRANSLATIONS = join(ROOT, 'data', 'translations');
const LANGS = ['en', 'ja', 'es', 'ru', 'fr'];

const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

const CJK = /[\u3040-\u30ff\u3400-\u9fff]/;

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    fail(`${path}: ${err.message}`);
    return null;
  }
}

/**
 * Latin words are legitimate inside CJK text when they are a brand, a URL or a
 * placeholder, and suspicious when they are an ordinary word -- that is the
 * signature of an edit that spliced two languages together. So the check only
 * applies to CJK-script locales, and only after removing the allowlist.
 */
const LATIN_ALLOWED =
  /https?:\/\/\S+|\b[a-z0-9-]+\.(?:com|org|net|cc|io|dev)\/\S*|\b(?:localStorage|Google|Gemini|API|AI|AIza|zh-Hant|zh-Hans|OpenAI)\b|\{[a-zA-Z]+\}/g;
const CJK_LOCALES = new Set(['zh-Hant', 'zh-Hans', 'ja']);
const LATIN_WORD = /[A-Za-z]{4,}/g;

function checkSplicedText(value, where, locale) {
  if (typeof value !== 'string') return;
  if (/\uFFFD/.test(value)) fail(`${where}: contains U+FFFD replacement character`);
  if (/<[a-zA-Z/][^>]*>/.test(value)) fail(`${where}: contains an HTML tag`);
  if (!CJK_LOCALES.has(locale) || !CJK.test(value)) return;
  const cleaned = value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?/gi, ' ')
    .replace(LATIN_ALLOWED, ' ')
    .replace(/\{[a-zA-Z]+\}/g, ' ');
  for (const word of new Set(cleaned.match(LATIN_WORD) ?? [])) {
    fail(`${where}: latin word "${word}" inside CJK text -> ${value.slice(0, 90)}`);
  }
}

async function checkI18n() {
  const en = await readJson(join(I18N, 'en.json'));
  if (!en) return;
  const keys = Object.keys(en);
  notes.push(`i18n: ${keys.length} keys in en.json (reference)`);

  const files = (await readdir(I18N)).filter((f) => f.endsWith('.json'));
  for (const file of files) {
    const dict = await readJson(join(I18N, file));
    if (!dict) continue;
    for (const key of keys) {
      if (!(key in dict)) fail(`i18n/${file}: missing key "${key}"`);
      else if (!String(dict[key]).trim()) fail(`i18n/${file}: empty value for "${key}"`);
    }
    for (const key of Object.keys(dict)) {
      if (!keys.includes(key)) fail(`i18n/${file}: extra key "${key}" not in en.json`);
    }
    for (const [key, value] of Object.entries(dict)) checkSplicedText(value, `i18n/${file}:${key}`, file.replace('.json', ''));
    const placeholders = (s) => (String(s).match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',');
    for (const key of keys) {
      if (key in dict && placeholders(en[key]) !== placeholders(dict[key])) {
        fail(`i18n/${file}: "${key}" placeholders differ (${placeholders(en[key])} vs ${placeholders(dict[key])})`);
      }
    }
  }
  const expected = ['en.json', 'zh-Hant.json', 'zh-Hans.json', ...LANGS.filter((l) => l !== 'en').map((l) => `${l}.json`)];
  for (const want of expected) {
    if (!files.includes(want)) fail(`i18n/${want} is missing`);
  }
}

async function checkBook(book) {
  if (!book) return;
  const { meta, sections, entries } = book;
  if (!Array.isArray(sections) || sections.length !== 27) fail(`book: expected 27 sections, got ${sections?.length}`);
  if (!Array.isArray(entries)) return fail('book: entries is not an array');
  if (entries.length < 900) fail(`book: only ${entries.length} entries, expected ~988`);

  const sectionIds = new Set((sections ?? []).map((s) => s.id));
  const ids = new Set();
  const texts = new Set();
  for (const e of entries) {
    if (ids.has(e.id)) fail(`book: duplicate entry id "${e.id}"`);
    ids.add(e.id);
    if (typeof e.zhHant !== 'string' || !e.zhHant.trim()) fail(`book: ${e.id} missing zhHant`);
    if (typeof e.zhHans !== 'string' || !e.zhHans.trim()) fail(`book: ${e.id} missing zhHans`);
    if (e.zhHant && e.zhHans && e.zhHant === e.zhHans && /[門門貴貴傳傳體體]/.test(e.zhHant)) {
      fail(`book: ${e.id} looks unconverted: ${e.zhHant}`);
    }
    if (/[{}[\]|]/.test(e.zhHant ?? '')) fail(`book: ${e.id} has wiki residue: ${e.zhHant}`);
    if (!sectionIds.has(e.section)) fail(`book: ${e.id} references missing section ${e.section}`);
    if (texts.has(e.zhHant)) fail(`book: duplicate text "${e.zhHant}"`);
    texts.add(e.zhHant);
    if (!['good', 'bad', 'mixed'].includes(e.toneHint)) fail(`book: ${e.id} bad toneHint ${e.toneHint}`);
  }
  if (meta && meta.entryCount !== entries.length) {
    fail(`book: meta.entryCount ${meta.entryCount} != ${entries.length}`);
  }
  notes.push(`book: ${entries.length} entries, ${sections?.length} sections`);
}

async function checkLexicon(book) {
  const payload = await readJson(join(ROOT, 'data', 'lexicon.json'));
  if (!payload) return;
  const concepts = payload.concepts ?? [];
  if (!concepts.length) return fail('lexicon: no concepts');

  // Markers are { hant, hans } objects, so that a Simplified-Chinese question
  // can reach entries written in Traditional and vice versa.
  const markerText = (m) => (typeof m === 'string' ? [m] : [m?.hant, m?.hans]);

  if (book) {
    const text = book.entries.map((e) => e.zhHant).join('');
    const miss = [];
    for (const c of concepts) {
      for (const needle of c.book ?? []) {
        const forms = markerText(needle).filter(Boolean);
        if (!forms.some((f) => text.includes(f))) miss.push(`${c.id}:${forms[0] ?? JSON.stringify(needle)}`);
      }
    }
    if (miss.length) {
      fail(`lexicon: ${miss.length} book substrings not found in the book -> ${miss.slice(0, 20).join(', ')}`);
    }
  }

  const ids = new Set();
  for (const c of concepts) {
    if (ids.has(c.id)) fail(`lexicon: duplicate concept id "${c.id}"`);
    ids.add(c.id);
    if (!c.book?.length) fail(`lexicon: ${c.id} has no book marker`);
    for (const key of ['book', ...LANGS]) {
      const arr = c[key];
      if (!Array.isArray(arr) || !arr.length) { fail(`lexicon: ${c.id} missing ${key}`); continue; }
      if (key === 'book') {
        // A marker whose two scripts coincide (蛇) legitimately yields the same
        // string twice, so dedupe per marker before checking for duplicates.
        const seen = new Set();
        for (const m of arr) {
          const forms = [...new Set(markerText(m).filter(Boolean))];
          for (const form of forms) {
            if (!form || !String(form).trim()) { fail(`lexicon: ${c.id}.book empty value`); continue; }
            if (/\uFFFD/.test(form)) fail(`lexicon: ${c.id}.book contains U+FFFD`);
          }
          const key = forms.join('/');
          if (seen.has(key)) fail(`lexicon: ${c.id}.book duplicate "${key}"`);
          seen.add(key);
        }
        continue;
      }
      const seen = new Set();
      for (const v of arr) {
        if (typeof v !== 'string' || !v.trim()) { fail(`lexicon: ${c.id}.${key} empty value`); continue; }
        if (seen.has(v)) fail(`lexicon: ${c.id}.${key} duplicate "${v}"`);
        seen.add(v);
        if (/\uFFFD/.test(v)) fail(`lexicon: ${c.id}.${key} contains U+FFFD`);
      }
    }

    // Anchors: surface form -> markers. Validate them like markers, since an
    // anchor pointing at a character the book lacks is dead weight.
    if (book) {
      const text = book.entries.map((e) => e.zhHant).join('');
      for (const [lang, map] of Object.entries(c.anchor ?? {})) {
        if (!LANGS.includes(lang)) fail(`lexicon: ${c.id}.anchor has unknown language "${lang}"`);
        for (const [form, markers] of Object.entries(map)) {
          if (!Array.isArray(markers) || !markers.length) {
            fail(`lexicon: ${c.id}.anchor.${lang}.${form} has no markers`);
            continue;
          }
          for (const m of markers) {
            if (!text.includes(m)) fail(`lexicon: ${c.id}.anchor.${lang}.${form} -> "${m}" not in book`);
          }
        }
      }
    }
  }
  notes.push(`lexicon: ${concepts.length} concepts x ${LANGS.length} languages, book markers verified`);
}

async function checkTranslations(book) {
  if (!book || !existsSync(TRANSLATIONS)) return;
  const ids = new Set(book.entries.map((e) => e.id));
  for (const lang of LANGS) {
    const path = join(TRANSLATIONS, `${lang}.json`);
    if (!existsSync(path)) {
      notes.push(`translations/${lang}.json not present (site falls back to Chinese + AI)`);
      continue;
    }
    const data = await readJson(path);
    if (!data) continue;
    let bad = 0;
    for (const [id, t] of Object.entries(data.entries ?? {})) {
      if (!ids.has(id)) { bad++; continue; }
      if (!t.literal || !t.modern) { fail(`translations/${lang}: ${id} missing literal/modern`); bad++; }
      if (!['good', 'bad', 'mixed'].includes(t.tone)) fail(`translations/${lang}: ${id} bad tone ${t.tone}`);
    }
    const n = Object.keys(data.entries ?? {}).length;
    notes.push(`translations/${lang}: ${n}/${book.entries.length} (${bad} invalid)`);
  }
}

async function main() {
  const book = await readJson(join(ROOT, 'data', 'dreambook.json'));
  await checkI18n();
  await checkBook(book);
  await checkLexicon(book);
  await checkTranslations(book);

  for (const n of notes) console.log(`  ok  ${n}`);
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):`);
    for (const p of problems) console.error(`  !!  ${p}`);
    process.exit(1);
  }
  console.log('\nall data files valid');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
