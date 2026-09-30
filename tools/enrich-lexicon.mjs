/**
 * Enrich data/lexicon.json with concepts and anchors.
 *
 * Two things belong here, both of which need the book as a referee.
 *
 * Concepts. The original lexicon grouped everything familial under `person`,
 * so a question about a mother or a pregnancy had no concept of its own and
 * could not reach the entries that answer it. The book has six 孕 entries and
 * six 母 entries, so these concepts are worth having.
 *
 * Anchors. Knowing "the reader said knife" identifies the concept (crime) but
 * not which of its fourteen single-character markers was meant, so every crime
 * entry scores alike and the ranking is arbitrary. An anchor names the specific
 * character, letting 刀 entries win.
 *
 * Nothing is written that the book does not actually contain: every marker is
 * checked against the text and every new concept must match something.
 *
 * Usage: node tools/enrich-lexicon.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEXICON = join(ROOT, 'data', 'lexicon.json');
const BOOK = join(ROOT, 'data', 'dreambook.json');

/** New concepts. `book` markers must exist in the book; checked below. */
const CONCEPTS = [
  {
    id: 'pregnancy',
    book: ['孕', '有孕'],
    en: ['pregnant', 'pregnancy', 'with child', 'expecting a baby'],
    ja: ['妊娠', '孕む', '怀孕', '怀孕中'],
    es: ['embarazada', 'embarazo', 'grávida'],
    ru: ['беременная', 'беременность', 'беременна'],
    fr: ['enceinte', 'grossesse', 'gravide'],
  },
  {
    id: 'mother',
    book: ['母', '父母'],
    en: ['mother', 'mom', 'mum', 'mama'],
    ja: ['母', 'お母さん', '母親'],
    es: ['madre', 'mama', 'mamá'],
    ru: ['мать', 'мама', 'матери'],
    fr: ['mère', 'mere', 'maman'],
  },
  {
    id: 'father',
    book: ['父', '父母'],
    en: ['father', 'dad', 'papa'],
    ja: ['父', 'お父さん', '父親'],
    es: ['padre', 'papa', 'papá'],
    ru: ['отец', 'папа', 'отца'],
    fr: ['père', 'pere', 'papa'],
  },
];

/**
 * concept id -> { language: { surfaceForm: [markers] } }.
 * "normalise keys" here means lowercase and diacritics stripped, because that
 * is how the matcher looks an anchor up.
 */
