/**
 * Add a `hans` field to every concept marker in data/lexicon.json.
 *
 * The book carries both scripts, but the lexicon markers were hand-written in
 * Traditional Chinese, so a Simplified-Chinese question like 龙的梦 could not
 * match the marker 龍. Rather than maintain two lists by hand, convert them
 * with MediaWiki's own variant converter -- the same source of truth used by
 * build-book.mjs -- and cache the result.
 *
 * Usage: node tools/simplify-lexicon.mjs
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON = join(ROOT, 'data', 'lexicon.json');
const CACHE = join(ROOT, '.cache', 'zh-hans');
const API = 'https://zh.wikisource.org/w/api.php';
const UA = 'zhouyi-build/1.0 (local dataset build; contact: local user)';
const BATCH = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** MediaWiki rate-limits aggressively, so conversion is retried with backoff
 *  and results are cached on disk to make rebuilds free. */
async function convertBatch(lines, cachePath) {
  const cached = await readFile(cachePath, 'utf8').then(JSON.parse).catch(() => null);
  if (cached) return cached;

  // One marker per line; a line break is what splits the reply back apart.
  const packed = lines.join('\n');
  const url =
    `${API}?action=parse&format=json&prop=text&variant=zh-hans` +
    `&contentmodel=wikitext&text=${encodeURIComponent(packed)}`;

  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const json = await res.json();
      const html = json.parse.text['*'].replace(/<!--[\s\S]*?-->/g, '');
      const body = html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n');
      const converted = body
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      if (converted.length !== lines.length) {
        throw new Error(
          `conversion split ${converted.length} ways, expected ${lines.length}: ` +
          JSON.stringify(converted).slice(0, 200),
        );
      }
      await mkdir(dirname(cachePath), { recursive: true });
      await writeFile(cachePath, JSON.stringify(converted), 'utf8');
      return converted;
    }
    if (res.status !== 429 && res.status < 500) {
      throw new Error(`variant conversion failed: ${res.status} ${res.statusText}`);
    }
    const wait = 3000 * 2 ** attempt;
    console.log(`  rate limited (${res.status}), retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error('variant conversion failed after 6 attempts (still rate limited)');
}

async function toSimplified(items, cacheKey) {
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const cachePath = join(CACHE, `${cacheKey}-${i / BATCH}.json`);
    const converted = await convertBatch(slice, cachePath);
    converted.forEach((v, k) => { out[i + k] = v; });
  }
  return out;
}

async function main() {
  const lexicon = JSON.parse(await readFile(LEXICON, 'utf8'));

  const all = lexicon.concepts.flatMap((c) => c.book ?? []);
  const unique = [...new Set(all)];
  console.log(`converting ${unique.length} distinct markers...`);
  const simplified = await toSimplified(unique, 'lexicon');
  const map = new Map(unique.map((m, i) => [m, simplified[i]]));

  // Markers become objects so both scripts are searchable in the matcher.
  for (const concept of lexicon.concepts) {
    concept.book = (concept.book ?? []).map((m) => {
      const hans = map.get(m);
      return hans && hans !== m ? { hant: m, hans } : { hant: m, hans: m };
    });
  }
  lexicon.meta.markerScripts = 'each marker is { hant, hans }';

  await writeFile(LEXICON, JSON.stringify(lexicon, null, 2), 'utf8');
  const changed = unique.filter((m) => map.get(m) !== m).length;
  console.log(`wrote ${LEXICON} (${changed}/${unique.length} markers differ from traditional)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}