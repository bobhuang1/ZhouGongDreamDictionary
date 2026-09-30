/**
 * Parse the 周公解夢 wikitext into data/dreambook.json.
 *
 * Source of truth: zh.wikisource.org (traditional). Simplified Chinese is
 * produced by MediaWiki's own zh-hans variant converter, so the two scripts
 * stay mechanically consistent instead of drifting through a hand-rolled
 * character map.
 *
 * Usage: node tools/build-book.mjs
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'tools', '.cache');
const OUT = join(ROOT, 'data', 'dreambook.json');
const UA = 'ZhouGongDreamDictionary/0.1 (open-source educational demo)';
const API = 'https://zh.wikisource.org/w/api.php';

export const SOURCE_LINKS = {
  'zh-hant': 'https://zh.wikisource.org/wiki/周公解夢',
  'zh-hans': 'https://www.zhouyi.cc/jiemeng/yuanbanJm/',
};

/** Legacy lexicons, kept only so `tools/validate.mjs` can report how many
 *  entries would classify cleanly. Tone is NOT derived from them: the verdict
 *  of a classical entry is genuinely ambiguous ("百憂去" = all worries leave,
 *  yet it contains the character for worry), so tone comes from the AI
 *  translation pass instead. See tools/translate-batch.mjs. */
const AUSPICIOUS = [
  '大吉', '吉昌', '吉利', '吉祥', '大吉昌', '主吉', '吉慶', '百事歡悅', '所求皆得',
  '富貴', '大富', '主富', '貴子', '貴侯王', '貴王侯', '公卿', '官位至', '官職遷',
  '位王侯', '高官', '重位', '福緣', '福祿', '壽命吉', '長命', '添子', '添孫',
  '有喜', '喜事', '有慶', '財喜', '得財', '大發財', '求財', '利祿', '大財',
  '衣錦', '榮', '遷', '進祿', '生貴子', '生賢子', '子孫興', '子孫安', '興子孫',
  '結親', '得貴婦', '得妻', '妻有子', '有子', '病除', '病愈', '病思除', '病欲痊',
  '壽', '安樂', '安穩', '無憂', '大安', '平穩', '利祿', '事事成', '萬事成',
  '百事遂', '百事成', '遂意', '得意', '開心', '歡喜', '歡悅', '有福', '富足', '豐',
  '出行', '遠信至', '信至', '得人', '得貴人', '薦引', '有官職', '主官職', '升官',
  '名揚', '顯揚', '名利', '和睦', '和合', '平安', '安寧', '清吉', '成事', '做成',
];
const INAUSPICIOUS = [
  '大凶', '主凶', '凶事', '不吉', '不利', '大不利', '凶', '喪事', '主喪', '喪',
  '死', '死亡', '病死', '病', '疾', '病來', '病欲來', '不利祿', '失位', '失利',
  '貧', '破', '破財', '敗', '不成', '不成事', '事不成', '有憂', '憂', '憂疑', '愁',
  '哭', '悲哀', '泣', '訟', '訟事', '官訟', '訟獄', '囚', '獄', '捕', '禁', '罰',
  '刑', '刀杖', '刀傷', '傷', '殺', '殺害', '被打', '打罵', '受辱', '恥辱', '凌辱',
  '災', '火燒', '水災', '火災', '盜', '賊', '偷', '失物', '遺失', '走失', '逃',
  '離', '別', '分離', '散', '分散', '不和', '爭', '鬥', '鬧', '罵', '怒', '恨',
  '休妻', '休書', '離異', '孕婦', '流產', '小產', '墮胎', '服喪', '孝服', '哭喪',
  '棺', '墓', '墳', '塚', '入殮', '不祥', '不利祿位', '退', '罷', '失', '落', '隕',
  '空', '虛', '無功', '徒', '枉', '難', '苦', '疼', '痛', '瘡', '傷殘', '殘', '廢',
  '暗', '晦', '黑', '赤', '妖', '鬼', '邪', '祟', '禍', '殃', '擾', '驚恐', '恐怕',
];

function heuristicTone(text) {
  const tail = text.slice(-5);
  const count = (list) => list.filter((w) => tail.includes(w)).length;
  const bad = count(INAUSPICIOUS);
  const good = count(AUSPICIOUS);
  if (good && bad) return 'mixed';
  if (bad) return 'bad';
  if (good) return 'good';
  return 'mixed';
}

/** Stable, URL-safe id from the entry text. Collisions get a numeric suffix. */
function slug(text, seen) {
  const base = text.replace(/\s+/g, '');
  let id = base;
  let n = 2;
  while (seen.has(id)) id = `${base}-${n++}`;
  seen.add(id);
  return id;
}

/** Parse the wikitext into ordered sections of bare entries. */
export function parseWikitext(raw) {
  const sections = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^==+\s*(.+?)\s*==+$/);
    if (heading) {
      current = { title: heading[1].trim(), items: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const text = line.trim();
    if (!text) continue;
    for (const item of text.split(/[\u3000\u0020]+/).filter(Boolean)) {
      if (/^[一二三四五六七八九十]+、/.test(item)) continue;
      // Strip wiki templates/refs (e.g. the trailing {{Pd-old}} tag) and
      // drop anything left behind, so only real entries reach the book.
      const clean = item.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\[\[|\]\]/g, '').trim();
      if (!clean) continue;
      if (!/[\u3400-\u9fff]/.test(clean)) continue;
      current.items.push(clean);
    }
  }
  return sections;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MARKER = /\u3007(\d+)\u3007/;