const ANCHORS = {
  crime: {
    en: { knife: ['刀'], knives: ['刀'], sword: ['劍'], blade: ['刀'], spear: ['戈'],
          thief: ['盜', '賊'], thieves: ['盜', '賊'], robber: ['盜', '賊'],
          jail: ['獄'], prison: ['獄'], cell: ['獄'], court: ['訟'],
          chase: ['逃'], chased: ['逃'], fight: ['鬥'], fighting: ['鬥'] },
    es: { cuchillo: ['刀'], espada: ['劍'], ladron: ['盜', '賊'], carcel: ['獄'],
          juicio: ['訟'], pelea: ['鬥'], asesinato: ['殺'], huir: ['逃'] },
    ru: { нож: ['刀'], меч: ['劍'], вор: ['盜', '賊'], тюрьма: ['獄'], суд: ['訟'],
          драка: ['鬥'], убийство: ['殺'], побег: ['逃'] },
    fr: { couteau: ['刀'], epee: ['劍'], voleur: ['盜', '賊'], prison: ['獄'],
          proces: ['訟'], bagarre: ['鬥'], meurtre: ['殺'], fuite: ['逃'] },
  },
  pregnancy: {
    en: { pregnant: ['孕'], pregnancy: ['孕'] },
  },
  mother: {
    en: { mother: ['母'], mom: ['母'], mum: ['母'], mama: ['母'] },
  },
  father: {
    en: { father: ['父'], dad: ['父'] },
  },
  teeth: {
    en: { teeth: ['齒'], tooth: ['齒'] },
    es: { dientes: ['齒'], diente: ['齒'], dentadura: ['齒'] },
    ru: { зубы: ['齒'], зуб: ['齒'], зубов: ['齒'] },
    fr: { dents: ['齒'], dent: ['齒'], denture: ['齒'] },
  },
  money: {
    en: { money: ['財', '金'], coin: ['錢'], coins: ['錢'], gold: ['金'], cash: ['財'],
          salary: ['祿'], wealth: ['富', '貴'], rich: ['富', '貴'] },
    es: { dinero: ['財', '金'], monedas: ['錢'], oro: ['金'], sueldo: ['祿'], riqueza: ['富', '貴'] },
    ru: { деньги: ['財', '金'], монеты: ['錢'], золото: ['金'], зарплата: ['祿'] },
    fr: { argent: ['財', '金'], monnaie: ['錢'], or: ['金'], salaire: ['祿'] },
  },
  house: {
    en: { building: ['屋', '樓'], buildings: ['屋', '樓'], house: ['家', '宅', '屋'],
          home: ['家'], apartment: ['室'], kitchen: ['廚'], toilet: ['廁'],
          bathroom: ['廁'], warehouse: ['倉'] },
    es: { edificio: ['屋', '樓'], casa: ['家', '宅', '屋'], hogar: ['家'],
          departamento: ['室'], cocina: ['廚'], bano: ['廁'] },
    ru: { дом: ['家', '宅', '屋'], здание: ['屋', '樓'], квартира: ['室'], кухня: ['廚'] },
    fr: { maison: ['家', '宅', '屋'], immeuble: ['屋', '樓'], appartement: ['室'],
          cuisine: ['廚'], salle: ['室'] },
  },
  snake: {
    en: { snake: ['蛇'], snakes: ['蛇'] },
    es: { serpiente: ['蛇'] },
    ru: { змея: ['蛇'], змей: ['蛇'] },
    fr: { serpent: ['蛇'] },
  },
  tiger: {
    en: { tiger: ['虎'], leopard: ['豹'], lion: ['獅'] },
    es: { tigre: ['虎'], leopardo: ['豹'] },
    ru: { тигр: ['虎'] },
    fr: { tigre: ['虎'] },
  },
  water: {
    en: { river: ['河', '江'], sea: ['海'], ocean: ['海'], lake: ['海'],
          rain: ['雨'], well: ['井'] },
    es: { rio: ['河', '江'], mar: ['海'], lluvia: ['雨'], pozo: ['井'] },
    ru: { река: ['河', '江'], море: ['海'], дождь: ['雨'], колодец: ['井'] },
    fr: { riviere: ['河', '江'], mer: ['海'], pluie: ['雨'], puits: ['井'] },
  },
  fire: {
    en: { fire: ['火'], flame: ['燒', '燈'], smoke: ['煙'], candle: ['燭'] },
    es: { fuego: ['火'], llama: ['燒'], humo: ['煙'], vela: ['燭'] },
    ru: { огонь: ['火'], пламя: ['燒'], дым: ['煙'] },
    fr: { feu: ['火'], flamme: ['燒'], fumee: ['煙'], bougie: ['燭'] },
  },
  horse: {
    en: { horse: ['馬'], horses: ['馬'], donkey: ['馬'] },
    es: { caballo: ['馬'] },
    ru: { лошадь: ['馬'] },
    fr: { cheval: ['馬'] },
  },
  dog: {
    en: { dog: ['狗', '犬'], puppy: ['狗', '犬'] },
    es: { perro: ['狗', '犬'] },
    ru: { собака: ['狗', '犬'] },
    fr: { chien: ['狗', '犬'] },
  },
  cat: {
    en: { cat: ['貓'], kitten: ['貓'] },
    es: { gato: ['貓'], gata: ['貓'] },
    ru: { кошка: ['貓'], кот: ['貓'] },
    fr: { chat: ['貓'] },
  },
  bird: {
    en: { bird: ['鳥'], birds: ['鳥'], crow: ['鴉'], sparrow: ['雀'],
          chicken: ['雞'], hen: ['雞'], crane: ['鶴'] },
    es: { pajaro: ['鳥'], cuervo: ['鴉'], gallina: ['雞'], grulla: ['鶴'] },
    ru: { птица: ['鳥'], ворона: ['鴉'], курица: ['雞'] },
    fr: { oiseau: ['鳥'], corbeau: ['鴉'], poule: ['雞'] },
  },
  fish: {
    en: { fish: ['魚'], carp: ['鯉'], fishing: ['釣'] },
    es: { pez: ['魚'], carpa: ['鯉'], pescar: ['釣'] },
    ru: { рыба: ['魚'], карп: ['鯉'], рыбалка: ['釣'] },
    fr: { poisson: ['魚'], carpe: ['鯉'], peche: ['釣'] },
  },
  turtle: {
    en: { turtle: ['龜'], tortoise: ['龜'] },
    es: { tortuga: ['龜'] },
    ru: { черепаха: ['龜'] },
    fr: { tortue: ['龜'] },
  },
  dragon: {
    en: { dragon: ['龍'] },
    es: { dragon: ['龍'] },
    ru: { дракон: ['龍'] },
    fr: { dragon: ['龍'] },
  },
  vehicle: {
    en: { car: ['車'], cars: ['車'], ship: ['船', '舟'], boat: ['船', '舟'],
          bridge: ['橋'] },
    es: { coche: ['車'], carro: ['車'], barco: ['船', '舟'], puente: ['橋'] },
    ru: { машина: ['車'], автомобиль: ['車'], корабль: ['船', '舟'],
          лодка: ['船', '舟'], мост: ['橋'] },
    fr: { voiture: ['車'], bateau: ['船', '舟'], pont: ['橋'] },
  },
  weather: {
    en: { rain: ['雨'], snow: ['雪'], thunder: ['雷'], lightning: ['電'],
          fog: ['霧'], frost: ['霜'], cloud: ['雲'] },
    es: { lluvia: ['雨'], nieve: ['雪'], trueno: ['雷'], rayo: ['電'], niebla: ['霧'] },
    ru: { дождь: ['雨'], снег: ['雪'], гром: ['雷'], молния: ['電'] },
    fr: { pluie: ['雨'], neige: ['雪'], tonnerre: ['雷'], eclair: ['電'], brouillard: ['霧'] },
  },
  death: {
    en: { death: ['死'], died: ['死'], dying: ['死'], dead: ['死'], corpse: ['殮'],
          coffin: ['棺'], grave: ['墓'], funeral: ['喪'], weeping: ['哭'], cried: ['哭'] },
    es: { muerte: ['死'], morir: ['死'], muerto: ['死'], cadaver: ['殮'],
          ataud: ['棺'], tumba: ['墓'], funeral: ['喪'], llorar: ['哭'] },
    ru: { смерть: ['死'], умер: ['死'], мертвый: ['死'], труп: ['殮'], гроб: ['棺'],
          могила: ['墓'], плакать: ['哭'] },
    fr: { mort: ['死'], mourir: ['死'], cercueil: ['棺'], tombe: ['墓'],
          pleurer: ['哭'], funeral: ['喪'] },
  },
  body: {
    en: { hair: ['髮'], head: ['頭'], face: ['面'], hand: ['手'], foot: ['腳'],
          leg: ['腳'], blood: ['血'], tongue: ['舌'], shoulder: ['肩'] },
    es: { pelo: ['髮'], cabeza: ['頭'], cara: ['面'], mano: ['手'], pie: ['腳'], sangre: ['血'] },
    ru: { волосы: ['髮'], голова: ['頭'], лицо: ['面'], рука: ['手'], нога: ['腳'], кровь: ['血'] },
    fr: { cheveux: ['髮'], tete: ['頭'], visage: ['面'], main: ['手'], pied: ['腳'], sang: ['血'] },
  },
  illness: {
    en: { illness: ['病'], sick: ['病'], disease: ['疾'], ill: ['病'],
          wounded: ['傷'], injury: ['傷'], fat: ['肥'], thin: ['瘦'], sore: ['瘡'] },
    es: { enfermedad: ['病'], enfermo: ['病'], doente: ['疾'], herida: ['傷'],
          gordo: ['肥'], delgado: ['瘦'], llaga: ['瘡'] },
    ru: { болезнь: ['病'], болен: ['病'], больной: ['疾'], рана: ['傷'],
          толстый: ['肥'], худой: ['瘦'], язва: ['瘡'] },
    fr: { maladie: ['病'], malade: ['病'], blessure: ['傷'], gras: ['肥'],
          maigre: ['瘦'], plaie: ['瘡'] },
  },
  work: {
    en: { job: ['官'], office: ['官'], promotion: ['遷'], salary: ['祿'],
          writing: ['書'], letter: ['書'], exam: ['印'], brush: ['筆'] },
    es: { trabajo: ['官'], empleo: ['官'], ascenso: ['遷'], sueldo: ['祿'],
          escribir: ['書'], carta: ['書'], examen: ['印'] },
    ru: { работа: ['官'], повышение: ['遷'], жалованье: ['祿'], писать: ['書'],
          письмо: ['書'], экзамен: ['印'] },
    fr: { travail: ['官'], emploi: ['官'], promotion: ['遷'], salaire: ['祿'],
          ecrire: ['書'], lettre: ['書'], examen: ['印'] },
  },
  travel: {
    en: { journey: ['行'], travel: ['行'], travelling: ['行'], road: ['路'],
          leaving: ['出'], return: ['回'], distance: ['遠'] },
    es: { viaje: ['行'], viajar: ['行'], camino: ['路'], salir: ['出'],
          volver: ['回'], lejos: ['遠'] },
    ru: { путь: ['行'], дорога: ['路'], уйти: ['出'], вернуться: ['回'], далеко: ['遠'] },
    fr: { voyage: ['行'], voyager: ['行'], route: ['路'], partir: ['出'],
          retour: ['回'], loin: ['遠'] },
  },
};

