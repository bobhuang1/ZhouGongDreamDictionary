/**
 * App wiring: language, theme, question handling, rendering.
 *
 * Everything user-facing is read from data/i18n/<lang>.json, so adding a
 * language is a data change, not a code change.
 */
import { search, searchBook } from './matcher.js';
import { interpret, testKey, loadKey, saveKey, AiError } from './ai.js';

const LOCALES = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'es', 'ru', 'fr'];
const THEME_KEY = 'zgd.theme';
const LANG_KEY = 'zgd.lang';
const THEME_ICON = { auto: '◐', light: '☀', dark: '☾' };
const MAX_PASSAGES = 8;

const $ = (id) => document.getElementById(id);
const el = {
  langSelect: $('langSelect'),
  themeToggle: $('themeToggle'),
  themeIcon: $('themeIcon'),
  form: $('ask'),
  input: $('dreamInput'),
  askButton: $('askButton'),
  charCount: $('charCount'),
  exampleChips: $('exampleChips'),
  status: $('status'),
  results: $('results'),
  resultMain: $('resultMain'),
  resultEmpty: $('resultEmpty'),
  interpretation: $('interpretation'),
  readingBody: $('readingBody'),
  entryList: $('entryList'),
  askAnother: $('askAnother'),
  keyDisclosure: $('keyDisclosure'),
  apiKey: $('apiKey'),
  saveKey: $('saveKey'),
  clearKey: $('clearKey'),
  keyStatus: $('keyStatus'),
  bookSearch: $('bookSearch'),
  browseCount: $('browseCount'),
  browseResults: $('browseResults'),
  bookTitle: $('bookTitle'),
  live: $('live'),
};

const state = {
  lang: 'en',
  book: null,
  lexicon: null,
  /** lang -> parsed data/translations/<lang>.json, or null when absent. */
  translations: new Map(),
  dict: {},
  busy: false,
};

/* ---------------------------------------------------------------- i18n */

function t(key, vars) {
  let value = state.dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) value = value.replaceAll(`{${k}}`, String(v));
  }
  return value;
}

function applyI18n(root = document) {
  for (const node of root.querySelectorAll('[data-i18n]')) {
    node.textContent = t(node.dataset.i18n);
  }
  for (const node of root.querySelectorAll('[data-i18n-placeholder]')) {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  }
  for (const node of root.querySelectorAll('[data-i18n-title]')) {
    node.title = t(node.dataset.i18nTitle);
  }
  document.documentElement.lang = state.lang;
  document.title = `${t('siteTitle')} — ${t('siteSubtitle')}`;
}

function announce(message) {
  el.live.textContent = message;
}

function setStatus(message = '', isError = false) {
  el.status.textContent = message;
  el.status.classList.toggle('error', isError);
  if (message) announce(message);
}

function detectLang() {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved && LOCALES.includes(saved)) return saved;
  for (const raw of navigator.languages ?? [navigator.language ?? 'en']) {
    const tag = String(raw).toLowerCase();
    if (tag.startsWith('zh')) {
      return /hant|tw|hk|mo/.test(tag) ? 'zh-Hant' : 'zh-Hans';
    }
    const base = tag.split('-')[0];
    if (LOCALES.includes(base)) return base;
  }
  return 'en';
}

/* ---------------------------------------------------------------- theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  el.themeIcon.textContent = THEME_ICON[theme];
  el.themeToggle.setAttribute('aria-label', t('themeToggle'));
}

function initTheme() {
  let theme = localStorage.getItem(THEME_KEY) ?? 'auto';
  if (!THEME_ICON[theme]) theme = 'auto';
  applyTheme(theme);
  el.themeToggle.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(theme) + 1) % order.length];
    theme = next;
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  });
}

/* ---------------------------------------------------------------- rendering */

function toneClass(tone) {
  return ['good', 'bad', 'mixed'].includes(tone) ? tone : 'mixed';
}

function toneLabel(tone) {
  return t(`tone${tone.charAt(0).toUpperCase()}${tone.slice(1)}`);
}

function renderEntry(item) {
  const { entry, translation } = item;
  const li = document.createElement('li');
  li.className = 'entry';

  const top = document.createElement('div');
  top.className = 'entry-top';

  const section = document.createElement('span');
  section.className = 'entry-section';
  const sectionTitle = state.lang === 'zh-Hans' ? entry.sectionZhHans : entry.sectionZhHant;
  section.textContent = sectionTitle;

  const tone = document.createElement('span');
  // An AI-verified tone beats the build-time heuristic when we have one.
  tone.className = `tone ${toneClass(translation?.tone ?? entry.toneHint)}`;
  tone.textContent = toneLabel(translation?.tone ?? entry.toneHint);

  top.append(section, tone);

  const zh = document.createElement('div');
  zh.className = 'entry-zh';
  const hant = document.createElement('span');
  hant.className = 'hant';
  hant.lang = 'zh-Hant';
  hant.textContent = entry.zhHant;
  const hans = document.createElement('span');
  hans.className = 'hans';
  hans.lang = 'zh-Hans';
  hans.textContent = entry.zhHans;
  zh.append(hant, hans);

  li.append(top, zh);

  if (translation?.literal) {
    const literal = document.createElement('p');
    literal.className = 'entry-translated';
    literal.textContent = translation.literal;
    li.append(literal);
  }
  if (translation?.modern) {
    const modern = document.createElement('p');
    modern.className = 'entry-modern';
    modern.textContent = translation.modern;
    li.append(modern);
  }
  return li;
}

