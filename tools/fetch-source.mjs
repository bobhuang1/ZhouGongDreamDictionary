/**
 * Download the raw source text of 周公解夢 into tools/.cache/.
 *
 * Two independent sources, so the build can cross-check itself:
 *   - zh.wikisource.org  -> traditional Chinese (source of truth for parsing)
 *   - www.zhouyi.cc      -> simplified Chinese
 *
 * Usage: node tools/fetch-source.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'tools', '.cache');
const UA = 'ZhouGongDreamDictionary/0.1 (open-source educational demo)';

export const SOURCES = {
  'zh-hant': 'https://zh.wikisource.org/w/index.php?title=%E5%91%A8%E5%85%AC%E8%A7%A3%E5%A4%A2&action=raw',
  'zh-hans': 'https://www.zhouyi.cc/jiemeng/yuanbanJm/',
};

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
  return res.text();
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  for (const [name, url] of Object.entries(SOURCES)) {
    const body = await get(url);
    await writeFile(join(CACHE, `${name}.raw`), body, 'utf8');
    console.log(`${name.padEnd(8)} ${String(body.length).padStart(8)} bytes  <- ${url}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
