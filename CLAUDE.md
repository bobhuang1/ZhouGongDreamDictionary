# CLAUDE.md

Context for working in this repository. Read this before changing anything.

## What this is

A static, zero-dependency, no-build web app for 周公解夢 (Zhougong Jie Meng), a
classical Chinese dream-interpretation book. A reader types a dream in any of
seven languages and gets the matching book entries plus a plain-language
reading.

Public repo: `bobhuang1/ZhouGongDreamDictionary`, deployed to
<https://bobhuang1.github.io/ZhouGongDreamDictionary/>.

## Hard constraints

These are design decisions, not preferences. Do not casually reverse them.

1. **No dependencies.** `package.json` has no `dependencies` and no
   `devDependencies`. Node 18+ standard library only.
2. **No build step.** `index.html` loads ES modules directly. There is no
   bundler, no transpiler, no framework. If a change seems to require a build,
   the design is wrong — restructure it instead.
3. **No backend.** Retrieval and translation both happen in the browser. Gemini
   is called directly with a reader-supplied key held in `localStorage`. Never
   introduce a server component that holds a secret.
4. **No vector database, no embeddings, no retrieval model.** 988 entries are
   small enough for deterministic matching. This is the central technical claim.
5. **The book is public domain; the code is MIT.** Keep them separate. A modern
   translation or commentary scraped from elsewhere may not be — do not import
   one without checking.
6. **Never commit an API key.** `.gitignore` covers the obvious cases. The key
   used during development was pasted into a chat transcript and is considered
   compromised; it is not in the repo and must not be.

## Layout

```
index.html                 static shell
assets/matcher.js          retrieval: concepts + anchors + rarity + bigrams
assets/ai.js               Gemini client, prompt, retry, model fallback
assets/app.js              UI wiring, language, theme, rendering
assets/styles.css          light/dark, responsive
server.mjs                 static server, local dev only
data/dreambook.json        988 entries, generated — do not hand-edit
data/lexicon.json         40 concepts x 5 languages — generated, extend the tool
data/i18n/*.json          7 locales, 60 keys each
data/translations/*.json  generated per-entry translations
tools/*.mjs               fetch, build, translate, validate, test
```

`data/dreambook.json` and `data/lexicon.json` are generated. Change
`tools/build-book.mjs` or `tools/enrich-lexicon.mjs`, never the JSON.

## Commands

```bash
npm test                # matcher + AI + validate; run before committing
npm run test:matcher    # 21 retrieval cases, 7 languages
npm run test:ai         # AI layer, network stubbed
npm run validate        # data integrity only
npm start               # localhost:8080
```

CI (`.github/workflows/test.yml`) runs `npm test`; `deploy.yml` publishes to
GitHub Pages. Deploys need Pages enabled with "GitHub Actions" as the source —
if a deploy fails with "Get Pages site failed", enable it via
`gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow`, then re-run.

## Retrieval design

`searchBook(book, query, translations)` returns hits with `entry`, `score`, and
`reasons`. Three signals, in the order they matter:

1. **Concepts** (`data/lexicon.json`) — 40 concepts, each mapping to a word per
   language plus the Chinese characters the book indexes it under.
2. **Anchors** — map a surface word to the *specific* book character. "knife"
   alone identifies the crime concept, whose 14 single-character markers then
   score identically and rank arbitrarily; the anchor for 刀 breaks the tie.
3. **Marker rarity** — scale by character frequency, since 人 appears in a fifth
   of entries and 龜 in one of a thousand.

Chinese queries also match character bigrams against entry text.

### Two bugs that already bit, and their shape

Both were silent — the matcher produced plausible output while being wrong:

- **`marker.length` on an object.** Lexicon markers changed from strings to
  `{hant, hans}` objects so both scripts could be indexed. `length` became
  `undefined`, and one `includes()` call self-matched, so every entry matched
  every concept. Ranking looked reasonable and was entirely arbitrary.
- **`renderResults(found, passages)` reading `found.length`** when `found` was
  the result *object* rather than the array, so it always rendered the empty
  state.

When touching the matcher or renderer, check the types at the boundary. A
plausible-looking ranking is not evidence of correctness.

## Source data

