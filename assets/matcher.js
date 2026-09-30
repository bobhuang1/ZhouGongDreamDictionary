/**
 * Local matcher.
 *
 * The whole book is ~988 short entries, so there is nothing to embed. What is
 * needed is a way to take "I dreamed of a big white snake by my bed", typed in
 * any of the supported languages, and land on the Chinese entries that talk
 * about snakes.
 *
 * Two signals do that work:
 *
 *   1. Concept hits. data/lexicon.json maps a concept to its surface form in
 *      every language plus the Chinese substrings it appears under in the book.
 *      A hit is a strong signal because "serpent" in French and 蛇 in the text
 *      are the same thing, not similar strings.
 *
 *   2. Direct text. Chinese questions are matched with character bigrams
 *      against the entry text, and any language is matched against the
 *      translation keywords when a translation file is present.
 *
 * Scores are combined and lightly normalised so that a dream with three
 * concepts beats one with a single incidental word match. Everything runs in
 * the browser; no network call, no key needed.
 */

const CJK = /[\u3400-\u9fff]/;

/** Fold case and strip diacritics so "serpiente" matches "serpiente"/"sérpent". */
export function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Big Jamo and compatibility forms never appear in user input but do in text. */
function foldHangul(text) {
  return text.normalize('NFC');
}

function hasCjk(text) {
  return CJK.test(text);
}