/**
 * MediaWiki is free to wrap a long paragraph across several output lines, so
 * one input line does not reliably come back as one output line. Each entry is
 * therefore sent with a numeric marker and reassembled here on markers, which
 * survives arbitrary wrapping.
 */
function pack(items) {
  return items.map((t, i) => `\u3007${i}\u3007${t}`).join('\n');
}

function reassemble(body) {
  const out = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(MARKER).filter((p) => p !== '');
    if (parts.length === 0) continue;
    if (parts.length === 1) {
      // Continuation of the previous entry: Chinese has no spaces, so a
      // wrapped line simply appends.
      if (out.length === 0) continue;
      out[out.length - 1] += parts[0];
      continue;
    }
    // split() on a marker regex yields [text, index, text, index, ...],
    // so every odd slot is the entry that follows its marker.
    for (let i = 1; i < parts.length; i += 2) out.push(parts[i] ?? '');
  }
  return out;
}

/** MediaWiki rate-limits aggressively, so conversion is retried with backoff
 *  and results are cached on disk to make rebuilds free. */
async function convertBatch(text, cachePath) {
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  } catch { /* cache miss */ }

  const url =
    `${API}?action=parse&format=json&prop=text&variant=zh-hans` +
    `&contentmodel=wikitext&text=${encodeURIComponent(text)}`;
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const json = await res.json();
      const html = json.parse.text['*'].replace(/<!--[\s\S]*?-->/g, '');
      // MediaWiki appends a license container and other furniture after the
      // article body; only the first paragraph is our converted text.
      const first = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (!first) throw new Error('variant conversion returned no paragraph');
      const body = first[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n');
      const converted = reassemble(body);
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

/** Batch-convert traditional -> simplified through MediaWiki's own converter. */
async function toSimplified(items, cacheKey) {
  const BATCH = 40;
  const out = new Array(items.length);
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    const cachePath = join(CACHE, 'zh-hans', `${cacheKey}-${i / BATCH}.json`);
    const converted = await convertBatch(pack(slice), cachePath);
    if (converted.length !== slice.length) {
      throw new Error(
        `conversion length mismatch at ${i}: expected ${slice.length}, got ${converted.length}`,
      );
    }
    converted.forEach((v, k) => { out[i + k] = v; });
    if (cacheKey === 'entries') {
      process.stdout.write(`  simplified ${Math.min(i + BATCH, items.length)}/${items.length}\r`);
    }
  }
  return out;
}

async function main() {
  const raw = await readFile(join(CACHE, 'zh-hant.raw'), 'utf8');
  const sections = parseWikitext(raw);
  const flat = sections.flatMap((s, si) => s.items.map((text) => ({ text, si })));
  console.log(`parsed ${sections.length} sections, ${flat.length} entries`);
  if (flat.length < 500) throw new Error(`suspiciously few entries: ${flat.length}`);

  console.log('converting to simplified Chinese via MediaWiki variant=zh-hans...');
  const simplified = await toSimplified(flat.map((e) => e.text), 'entries');
  process.stdout.write('\n');

  const seen = new Set();
  const book = {
    meta: {
      title: '周公解夢',
      titleSimplified: '周公解梦',
      author: '周公旦',
      dynasticContext: 'Zhou dynasty, compiled by later authors in the Duke of Zhou\u2019s name',
      source: 'zh.wikisource.org',
      sources: SOURCE_LINKS,
      entryCount: flat.length,
      sectionCount: sections.length,
      license: 'public domain',
      generatedBy: 'tools/build-book.mjs',
    },
    sections: sections.map((s, si) => ({
      id: si + 1,
      zhHant: s.title,
      count: s.items.length,
    })),
    // `toneHint` is an unverified heuristic used only to colour the no-key
    // fallback. Authoritative tone arrives with the AI translation pass and
    // overwrites it. See data/translations/<lang>.json.
    entries: flat.map((e, i) => ({
      id: slug(e.text, seen),
      zhHant: e.text,
      zhHans: simplified[i],
      section: e.si + 1,
      toneHint: heuristicTone(e.text),
    })),
  };

  // Section titles need simplified too; convert them in one extra call.
  const titles = await toSimplified(sections.map((s) => s.title), 'sections');
  book.sections.forEach((s, i) => { s.zhHans = titles[i]; });

  const tones = book.entries.reduce((acc, e) => {
    acc[e.toneHint] = (acc[e.toneHint] || 0) + 1;
    return acc;
  }, {});
  book.meta.toneCounts = tones;
  console.log('tones:', tones);

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(book, null, 0), 'utf8');
  const kb = (JSON.stringify(book).length / 1024).toFixed(1);
  console.log(`wrote ${OUT} (${kb} kB, ${book.entries.length} entries)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
