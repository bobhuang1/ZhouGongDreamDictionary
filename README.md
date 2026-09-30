# Zhou Gong Dream Dictionary

A classical Chinese dream book, read in plain language.

Type a dream in your own words and it finds the relevant passages in 周公解夢 —
a dream-interpretation book compiled in China more than a thousand years ago —
and explains them in plain language. Seven interface languages: English,
Traditional Chinese, Simplified Chinese, Japanese, Spanish, Russian, French.

The book is public domain. This is a demo project about a public-domain text.

## Try it

```bash
git clone https://github.com/<owner>/ZhouGongDreamDictionary.git
cd ZhouGongDreamDictionary
npm start            # http://localhost:8080
```

There is no build step and there are no dependencies. Node 18+ is used only to
serve the files locally; the deployed site is static and needs no server at all.

A server is needed locally because the page fetches its data files, which
browsers refuse to do from `file://`. On GitHub Pages this is already handled.

## How the matching works

There is no vector database and no retrieval model. The book is only 988 short
entries, so the whole question is whether you can get from "I dreamed of a big
white snake" to the entries under 龍蛇禽獸等類 without a round trip.

Three signals do it, all in the browser:

1. **Concept matches.** `data/lexicon.json` maps a concept to the word for it in
   every supported language, plus the Chinese characters the book itself indexes
   it under. "Serpent" and 蛇 are the same thing, not similar strings.
2. **Anchors.** Knowing a reader said "knife" identifies the concept (crime) but
   not which of the book's fourteen crime characters was meant. An anchor names
   the specific one, so 刀 entries win. Without this every crime entry scores
   identically and the ranking is arbitrary.
3. **Marker rarity.** The book mentions 人 in a fifth of its entries and 龜 in
   one of a thousand. Matching is scaled by how rare a character is, so the
   distinctive one carries the result.

Chinese questions additionally match on character bigrams against the entry text.

`npm run test:matcher` checks 21 real questions across all seven languages
against the book, including cases where the book genuinely has no answer and the
matcher is expected to return nothing rather than invent something.

## The AI layer

The plain-language reading comes from Google Gemini 2.5 Flash, called directly
from the browser.

You bring your own key, from the free tier, entered in the interface and kept in
`localStorage`. It is never sent anywhere except to Google's API, and the only
request it is attached to is the one asking about your dream. This is possible
because a static site has no backend to hold a secret.

The system prompt requires the model to state plainly when the book is ambiguous
or conditional, never to present a verdict as a prediction, and never to give
medical, legal or financial advice. `npm run test:ai` covers the code around the
model — prompt construction, JSON extraction, error mapping, retry policy — with
the network stubbed.

Without a key the site still works: it shows the matched Chinese passages with
heuristic tone colouring and no interpretation.

## Layout

```
index.html            static shell, one page
assets/styles.css     responsive, light and dark
assets/app.js         wiring: language, theme, rendering
assets/matcher.js     local cross-language retrieval
assets/ai.js          Gemini client, prompt, error handling
server.mjs            static file server for local use
data/dreambook.json   988 entries, Traditional and Simplified
data/lexicon.json     40 concepts x 5 languages, with anchors
data/i18n/*.json      interface strings, 7 locales
data/translations/    per-entry AI translations, 5 languages (generated)
tools/                fetch, build, translate, validate, test
```

## Adding a language

1. Copy `data/i18n/en.json` to `data/i18n/<code>.json` and translate the 60 keys.
2. Add the code to `LOCALES` and `LOCALE_NAMES` in `assets/app.js`.
3. Add the language's words to each concept in `data/lexicon.json`.
4. If the language is not space-delimited, or needs anchors, extend
   `tools/enrich-lexicon.mjs` and re-run `npm run build:lexicon`.
5. Add the code to `LANGS` in `tools/validate.mjs`.

Nothing else changes; no code branches on language.

## Regenerating the data

```bash
npm run fetch:source     # download both source texts into .cache/
npm run build:book       # parse and convert -> data/dreambook.json
npm run build:lexicon    # add Simplified forms, concepts and anchors
npm test                 # validate everything
```

Wikisource is the parsing source because the simplified site has transcription
errors in several sections. Simplified text is produced by MediaWiki's own
`variant=zh-hans` converter rather than a hand-rolled table, so it matches what
Wikisource shows.

Rebuilding calls the MediaWiki API, which rate-limits aggressively. Results are
cached in `.cache/`, so a rebuild is free after the first run.

## Translating every entry

```bash
export GEMINI_API_KEY=your-key
npm run translate -- --lang en
npm run translate:status
```

The batch translator is resumable and saves after every batch, so an interrupted
run continues where it stopped. It covers the five non-Chinese languages; the
Chinese locales use the source text directly.

Generated translations are optional. Without them the site falls back to the
Chinese passages, and the AI reading still works.

## Disclaimer

周公解夢 is folklore written down over centuries, not science, and it does not
predict the future. Nothing here is medical, psychological, legal or financial
advice. If a dream is about illness, anxiety or danger, talk to someone who can
actually help.

## Sources

- 周公解夢 on Chinese Wikisource — the parsed text
  <https://zh.wikisource.org/wiki/%E5%91%A8%E5%85%AC%E8%A7%A3%E5%A4%A2>
- The same book in Simplified Chinese
  <https://www.zhouyi.cc/jiemeng/yuanbanJm/>

## License

Code: MIT. The book itself: public domain.