Parsing source is Chinese Wikisource: the simplified edition at zhouyi.cc has
transcription errors in several sections, so it is used only as a Simplified-text
source. Simplified text is generated through MediaWiki's own
`variant=zh-hans` converter rather than a hand-rolled table.

The corpus is formulaic: every entry is `[subject][verdict]`, around 7
characters. Roughly half the entries carry an explicit verdict marker (主 281,
有 102, 者主 70, 主有 34); the other half has no marker at all, e.g.
`天門開貴人薦引`. Verified counts — 423 distinct subjects, 487 distinct verdicts,
and against all 988 entries the cumulative curve is 60 verdicts → 7%, 150 → 16%,
300 → 31%. So a curated verdict glossary alone cannot cover the book; treat it
as an optimisation, never as the primary mechanism.

## Translations

Five non-Chinese languages: `en`, `ja`, `es`, `ru`, `fr`. Generated by
`tools/translate-batch.mjs`, resumable, writes after every batch.

```bash
export GEMINI_API_KEY=your-key
npm run translate -- --lang en
npm run translate:status
```

Each entry gets `literal`, `modern`, `tone`, `keywords`. Tone is judged from the
book's own verdict, not from the subject.

### Model versions

`gemini-2.5-flash` is **retired for new API keys** — it returns HTTP 404,
"no longer available to new users". This was the original cause of the batch
translation appearing to fail; the key was fine, the model was dead.

Both `assets/ai.js` and `tools/translate-batch.mjs` now use a fallback list,
defaulting to `gemini-3.6-flash` then `gemini-3.1-flash-lite`, overridable with
`GEMINI_MODEL`. The 3.7/3.8 models answer but return intermittent 503s under
load, so they are not the default despite being newer. Both layers advance down
the list on 404 or 5xx.

### Do not use free machine translation here

Verified against MyMemory on this corpus. It fails structurally:

| Chinese | MT output | Correct |
| --- | --- | --- |
| 耕地主大吉利 | "Dreaming of the arable landlord Dajili" | plowing a field — great fortune |
| 主大吉 | "Lord Dae-gil" | great good fortune |
| 主疾病除 | "Main Disease Exclusion" | illness leaves you |

主 is the classical subject marker meaning "the dreamer"; MT reads it as
"landlord/master". Verdict vocabulary gets transliterated as invented names.
Seven-character formulaic entries give MT no modern syntax to work with. An LLM
gets these right because it reads 主 as a particle and 大吉利 as a verdict.

### Quota

The development key ran on the free tier and hit HTTP 429 around 206/988 in
English. The script backs off exponentially and is resumable, so a rate-limited
run loses no work — restart it and it continues. For a full 5-language run
(4,940 entries), expect to either add a billing account
(<https://aistudio.google.com/billing>) or run in sessions and resume.

## Testing expectations

`npm test` must pass before committing. The AI tests stub the network and assert
on prompt construction, JSON extraction, error mapping, key handling, and
retry/fallback behaviour.

Some test expectations are deliberately *not* what naive intuition suggests,
because the book disagrees: it writes teeth as 齒 not 牙, files money under 財,
and has no entry for falling off a building. When a retrieval test fails,
check the book before changing the matcher — one case asserts that zero results
is correct, and inventing a match would be a regression.

`tools/validate.mjs` catches the specific breakages that happened during
development: i18n key drift, stray Latin words inside CJK text, HTML tags or
replacement characters from botched edits, entries referencing missing sections,
lexicon `book` substrings that no longer occur in the text, and translation
files referencing entry ids that do not exist.

## Tone and safety

The book is folklore, not science, and the app must not imply otherwise. The
system prompt requires the model to state plainly when the book is ambiguous or
conditional, never to present a verdict as a prediction, and never to give
medical, legal, psychological or financial advice. Preserve that framing in any
prompt change.

## Open items

- Translations are partial; see `npm run translate:status`. Coverage is
  recorded per language in each file's `meta.entryCount` / `meta.complete`.
- Optional translation loads log 404s in the console when a language file is
  absent. The app handles this correctly, but the noise is ugly — a fetcher that
  treats 404 as "no translations" rather than an error would be cleaner.
- The prior `www.zhouyi.cc` reference in `README.md` and book metadata was
  flagged for review against the "do not link the reference site" instruction.
  It is currently still present and unresolved.