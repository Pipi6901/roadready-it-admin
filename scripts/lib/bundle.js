'use strict';

// Checks a content.json bundle against what seed.js and publishTestSet need
// from it — before anything is written anywhere.
//
// Everything here is something that would otherwise surface late and badly:
// as a half-finished seed, as an empty published bundle, or as a Firestore
// error that names a field but not the document it came from. The seed writes
// in batches, so a crash at question 5,000 leaves 5,000 questions in the
// database and no clear way to tell which; a bundle that cannot pass this check
// never gets as far as the first batch.
//
// No Firebase here. It runs on the file alone, which is what lets
// `node scripts/seed.js --dry-run` work without a key, a network or a billing
// plan.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const EXPECTED_COUNTRY = 'IT';
// Firestore caps a document at 1 MiB. The JSON length is a fair proxy for it:
// a little generous (Firestore counts field names once and values by type),
// which is the right direction to be wrong in.
const DOC_LIMIT = 1024 * 1024;
const DOC_WARN = Math.floor(DOC_LIMIT * 0.7);

/** The licence categories the admin accepts — read from the one place they are defined. */
function licenceCodes() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'lib', 'types.ts'), 'utf8');
  const m = src.match(/LICENCE_CODES\s*=\s*\[([^\]]+)\]/);
  if (!m) throw new Error('cannot read LICENCE_CODES from src/lib/types.ts');
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

/** The locales publishTestSet will include, from the function itself. */
function publishedLocales() {
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const m = src.match(/V1_LOCALE_CODES\s*=\s*\[([^\]]+)\]/);
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const isBlank = (s) => typeof s !== 'string' || s.trim() === '';