function renderReading(reading) {
  el.readingBody.replaceChildren();
  if (reading.summary) {
    const p = document.createElement('p');
    p.className = 'lead';
    p.textContent = reading.summary;
    el.readingBody.append(p);
  }
  if (reading.points?.length) {
    const ul = document.createElement('ul');
    for (const point of reading.points) {
      const li = document.createElement('li');
      li.textContent = point;
      ul.append(li);
    }
    el.readingBody.append(ul);
  }
  if (reading.caveat) {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = reading.caveat;
    el.readingBody.append(p);
  }
  el.interpretation.hidden = false;
}

function renderResults(found) {
  const items = found.results ?? [];

  if (!items.length) {
    el.resultMain.hidden = true;
    el.resultEmpty.hidden = false;
    el.results.hidden = false;
    el.interpretation.hidden = true;
    return;
  }

  el.resultEmpty.hidden = true;
  el.resultMain.hidden = false;
  el.results.hidden = false;
  el.entryList.replaceChildren(...items.map(renderEntry));
}

function renderBrowse(query) {
  const list = state.lang === 'zh-Hans' ? state.book.sections : state.book.sections;
  el.browseResults.replaceChildren();

  if (!query.trim()) {
    el.browseCount.textContent = '';
    for (const section of list) {
      const heading = document.createElement('h4');
      heading.className = 'entry-section';
      heading.style.padding = '10px 0 2px';
      heading.textContent = state.lang === 'zh-Hans' ? section.zhHans : section.zhHant;
      el.browseResults.append(heading);
      for (const entry of state.book.entries.filter((e) => e.section === section.id).slice(0, 8)) {
        el.browseResults.append(renderEntry({ entry, translation: state.translations.get(state.lang)?.entries?.[entry.id] }));
      }
    }
    return;
  }

  const hits = searchBook(state.book, query, state.translations.get(state.lang) ?? null);
  el.browseCount.textContent = hits.length
    ? `${hits.length} / ${state.book.entries.length}`
    : t('noSearchResults');
  for (const hit of hits) el.browseResults.append(renderEntry(hit));
}

function renderExamples() {
  el.exampleChips.replaceChildren();
  for (let i = 1; i <= 4; i++) {
    const text = t(`example${i}`);
    if (text === `example${i}`) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    chip.textContent = text;
    chip.addEventListener('click', () => {
      el.input.value = text;
      el.input.focus();
      el.form.requestSubmit();
    });
    el.exampleChips.append(chip);
  }
}

function renderStats() {
  el.bookTitle.textContent = `${state.book.meta.title} · ${state.book.meta.titleSimplified}`;
  const entries = state.book.entries.length;
  const sections = state.book.sections.length;
  el.browseCount.dataset.total = String(entries);
  el.bookSearch.placeholder = t('searchPlaceholder');
  void entries; void sections;
}

function updateCharCount() {
  const used = el.input.value.length;
  el.charCount.textContent = used > 480 ? `${used} / ${el.input.maxLength}` : '';
}

/* ---------------------------------------------------------------- flow */

function setBusy(busy) {
  state.busy = busy;
  el.askButton.disabled = busy;
  el.askButton.classList.toggle('busy', busy);
  if (busy) setStatus(t('thinking'));
}

async function ask(question) {
  const clean = question.trim();
  if (!clean || state.busy) return;

  const key = loadKey();
  const translationPack = state.translations.get(state.lang) ?? null;

  const found = search(state.book, clean, state.lexicon, {
    lang: state.lang,
    limit: MAX_PASSAGES,
    translations: translationPack,
  });

  const passages = found.results.map((r) => ({
    zhHant: r.entry.zhHant,
    zhHans: r.entry.zhHans,
    sectionTitle: (state.lang === 'zh-Hans' ? r.entry.sectionZhHans : r.entry.sectionZhHant),
    literal: translationPack?.entries?.[r.entry.id]?.literal,
  }));

  el.interpretation.hidden = true;
  renderResults(found);
  el.results.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!found.results.length) {
    setStatus('');
    return;
  }

  // A key is optional. Without one the reading goes through the site proxy,
  // which holds the key server side, so the common path is frictionless.
  setBusy(true);
  try {
    const reading = await interpret({ question: clean, lang: state.lang, passages, apiKey: key });
    renderReading(reading);
    setStatus('');
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    setStatus(err.message, true);
    // Only about a personal key: the proxy's own 403 means an origin or
    // config problem, which clearing a key cannot fix.
    if (key && (err.status === 400 || err.status === 403)) {
      // A rejected key is worthless, so drop it -- but open the panel so the
      // reader can paste a working one instead of wondering where it went.
      saveKey('');
      el.apiKey.value = '';
      el.keyStatus.textContent = err.message;
      if (!el.keyDisclosure.open) el.keyDisclosure.open = true;
      el.apiKey.focus();
    }
  } finally {
    setBusy(false);
  }
}

