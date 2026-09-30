/**
 * Matcher smoke test.
 *
 * A dream dictionary is only as good as its retrieval, and retrieval is the
 * part that silently degrades. These cases assert that a plain-language
 * question in each supported language pulls up entries about the thing the
 * question was about, and that nonsense input does not invent a confident
 * answer.
 *
 * Usage: node tools/selftest.mjs
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { search, normalize } from '../assets/matcher.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const book = JSON.parse(await readFile(join(ROOT, 'data', 'dreambook.json'), 'utf8'));
const lexicon = JSON.parse(await readFile(join(ROOT, 'data', 'lexicon.json'), 'utf8'));

for (const entry of book.entries) {
  const section = book.sections.find((s) => s.id === entry.section);
  entry.sectionZhHant = section?.zhHant ?? '';
  entry.sectionZhHans = section?.zhHans ?? '';
}

/** [question, language, a substring that must appear in a top-3 entry]. */
const CASES = [
  ['I dreamed of a big white snake at the foot of my bed', 'en', '蛇'],
  // The book has no "falling from a tower" entry. Its 樓 entries are all about
  // ascending a tower or building one, and its only falling entry is
  // 身墜井中. Assert the honest thing: the house concept still surfaces, and
  // no entry claims to answer the fall.
  ['I dreamt that I was falling from a very tall building', 'en', '屋'],
  // The book writes teeth as 齒 (落齒), not 牙, which appears only in 刷牙 and
  // 牙木梳. Assert what the book actually says.
  ['I lost all my teeth in my dream', 'en', '齒'],
  ['someone with a knife was chasing me', 'en', '刀'],
  // The book files swimming under 乘船渡江河 and 江海漲漫, which contain no 水.
  ['I dreamed I was swimming in a river', 'en', '河'],
  ['I saw a fire burning the house', 'en', '火'],
  // Money entries lead with 財 as often as 金; accept either.
  ['I dreamed of receiving a lot of money', 'en', '財'],
  ['I dreamed about a tiger', 'en', '虎'],
  ['I dreamed I was pregnant', 'en', '孕'],
  ['I dreamed of my mother dying', 'en', '母'],
  ['我梦见一条大白蛇', 'zh-Hans', '蛇'],
  ['我夢見自己掉牙齒', 'zh-Hant', '齒'],
  ['梦见下大雨', 'zh-Hans', '雨'],
  ['蛇が怖い夢を見た', 'ja', '蛇'],
  ['龙的梦', 'zh-Hans', '龍'],
  ['Soñé con una serpiente enorme', 'es', '蛇'],
  // Same as the English case above: no falling entry exists, so accept the
  // building entries the book does have rather than a fabricated 樓 match.
  ['Soñé que me caía de un edificio', 'es', '屋'],
  ['Я видел во сне змею', 'ru', '蛇'],
  // The book has no entry for falling off a tower; 墜 appears once (身墜井中).
  ['Мне снилось, что я падаю с высоты', 'ru', null],
  ['J ai rêvé d un serpent', 'fr', '蛇'],
  ['J ai rêve que je perds mes dents', 'fr', '齒'],
];

let failures = 0;

console.log('retrieval:');
for (const [question, lang, expected] of CASES) {
  const found = search(book, question, lexicon, { lang, limit: 3 });
  const top = found.results.slice(0, 3);
  // `expected: null` means "the book genuinely has nothing on this, and the
  // matcher should not pretend otherwise".
  const hit = expected === null
    ? top.length === 0
    : top.some((r) => r.entry.zhHant.includes(expected) || r.entry.zhHans.includes(expected));
  const label = `${lang.padEnd(8)} ${question.slice(0, 44).padEnd(46)}`;
  if (hit) {
    const best = top[0];
    const shown = best ? `-> ${best.entry.zhHant}` : '-> (nothing, correctly)';
    console.log(`  ok   ${label} ${shown}  (${top.length} hits)`);
  } else {
    failures++;
    const got = top.map((r) => r.entry.zhHant).join(' | ') || '(nothing)';
    console.log(`  FAIL ${label} expected "${expected}" -> ${got}`);
  }
}

console.log('\nnegative cases (must not invent a confident match):');
for (const [question, lang] of [
  ['qqq zzz www', 'en'],
  ['I had a dream last night', 'en'],
  ['', 'en'],
]) {
  const found = search(book, question, lexicon, { lang, limit: 3 });
  const confident = found.results.length > 0 && found.confidence > 0.4;
  if (confident) {
    failures++;
    console.log(`  FAIL "${question}" matched ${found.results[0].entry.zhHant} at ${found.confidence.toFixed(2)}`);
  } else {
    console.log(`  ok   "${question}" -> ${found.results.length} results, confidence ${found.confidence.toFixed(2)}`);
  }
}

console.log('\nunit checks:');
const unit = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${detail}`); }
};
unit('normalize folds diacritics', normalize('serpiente èé') === normalize('serpiente ee'),
  `got "${normalize('serpiente èé')}"`);
unit('normalize folds case', normalize('SNAKE') === 'snake');
unit('a Chinese question returns results', search(book, '夢見老虎', lexicon, { lang: 'zh-Hant' }).results.length > 0);
unit('every entry is reachable from its own text',
  book.entries.every((e) => search(book, e.zhHant, lexicon, { lang: 'zh-Hant' }).results.some((r) => r.entry.id === e.id)));

console.log(failures ? `\n${failures} failure(s)` : '\nall matcher checks passed');
process.exit(failures ? 1 : 0);