/** Lowercase, strip diacritics, punctuation to spaces: the matcher's key form. */
function normalizeForm(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const lexicon = JSON.parse(await readFile(LEXICON, 'utf8'));
  const book = JSON.parse(await readFile(BOOK, 'utf8'));
  const text = book.entries.map((e) => e.zhHant).join('');
  const problems = [];

  // New concepts first, so anchors can target them.
  for (const spec of CONCEPTS) {
    if (lexicon.concepts.some((c) => c.id === spec.id)) continue;
    const missing = spec.book.filter((m) => !text.includes(m));
    if (missing.length) {
      problems.push(`concept ${spec.id}: markers absent from book: ${missing.join(',')}`);
      continue;
    }
    lexicon.concepts.push({
      id: spec.id,
      book: spec.book.map((hant) => ({ hant, hans: hant })),
      en: spec.en,
      ja: spec.ja,
      es: spec.es,
      ru: spec.ru,
      fr: spec.fr,
    });
    console.log(`added concept ${spec.id}`);
  }

  const byId = new Map(lexicon.concepts.map((c) => [c.id, c]));
  let applied = 0;
  for (const [id, spec] of Object.entries(ANCHORS)) {
    const concept = byId.get(id);
    if (!concept) {
      // A typo here used to vanish silently, which is how three anchors for
      // non-existent concepts went unnoticed.
      problems.push(`anchor target "${id}" is not a concept`);
      continue;
    }
    for (const [lang, map] of Object.entries(spec)) {
      concept.anchor ??= {};
      concept.anchor[lang] ??= {};
      for (const [form, markers] of Object.entries(map)) {
        const key = normalizeForm(form);
        const missing = markers.filter((m) => !text.includes(m));
        if (missing.length) {
          problems.push(`${id}.${lang}.${form}: markers absent from book: ${missing.join(',')}`);
          continue;
        }
        concept.anchor[lang][key] = [...new Set([...(concept.anchor[lang][key] ?? []), ...markers])];
        applied++;
      }
    }
  }

  lexicon.meta.conceptCount = lexicon.concepts.length;
  lexicon.meta.anchorPurpose =
    'anchor[lang][surfaceForm] names which book marker that word means, so a ' +
    'Latin-script question can prefer 刀 entries over every other crime entry.';

  await writeFile(LEXICON, JSON.stringify(lexicon, null, 2), 'utf8');
  console.log(`applied ${applied} anchors; ${lexicon.concepts.length} concepts`);

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ${p}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}