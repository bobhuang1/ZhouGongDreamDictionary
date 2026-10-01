# 周公解夢 / Zhou Gong Dream Dictionary

A classical Chinese dream book, read in plain language.

Type a dream in your own words. The site finds the passages it corresponds to in
周公解夢 — a dream-interpretation text compiled in China more than a thousand
years ago — and explains them plainly. Seven interface languages: English,
Traditional Chinese, Simplified Chinese, Japanese, Spanish, Russian, French.

The book is public domain. This project is about a public-domain text.

---

## Contents

- [Quick start](#quick-start)
- [Using it in your own project](#using-it-in-your-own-project)
- [How to use the site](#how-to-use-the-site)
- [How the matching works](#how-the-matching-works)
- [The AI layer](#the-ai-layer)
- [Project layout](#project-layout)
- [Scripts](#scripts)
- [Extending it](#extending-it)
- [Data sources](#data-sources)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Quick start

Requires Node 18 or newer. No dependencies, no build step.

```bash
git clone https://github.com/bobhuang1/ZhouGongDreamDictionary.git
cd ZhouGongDreamDictionary
npm start
```

Open <http://localhost:8080>.

To stop: `Ctrl+C`.

**Why a server at all?** The page fetches its JSON with `fetch()`, which browsers
refuse to do from a `file://` path. The Node server exists only to provide a real
origin. The deployed site is fully static and needs no server.

Anything that serves static files works just as well:

```bash
python -m http.server 8080     # Python 3
npx serve .                    # Node, one-off
```

## Using it in your own project

The dictionary is plain static files, so you can take it in three ways.

### 1. Deploy the whole site

Fork the repository, or push it to your own host. Because there is no build
step, any static host works:

- **GitHub Pages** — enable Pages with "GitHub Actions" as the source. A
  workflow already exists in `.github/workflows/deploy.yml`; on a fork it runs
  as soon as you enable Actions. Nothing to configure.
- **Netlify / Cloudflare Pages** — build command: none. Publish directory: `.`
- **Any web server** — copy the files and serve them.

Point your domain at it. There is nothing to compile and no runtime to keep
patched.

### 2. Embed the lookup in your own page

The matcher is a standalone ES module with no dependencies and no network calls.
Import it and drive it yourself:

```html
<script type="module">
  import { searchBook, loadBook } from './assets/matcher.js';

  const book = await loadBook();
  const results = searchBook(book, 'I dreamed of a big white snake', null);

  for (const hit of results.slice(0, 5)) {
    console.log(hit.entry.zhHant, hit.score, hit.reasons);
  }
</script>
```

`searchBook(book, query, translations)` takes the parsed book, the reader's
question, and an optional translations object. Each hit carries the matched
`entry`, a numeric `score`, and a `reasons` array explaining which signals
fired — useful for debugging a query that returns nothing.

`data/dreambook.json` is also usable on its own if you only need the text: 988
entries, each with Traditional and Simplified text, a section id, and a tone
hint.

### 3. Copy just the data

Both JSON files are plain and standalone:

| File | Contents |
| --- | --- |
| `data/dreambook.json` | 988 entries: `zhHant`, `zhHans`, `section`, `toneHint` |
| `data/lexicon.json` | 40 concepts, each with words in 5 languages and character anchors |
| `data/i18n/*.json` | Interface strings, 60 keys per locale |
| `data/translations/*.json` | Per-entry translations, 5 languages (generated) |

GPL-3.0-licensed code, public-domain text. The text is free to reuse.

## How to use the site

1. Type the dream in your own words, in any of the seven languages.
2. Matched entries appear ranked, each showing the Chinese, the tone, the
   translated reading, and keywords.
3. Press **Ask Gemini** for a modern-language interpretation of the matches.
   This needs your own API key, entered in Settings.
4. **Browse** lists everything by section when you would rather look than search.
5. Language and theme both persist across visits.

If a search returns nothing, that is meaningful: the book genuinely has no entry
for it, and the matcher is built to return nothing rather than invent a
plausible-looking neighbour.

## How the matching works

There is no vector database and no retrieval model. The book is 988 short
entries, so the entire problem is getting from "I dreamed of a big white snake"
to the entries filed under 龍蛇禽獸等類 without a network round trip.

Three signals do it, all running in the browser:

1. **Concept matches.** `data/lexicon.json` maps a concept to the word for it in
   every supported language, plus the Chinese characters the book itself indexes
   it under. "Serpent" and 蛇 are the same thing, not merely similar strings.

2. **Anchors.** Knowing a reader wrote "knife" identifies the concept (crime)
   but not which of the book's fourteen crime characters was meant. An anchor
   names the specific one, so 刀 entries win. Without anchors every crime entry
   scores identically and the ranking is arbitrary.

3. **Marker rarity.** The book mentions 人 in about a fifth of its entries and
   龜 in roughly one in a thousand. Matching scales by how rare a character is,
   so the distinctive one carries the result instead of being drowned out.

Chinese questions additionally match on character bigrams against the entry text.

`npm run test:matcher` checks 21 real questions across all seven languages
against the book, including cases where the book has no answer and returning
nothing is the correct result.

## The AI layer

Plain-language readings come from Google Gemini, called directly from the
browser.

You bring your own key from the free tier, entered in Settings and kept in
`localStorage`. It is never sent anywhere except Google's API, and the only
request it attaches to is the one about your dream. That is possible precisely
because a static site has no backend to hold a secret.

The system prompt requires the model to say plainly when the book is ambiguous
or conditional, never to present a verdict as a prediction, and never to give
medical, legal or financial advice. `npm run test:ai` covers the code around the
model — prompt construction, JSON extraction, error mapping, retry and model
fallback — with the network stubbed.

Without a key the site still works fully: it shows the matched Chinese passages
with tone colouring, and the static translations if present.

### Getting an API key

1. Go to <https://aistudio.google.com/apikey>.
2. Sign in with a Google account, then **Create API key**.
3. Paste the key into Settings in the app. It stays in your browser.

## Project layout

```
index.html               static shell, single page
assets/styles.css        responsive, light and dark themes
assets/app.js            wiring: language, theme, rendering, settings
assets/matcher.js        local cross-language retrieval
assets/ai.js             Gemini client, prompt, error handling
server.mjs               static file server for local development
data/dreambook.json      988 entries, Traditional and Simplified
data/lexicon.json        40 concepts x 5 languages, with anchors
data/i18n/*.json         interface strings, 7 locales
data/translations/*.json per-entry translations, 5 languages (generated)
tools/                   fetch, build, translate, validate, test
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm start` | Serve on <http://localhost:8080> |
| `npm test` | Full suite: matcher, AI layer, data validation |
| `npm run test:matcher` | Retrieval tests only |
| `npm run test:ai` | AI layer tests only, network stubbed |
| `npm run validate` | Data integrity only |
| `npm run fetch:source` | Download source texts into `.cache/` |
| `npm run build:book` | Parse and convert into `data/dreambook.json` |
| `npm run build:lexicon` | Add Simplified forms, concepts and anchors |
| `npm run translate` | Generate translations (see below) |
| `npm run translate:status` | Show progress per language |

## Extending it

### Add an interface language

1. Copy `data/i18n/en.json` to `data/i18n/<code>.json` and translate the 60 keys.
2. Add the code to `LOCALES` and `LOCALE_NAMES` in `assets/app.js`.
3. Add that language's words to each concept in `data/lexicon.json`.
4. Add the code to `LANGS` in `tools/validate.mjs`.

No code branches on language, so nothing else changes.

### Add a concept

Add it to `tools/enrich-lexicon.mjs` with its words per language and its anchors,
then `npm run build:lexicon`. The script errors on an unknown concept id rather
than dropping it silently — a silently dropped concept makes every query for it
return nothing, with no other symptom.

### Regenerate the data

```bash
npm run fetch:source     # download both source texts into .cache/
npm run build:book       # parse and convert -> data/dreambook.json
npm run build:lexicon    # add Simplified forms, concepts and anchors
npm test                 # validate everything
```

Wikisource is the parsing source because the simplified site has transcription
errors in several sections. Simplified text is produced by MediaWiki's own
`variant=zh-hans` converter instead of a hand-rolled table, so it matches what
Wikisource displays. The converter is rate-limited, so results are cached in
`.cache/` and a rebuild is free after the first run.

### Generate the translations

The five non-Chinese entry translations are optional and generated:

```bash
export GEMINI_API_KEY=your-key          # Windows PowerShell: $env:GEMINI_API_KEY="..."
npm run translate -- --lang en
npm run translate:status
```

Useful flags: `--limit=N` for a trial run, `--batch=N` (default 25) to size
requests, `--concurrency=N` (default 3) for parallelism, `--from=N` to resume
from an offset. The script is resumable and writes after every batch, so an
interrupted run continues where it stopped.

Override the model with `GEMINI_MODEL`, comma-separated, and it falls back
down the list when one is retired or overloaded:

```bash
export GEMINI_MODEL=gemini-3.6-flash,gemini-3.1-flash-lite
```

With no translations present the site falls back to the Chinese passages and the
AI reading, so nothing breaks.

**On quality:** do not reach for free machine translation to build these files.
On this text it fails badly. 主 is the classical subject marker meaning "the
dreamer", but MT reads it as "landlord" or "master", and the verdict vocabulary
gets transliterated as invented names — 耕地主大吉利 becomes "the arable
landlord Dajili". The seven-character formulaic entries have no modern syntax for
MT to latch onto. An LLM handles them correctly because it can read 主 as a
particle and 大吉利 as a verdict.

## Data sources

- 周公解夢, Chinese Wikisource — the parsed text
  <https://zh.wikisource.org/wiki/%E5%91%A8%E5%85%AC%E8%A7%A3%E5%A4%A2>
- The same book in Simplified Chinese
  <https://www.zhouyi.cc/jiemeng/yuanbanJm/>

## Disclaimer

周公解夢 is folklore written down over centuries, not science, and it does not
predict the future. Nothing here is medical, psychological, legal or financial
advice. If a dream concerns illness, anxiety or danger, talk to someone who can
actually help.

## License

This project is free software, released under the **GNU General Public License v3.0**. You may redistribute and/or modify it under those terms; see [LICENSE.md](LICENSE.md) for the full text.