/** Character bigrams: a cheap, dependency-free stand-in for word segmentation. */
function bigrams(text) {
  const chars = [...foldHangul(text).replace(/\s+/g, '')];
  if (chars.length === 1) return chars;
  const out = [];
  for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/**
 * Characters that carry so little meaning on their own that a match on them is
 * evidence of nothing. 一 in 一条 ("a white snake") is a counter, not a sign of
 * loneliness; 自 in 自落 is a reflexive pronoun, not loneliness either.
 */
const WEAK_CHARS = new Set([
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '百', '千', '萬',
  '之', '不', '也', '者', '中', '大', '小', '多', '少', '上', '下', '左', '右',
  '前', '後', '人', '天', '日', '月', '年', '時', '事', '物', '生', '子', '自',
  '失', '空', '散', '走', '立', '坐', '見', '聞', '來', '去', '出', '入', '得',
  '我', '你', '他', '她', '它', '這', '那', '家', '好', '和', '與', '及', '或',
]);

/**
 * Markers are { hant, hans } objects, produced by tools/simplify-lexicon.mjs.
 * These helpers keep the matching code from caring.
 */
function markerForms(marker) {
  return marker.hans === marker.hant ? [marker.hant] : [marker.hant, marker.hans];
}

/** Is this marker a word-like token, or a character we should distrust alone? */
function isWeakMarker(marker) {
  return marker.hant.length === 1 && WEAK_CHARS.has(marker.hant);
}

/**
 * Find the lexicon concepts a question refers to.
 * Returns [{ id, weight, matchedForms, book, anchors }].
 *
 * Latin-script and kana forms are matched as whole words. CJK markers are
 * matched as substrings, because Chinese is written without spaces, but
 * single characters that are also common function words only count when the
 * query is short enough that the character cannot be part of a longer word.
 *
 * `anchors` is the useful part for non-Chinese input: knowing "the reader said
 * knife" identifies the concept (crime) but not which of the book's fourteen
 * crime markers was meant. When a lexicon entry supplies an anchor for the
 * surface form that matched, we keep that link and can prefer the right
 * entries instead of returning any of the fourteen.
 */
export function matchConcepts(query, lexicon, langs) {
  const hay = normalize(query);
  const raw = foldHangul(query).toLowerCase();
  // A CJK query of 1-3 characters has no room for a longer word, so even 一 is
  // meaningful there; in a 20-character sentence it almost never is.
  const bareCjk = /^\s*\S{1,3}\s*$/.test(query);
  const found = [];

  for (const concept of lexicon.concepts) {
    let weight = 0;
    const matchedForms = [];
    const anchors = new Set();
    // A term written the way the reader actually wrote it is the best evidence.
    for (const lang of langs) {
      for (const form of concept[lang] ?? []) {
        if (!form) continue;
        const needle = normalize(form);
        if (!needle) continue;
        const latinish = !/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(form);
        // Word boundaries for space-delimited scripts, plain substring for CJK.
        const hit = latinish
          ? new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegex(needle)}($|[^\\p{L}\\p{N}])`, 'u').test(hay)
          : hay.includes(needle);
        if (!hit) continue;
        weight = Math.max(weight, latinish ? (form.includes(' ') ? 3 : 2.6) : 3);
        matchedForms.push(form);
        // An anchor says which of the book's markers this word means.
        for (const target of concept.anchor?.[lang]?.[normalize(form)] ?? []) {
          anchors.add(target);
        }
      }
    }
    // Chinese input can also name the concept directly through the markers the
    // book itself is indexed by, in either script.
    for (const marker of concept.book ?? []) {
      const forms = markerForms(marker);
      if (!forms.some((f) => raw.includes(f))) continue;
      if (isWeakMarker(marker) && !bareCjk) continue;
      // A multi-character marker is a real phrase; a single character is a
      // weaker signal, so it must not outweigh a Latin term hit.
      weight = Math.max(weight, marker.hant.length > 1 ? 3.4 : 2.2);
      matchedForms.push(marker.hant);
      anchors.add(marker.hant);
    }
    if (weight > 0) {
      found.push({
        id: concept.id,
        weight,
        matchedForms,
        book: concept.book,
        anchors: [...anchors],
      });
    }
  }
  return found.sort((a, b) => b.weight - a.weight);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * How often each marker character appears across the whole book. A marker that
 * occurs in 20% of entries (人) tells you almost nothing; one that occurs in
 * 0.2% (蛇, 龜) is the book's own way of filing the entry.
 *
 * Computed once per corpus from the entries themselves, so it stays correct if
 * the book is rebuilt.
 */
function markerRarity(book) {
  const freq = new Map();
  for (const entry of book.entries) {
    for (const ch of new Set(entry.zhHant)) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  const n = book.entries.length || 1;
  const rarity = new Map();
  for (const [ch, count] of freq) rarity.set(ch, 1 - count / n);
  return (marker) => rarity.get(marker.hant) ?? 0.9;
}

let rarityOf = null;

/**
 * How well an entry is filed under the concepts the question raised.
 *
 * Longer markers are stronger evidence; several one-character markers in one
 * entry do not add up to much (an entry mentioning 自, 別 and 離 is still one
 * loneliness entry, not three); and within a concept, an entry carrying that
 * concept's *distinctive* character beats one carrying a character so common
 * it barely narrows anything.
 */
function conceptEntryScore(entry, concepts) {
  let strong = 0;
  let weak = 0;
  const hitConcepts = new Set();
  const perConcept = new Map();

  for (const c of concepts) {
    let best = 0;
    // Markers the question named specifically outrank the rest of the concept.
    // "knife" means 刀, not merely "something in the crime section".
    const anchored = new Set(c.anchors ?? []);
    for (const marker of c.book) {
      const forms = markerForms(marker);
      const hit = entry.zhHant.includes(marker.hant) || entry.zhHans.includes(forms[forms.length - 1]);
      if (!hit) continue;
      // A multi-character marker is a phrase and is strong evidence. A single
      // character is weak on its own, scaled by how rare it is in the book.
      let value = marker.hant.length > 1
        ? 1 + marker.hant.length * 0.5
        : 0.4 + rarityOf(marker) * 1.6;
      if (anchored.size && anchored.has(marker.hant)) value += 3;
      if (value > best) best = value;
    }
    if (best > 0) {
      hitConcepts.add(c.id);
      perConcept.set(c.id, best);
      if (best >= 1) strong += best;
      else weak += best;
    }
  }

  // Cap the aggregate so breadth of markers cannot beat specificity.
  return { score: Math.min(strong + Math.min(weak, 1), 8), hitConcepts, perConcept };
}

/**
 * Score one entry against the query.
 * `translations` is the entry's record from data/translations/<lang>.json, or
 * undefined when that language has not been translated yet.
 */
function scoreEntry(entry, query, qBigrams, qNorms, concepts, translation) {
  let score = 0;
  const reasons = [];

  // Signal 1: concepts the entry is filed under.
  const { score: conceptScore, hitConcepts, perConcept } = conceptEntryScore(entry, concepts);
  if (conceptScore > 0) {
    score += conceptScore;
    reasons.push({ kind: 'concept', concepts: [...hitConcepts] });
  }

  // Signal 2: shared Chinese bigrams. Only for Chinese questions; for other
  // languages a coincidental two-character overlap is noise, not evidence.
  if (hasCjk(query)) {
    const eBigrams = new Set(bigrams(entry.zhHant));
    let overlap = 0;
    for (const bg of qBigrams) if (eBigrams.has(bg)) overlap++;
    if (overlap) {
      // Normalise by query length so a long question is not rewarded for
      // having more bigrams to overlap with.
      score += Math.min(overlap / Math.max(qBigrams.length, 1), 1) * 5;
      reasons.push({ kind: 'zh', overlap });
    }
  }

  // Signal 3: the translation's own keywords and text, when available. This is
  // the strongest signal for non-Chinese languages, once translations exist.
  if (translation) {
    const tText = normalize(`${translation.literal} ${translation.modern}`);
    let hits = 0;
    for (const kw of translation.keywords ?? []) {
      const n = normalize(kw);
      if (n && tText.includes(n)) hits++;
    }
    if (hits) {
      score += hits * 0.5;
      reasons.push({ kind: 'keyword', hits });
    }
    for (const qn of qNorms) {
      if (qn.length >= 4 && tText.includes(qn)) {
        score += 2.2;
        reasons.push({ kind: 'phrase', phrase: qn });
        break;
      }
    }
  }

  // Entries naming more than one of the question's concepts are usually better
  // matches than entries naming one of them three times.
  if (hitConcepts.size > 1) {
    score += (hitConcepts.size - 1) * 0.8;
    reasons.push({ kind: 'multi', n: hitConcepts.size });
  }

  return { score, reasons, hitConcepts: [...hitConcepts], perConcept };
}

/** Distinctive words in the question, longest first. */
function queryTerms(query) {
  const words = normalize(query).split(' ').filter((w) => w.length >= 4);
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 12);
}

/** Words too common to be evidence on their own. */
const STOP = new Set([
  'dream', 'dreamed', 'dreams', 'slept', 'sleep', 'sleeping', 'night', 'woke', 'waking',
  'about', 'that', 'with', 'from', 'have', 'was', 'were', 'this', 'they', 'them',
  'son', 'comme', 'avec', 'dans', 'pour', 'une', 'des', 'les', 'que', 'qui', 'mais',
  'nacht', 'schlaf', 'habe', 'ich', 'ein', 'eine', 'der', 'die', 'das', 'und', 'von',
  '夢', '梦见', '晚上', '睡觉', '一个', '我们',
  'sueno', 'suenos', 'con', 'por', 'para', 'que', 'una', 'perro',
  'сон', 'что', 'и', 'в', 'на', 'я', 'мне',
]);

/**
 * Rank book entries against a free-text question.
 *
 * @param {object} book       parsed data/dreambook.json
 * @param {string} query      the dream description, in any language
 * @param {object} lexicon    parsed data/lexicon.json
 * @param {object} options    { lang, limit, translations }
 */
export function search(book, query, lexicon, options = {}) {
  const { lang = 'en', limit = 8, translations = null } = options;
  const clean = foldHangul(query).trim();
  if (!clean) return { concepts: [], results: [], confidence: 0 };

  const langs = lang.startsWith('zh') ? ['en', 'ja', 'es', 'ru', 'fr', lang] : [lang, 'en'];
  const concepts = matchConcepts(clean, lexicon, langs);
  const qBigrams = bigrams(clean);
  const qNorms = queryTerms(clean).filter((w) => !STOP.has(w));
  rarityOf = markerRarity(book);

  const scored = [];
  for (const entry of book.entries) {
    const translation = translations?.entries?.[entry.id];
    const { score, reasons, hitConcepts } = scoreEntry(
      entry, clean, qBigrams, qNorms, concepts, translation,
    );
    if (score <= 0) continue;
    scored.push({ entry, score, reasons, hitConcepts });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.zhHant.localeCompare(b.entry.zhHant));

  // A dream naming three concepts should not return nine entries about the
  // first one. Each lead concept contributes at most three, which keeps a
  // ranking like [齒自落, 齒落更生, 刷牙病患不生, 牙木梳舊事] intact rather than
  // cutting the teeth entries that actually answer the question.
  const MAX_PER_CONCEPT = 3;
  const seen = new Map();
  const results = [];
  for (const item of scored) {
    const lead = item.hitConcepts[0] ?? '__direct__';
    const count = seen.get(lead) ?? 0;
    if (count >= MAX_PER_CONCEPT) continue;
    seen.set(lead, count + 1);
    results.push(item);
    if (results.length >= limit) break;
  }

  const top = results[0]?.score ?? 0;
  return {
    concepts,
    // Confidence is relative to the best match, not an absolute number. A
    // question whose concepts all landed on entries scores high; one where the
    // only signal was a single weak marker scores low.
    confidence: Math.max(0, Math.min(1, top / 6)),
    results,
  };
}

/** Entries for one section, for the browse panel. */
export function bySection(book, sectionId) {
  return book.entries.filter((e) => e.section === sectionId);
}

/**
 * Text search over the book for the browse panel: Chinese text always, plus
 * the translation text when it exists.
 */
export function searchBook(book, query, translations, limit = 60) {
  const q = normalize(query);
  if (!q) return [];
  const raw = foldHangul(query).toLowerCase();
  const out = [];

  for (const entry of book.entries) {
    let score = 0;
    if (entry.zhHant.includes(raw) || entry.zhHans.includes(raw)) score += 5;
    if (q.length > 1) {
      if (normalize(entry.zhHant).includes(q)) score += 4;
    }
    const t = translations?.entries?.[entry.id];
    if (t) {
      const text = normalize(`${t.literal} ${t.modern} ${(t.keywords ?? []).join(' ')}`);
      if (text.includes(q)) score += 3;
      for (const kw of t.keywords ?? []) {
        const n = normalize(kw);
        if (n.length >= 3 && text.includes(n)) score += 1;
      }
    }
    if (score > 0) out.push({ entry, translation: t, score });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}