function validateBundle(data, { figuresDir } = {}) {
  const errors = [];
  const warnings = [];
  const stats = {};
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  // Reports the first few of a kind with their ids, and counts the rest, so a
  // systematic fault reads as one line and not as seven thousand.
  const bucket = {};
  const flag = (kind, id) => {
    (bucket[kind] = bucket[kind] ?? []).push(id);
  };

  for (const key of ['country', 'countries', 'locales', 'topics', 'questions']) {
    if (data[key] === undefined) err(`bundle has no "${key}"`);
  }
  if (errors.length) return { errors, warnings, stats };

  /* ------------------------------------------------------------ country */
  const country = data.country;
  if (country.code !== EXPECTED_COUNTRY) {
    err(`country.code is "${country.code}", this admin is for "${EXPECTED_COUNTRY}"`);
  }
  if (!Array.isArray(data.countries) || !data.countries.some((c) => c.code === country.code)) {
    err('countries[] does not contain the primary country');
  }
  // These are the fields seed.js copies into the country document. Firestore
  // refuses `undefined`, and it does so at the first set(), naming the field
  // but not why it is missing.
  for (const field of ['code', 'name', 'flagEmoji', 'authority', 'legalNotice', 'status', 'questionCount', 'mockTest', 'currency']) {
    if (country[field] === undefined) err(`country.${field} is missing — the seed writes it and Firestore rejects undefined`);
  }
  const mock = country.mockTest ?? {};
  for (const field of ['questionCount', 'timeLimitMinutes', 'passMark']) {
    if (typeof mock[field] !== 'number') err(`country.mockTest.${field} must be a number`);
  }
  if (typeof mock.passMark === 'number' && typeof mock.questionCount === 'number' && mock.passMark > mock.questionCount) {
    err(`mockTest.passMark (${mock.passMark}) exceeds questionCount (${mock.questionCount})`);
  }
  if (country.questionCount !== data.questions.length) {
    warn(`country.questionCount says ${country.questionCount}, the bundle has ${data.questions.length}`);
  }

  /* ------------------------------------------------------------ locales */
  const localeCodes = new Set();
  for (const l of data.locales) {
    localeCodes.add(l.code);
    for (const field of ['code', 'nameNative', 'nameEnglish', 'direction', 'flagEmoji']) {
      if (l[field] === undefined) err(`locale ${l.code ?? '?'}: ${field} is missing`);
    }
    if (l.direction !== 'ltr' && l.direction !== 'rtl') err(`locale ${l.code}: direction must be ltr or rtl, got "${l.direction}"`);
  }
  const published = publishedLocales();
  if (published) {
    const missing = published.filter((c) => !localeCodes.has(c));
    const extra = [...localeCodes].filter((c) => !published.includes(c));
    if (missing.length) err(`functions/index.js publishes locales the bundle does not define: ${missing.join(', ')}`);
    if (extra.length) warn(`the bundle defines locales publishTestSet will leave out: ${extra.join(', ')}`);
  } else {
    warn('could not read V1_LOCALE_CODES from functions/index.js');
  }
  const rtl = data.locales.filter((l) => l.direction === 'rtl').map((l) => l.code);
  stats.rtlLocales = rtl.join(', ') || 'none';

  /* ------------------------------------------------------------- topics */
  const topicIds = new Set();
  const topicSlugs = new Set();
  for (const t of data.topics) {
    if (topicIds.has(t.id)) err(`duplicate topic id ${t.id}`);
    topicIds.add(t.id);
    if (topicSlugs.has(t.slug)) err(`duplicate topic slug ${t.slug}`);
    topicSlugs.add(t.slug);
    for (const field of ['id', 'name', 'slug', 'icon']) {
      if (isBlank(t[field])) err(`topic ${t.id ?? '?'}: ${field} is missing`);
    }
    // A document id may not contain a slash, and the ones used here become
    // both a Firestore path segment and a URL segment in the admin.
    if (/[/\s]/.test(t.id)) err(`topic id "${t.id}" contains a slash or whitespace`);
  }

  /* ---------------------------------------------------------- questions */
  const allowedLicences = licenceCodes();
  const questionIds = new Set();
  const perTopic = {};
  let withFigure = 0;
  const answers = {};
  const referencedFigures = new Set();

  for (const q of data.questions) {
    if (questionIds.has(q.id)) flag('duplicate question id', q.id);
    questionIds.add(q.id);
    perTopic[q.topicId] = (perTopic[q.topicId] ?? 0) + 1;

    if (!topicIds.has(q.topicId)) flag('topicId not among the topics', q.id);
    if (isBlank(q.text)) flag('empty text', q.id);
    if (/[/]/.test(q.id) || isBlank(q.id)) flag('id unusable as a Firestore document id', q.id);

    // The fields seed.js copies straight across. `subtopic: null` is fine and
    // `subtopic` missing is not — Firestore tells the two apart.
    for (const field of ['type', 'text', 'options', 'correctOptionId', 'explanation', 'subtopic', 'sourceRef']) {
      if (q[field] === undefined) flag(`field "${field}" missing`, q.id);
    }

    const options = Array.isArray(q.options) ? q.options : [];
    if (options.length < 2) flag('fewer than two options', q.id);
    const optionIds = new Set(options.map((o) => o.id));
    if (optionIds.size !== options.length) flag('duplicate option ids', q.id);
    if (!optionIds.has(q.correctOptionId)) flag('correctOptionId matches no option', q.id);
    answers[q.correctOptionId] = (answers[q.correctOptionId] ?? 0) + 1;

    if (q.licences !== undefined) {
      if (!Array.isArray(q.licences)) flag('licences is not an array', q.id);
      else {
        const bad = q.licences.filter((c) => !allowedLicences.includes(c));
        // The admin's form drops a code it does not know, silently, on the
        // next save — so one that gets this far would be lost in an edit.
        if (bad.length) flag(`licence code(s) the admin does not know (${bad.join(',')})`, q.id);
      }
    }

    if (q.sourceMedia) {
      withFigure += 1;
      referencedFigures.add(q.sourceMedia);
    }
  }

  for (const [kind, ids] of Object.entries(bucket)) {
    err(`${ids.length} question(s): ${kind} — first: ${ids.slice(0, 5).join(', ')}`);
  }

  const emptyTopics = data.topics.filter((t) => !perTopic[t.id]);
  if (emptyTopics.length) warn(`topics with no questions: ${emptyTopics.map((t) => t.id).join(', ')}`);
  for (const t of data.topics) {
    if (typeof t.questionCount === 'number' && t.questionCount !== (perTopic[t.id] ?? 0)) {
      warn(`topic ${t.id}: questionCount ${t.questionCount}, actually ${perTopic[t.id] ?? 0}`);
    }
  }

  /* ------------------------------------------------------------ figures */
  stats.figuresReferenced = referencedFigures.size;
  if (figuresDir && fs.existsSync(figuresDir)) {
    const missing = [...referencedFigures].filter((f) => !fs.existsSync(path.join(figuresDir, f)));
    if (missing.length) err(`${missing.length} referenced figure file(s) missing from ${figuresDir} — first: ${missing.slice(0, 3).join(', ')}`);
    stats.figuresOnDisk = fs.readdirSync(figuresDir).length;
  } else if (referencedFigures.size) {
    warn('figures directory not found, so the figure files were not checked');
  }

  /* ------------------------------------------------------- translations */
  const translations = data.translations ?? {};
  const byTopic = {};
  for (const q of data.questions) (byTopic[q.topicId] = byTopic[q.topicId] ?? []).push(q.id);
  stats.translations = {};
  let largest = { size: 0, where: '' };

  for (const [locale, entries] of Object.entries(translations)) {
    if (!localeCodes.has(locale)) warn(`translations for "${locale}", which is not a defined locale`);
    let covered = 0;
    let orphan = 0;
    for (const [id, tr] of Object.entries(entries)) {
      if (!questionIds.has(id)) {
        orphan += 1;
        continue;
      }
      covered += 1;
      if (isBlank(tr.text)) err(`${locale}/${id}: empty translation`);
    }
    if (orphan) warn(`${locale}: ${orphan} translation(s) for ids that are not in this bundle (the seed drops them)`);
    stats.translations[locale] = `${covered}/${data.questions.length}`;

    // One document per locale per topic, so what has to stay under the limit
    // is the largest topic in the largest language, not the whole bank.
    for (const t of data.topics) {
      const slice = {};
      for (const id of byTopic[t.id] ?? []) if (entries[id]) slice[id] = entries[id];
      if (!Object.keys(slice).length) continue;
      const size = bytes({ locale, questions: slice, deletedAt: null });
      if (size > largest.size) largest = { size, where: `${locale}/${t.id}` };
      if (size > DOC_LIMIT) err(`translation document ${locale}/${t.id} is ${(size / 1024).toFixed(0)} KB, over Firestore's 1 MiB`);
      else if (size > DOC_WARN) warn(`translation document ${locale}/${t.id} is ${(size / 1024).toFixed(0)} KB — close to Firestore's 1 MiB`);
    }
  }
  stats.largestTranslationDoc = largest.size ? `${(largest.size / 1024).toFixed(0)} KB (${largest.where})` : 'no translations yet';

  Object.assign(stats, {
    topics: data.topics.length,
    questions: data.questions.length,
    locales: data.locales.length,
    withFigure,
    withoutFigure: data.questions.length - withFigure,
    answers: Object.entries(answers).map(([k, v]) => `${k}:${v}`).join(' '),
  });

  return { errors, warnings, stats };
}

function printReport({ errors, warnings, stats }) {
  console.log('Bundle check');
  for (const [k, v] of Object.entries(stats)) {
    const shown = typeof v === 'object' ? JSON.stringify(v) : v;
    console.log(`  ${k.padEnd(22)} ${shown}`);
  }
  for (const w of warnings) console.log(`  warning: ${w}`);
  for (const e of errors) console.error(`  ERROR:   ${e}`);
  console.log(errors.length ? `  -> ${errors.length} error(s), nothing will be written` : '  -> OK');
  console.log('');
}

module.exports = { validateBundle, printReport };