async function setLang(lang) {
  state.lang = lang;
  localStorage.setItem(LANG_KEY, lang);
  const res = await fetch(`data/i18n/${encodeURIComponent(lang)}.json`);
  state.dict = await res.json();
  applyI18n();
  el.langSelect.value = lang;
  el.apiKey.placeholder = t('keyPlaceholder');
  renderExamples();
  renderStats();
  updateCharCount();
  await loadTranslations(lang);
  renderBrowse(el.bookSearch.value);
  const known = state.book.meta.sources;
  $('linkTraditional').href = known['zh-hant'];
  $('linkSimplified').href = known['zh-hans'];
}

/** Endonyms: a reader picks their own language, not the English name for it. */
const LOCALE_NAMES = {
  en: 'English',
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
  ja: '日本語',
  es: 'Español',
  ru: 'Русский',
  fr: 'Français',
};

function initLangPicker() {
  for (const lang of LOCALES) {
    const option = document.createElement('option');
    option.value = lang;
    option.textContent = LOCALE_NAMES[lang] ?? lang;
    el.langSelect.append(option);
  }
  el.langSelect.addEventListener('change', () => {
    setLang(el.langSelect.value).catch((err) => setStatus(err.message, true));
  });
}

function initKeyUI() {
  el.apiKey.value = loadKey();
  el.saveKey.addEventListener('click', async () => {
    const key = el.apiKey.value.trim();
    if (!key) return;
    const original = el.saveKey.textContent;
    el.saveKey.disabled = true;
    el.keyStatus.textContent = t('keyTesting');
    try {
      await testKey(key);
      saveKey(key);
      el.keyStatus.textContent = t('keySaved');
    } catch {
      saveKey('');
      el.apiKey.value = '';
      el.keyStatus.textContent = t('keyFailed');
    } finally {
      el.saveKey.disabled = false;
      el.saveKey.textContent = original;
    }
  });
  el.clearKey.addEventListener('click', () => {
    saveKey('');
    el.apiKey.value = '';
    el.keyStatus.textContent = t('keyCleared');
  });
}

/**
 * Missing translation files are expected, not an error: the site ships with
 * Chinese source text and an AI reading, and the batch translator adds
 * per-entry translations later. Only a real failure is worth reporting.
 */
async function loadTranslations(lang) {
  if (state.translations.has(lang)) return state.translations.get(lang);
  try {
    const res = await fetch(`data/translations/${encodeURIComponent(lang)}.json`);
    if (!res.ok) {
      state.translations.set(lang, null);
      return null;
    }
    const data = await res.json();
    state.translations.set(lang, data);
    return data;
  } catch {
    state.translations.set(lang, null);
    return null;
  }
}

function init() {
  initTheme();
  initLangPicker();
  initKeyUI();

  el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    ask(el.input.value);
  });
  el.input.addEventListener('input', updateCharCount);
  el.askAnother.addEventListener('click', () => {
    el.input.value = '';
    el.input.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  el.bookSearch.addEventListener('input', () => renderBrowse(el.bookSearch.value));

  setStatus(t('loadingBook'));

  Promise.all([
    fetch('data/dreambook.json').then((r) => r.json()),
    fetch('data/lexicon.json').then((r) => r.json()),
  ])
    .then(async ([book, lexicon]) => {
      // Section titles are denormalised onto each entry once, so the renderer
      // and the AI prompt never have to look them up.
      const byId = new Map(book.sections.map((s) => [s.id, s]));
      for (const entry of book.entries) {
        const section = byId.get(entry.section);
        entry.sectionZhHant = section?.zhHant ?? '';
        entry.sectionZhHans = section?.zhHans ?? '';
      }
      state.book = book;
      state.lexicon = lexicon;
      await setLang(detectLang());
      setStatus('');
      announce(t('loadingBook') === '' ? t('heroTitle') : t('heroTitle'));
    })
    .catch((err) => {
      setStatus(`${t('errorLoading')} ${err.message}`, true);
    });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
