// Seed: imports a content.json bundle into Firestore as the draft test-set,
// so the admin starts populated instead of empty — and re-running it makes
// Firestore match the file again (stale questions are deleted, translation
// documents rewritten whole).
//
// Usage: node scripts/seed.js [path/to/content.json]
// Default: ../../roadready-it/content/listato/content.json — the ministerial
//   listato, produced by `python scripts/import_listato.py` in the mobile
//   repo.

const fs = require('fs');
const path = require('path');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require('../serviceAccountKey.json');
const contentPath = path.resolve(
  __dirname,
  process.argv[2] ?? '../../roadready-it/content/listato/content.json',
);

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();

async function main() {
  const raw = fs.readFileSync(contentPath, 'utf8');
  const data = JSON.parse(raw);

  const primaryCountry = data.country;
  const countries = data.countries;
  const locales = data.locales;
  const topics = data.topics;
  const questions = data.questions;
  const translations = data.translations ?? {};

  console.log(
    `Seeding: ${countries.length} countries, ${locales.length} locales, ${topics.length} topics, ${questions.length} questions`,
  );

  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = db.batch();
    ops = 0;
  };
  const set = (ref, value) => {
    batch.set(ref, value, { merge: true });
    ops += 1;
  };

  // --- locales ---------------------------------------------------------
  for (const [i, locale] of locales.entries()) {
    set(db.collection('locales').doc(locale.code), {
      code: locale.code,
      nameNative: locale.nameNative,
      nameEnglish: locale.nameEnglish,
      direction: locale.direction,
      flagEmoji: locale.flagEmoji,
      status: 'active',
      sortOrder: i,
    });
  }

  // --- countries ---------------------------------------------------------
  for (const [i, country] of countries.entries()) {
    set(db.collection('countries').doc(country.code), {
      code: country.code,
      name: country.name,
      flagEmoji: country.flagEmoji,
      authority: country.authority,
      legalNotice: country.legalNotice,
      testTypes: ['car'],
      status: country.status,
      questionCount: country.questionCount,
      mockTest: country.mockTest,
      currency: country.currency,
      defaultLocale: 'uk',
      sortOrder: i,
      deletedAt: null,
    });
  }

  // --- draft testset for the primary (content-bearing) country ----------
  const testsetRef = db
    .collection('countries')
    .doc(primaryCountry.code)
    .collection('testsets')
    .doc('draft');
  set(testsetRef, {
    version: data.versionHash,
    status: 'draft',
    effectiveFrom: null,
    archivedAt: null,
    versionHash: null,
    bundleUrl: null,
    bundleSize: null,
    publishedAt: null,
    publishedBy: null,
    deletedAt: null,
  });

  await flush();

  // --- topics --------------------------------------------------------
  for (const [i, topic] of topics.entries()) {
    set(testsetRef.collection('topics').doc(topic.id), {
      name: topic.name,
      slug: topic.slug,
      icon: topic.icon,
      sortOrder: topic.sortOrder ?? i,
      color: null,
      category: topic.category ?? 'basic',
      deletedAt: null,
    });
  }
  await flush();

  // Questions that are no longer in the export get removed, not merged over:
  // the seed is the bank, and a stale document left behind would be published
  // right alongside the new ones. (The first PL seed carried British
  // questions with 'q-road-signs-*' ids; this is what clears them.)
  const wanted = new Set(questions.map((q) => q.id));
  const existingIds = new Set();
  let removed = 0;
  for (const topic of topics) {
    const existing = await testsetRef.collection('topics').doc(topic.id).collection('questions').get();
    for (const doc of existing.docs) {
      existingIds.add(doc.id);
      if (wanted.has(doc.id)) continue;
      batch.delete(doc.ref);
      ops += 1;
      removed += 1;
      if (ops >= 400) await flush();
    }
  }
  await flush();
  if (removed) console.log(`Removed ${removed} stale question(s).`);

  // --- questions (batched, 400 at a time to stay under the 500-op limit) -
  let sortOrderByTopic = {};
  for (const question of questions) {
    const n = (sortOrderByTopic[question.topicId] ?? -1) + 1;
    sortOrderByTopic[question.topicId] = n;

    const qRef = testsetRef
      .collection('topics')
      .doc(question.topicId)
      .collection('questions')
      .doc(question.id);
    set(qRef, {
      type: question.type,
      text: question.text,
      options: question.options,
      correctOptionId: question.correctOptionId,
      explanation: question.explanation,
      // The catalogue export carries no mediaId — attachments are made by
      // scripts/import-media.js after the fact. Merging null over them on a
      // re-seed would detach every picture, so an existing document keeps
      // its own unless the file names one; a new document gets an explicit
      // null for the editor to read.
      ...(question.mediaId || !existingIds.has(question.id) ? { mediaId: question.mediaId ?? null } : {}),
      subtopic: question.subtopic,
      sourceRef: question.sourceRef,
      category: question.category ?? 'basic',
      points: question.points ?? 1,
      // Catalogue fields (see ../src/lib/types.ts): licence categories the
      // question is asked for, and the ministry's media file name.
      licences: question.licences ?? [],
      sourceMedia: question.sourceMedia ?? null,
      sortOrder: n,
      deletedAt: null,
    });
    if (ops >= 400) await flush();
  }
  await flush();

  // --- translations: one doc per locale under each topic -----------------
  // Keyed by question id. Per topic rather than per set so a full 3,500
  // question bank stays under Firestore's 1 MB document limit (the biggest
  // topic in the catalogue comes to ~130 KB per locale). Written whole, not
  // merged: an entry for a question that left the topic must go with it.
  // Locale documents the file does not carry are deleted for the same reason.
  let translated = 0;
  const fileLocales = new Set(Object.keys(translations));
  for (const topic of topics) {
    const trCollection = testsetRef.collection('topics').doc(topic.id).collection('translations');
    const existing = await trCollection.get();
    for (const doc of existing.docs) {
      if (fileLocales.has(doc.id)) continue;
      batch.delete(doc.ref);
      ops += 1;
    }
    for (const [locale, byQuestion] of Object.entries(translations)) {
      const entries = {};
      for (const question of questions) {
        if (question.topicId !== topic.id) continue;
        const tr = byQuestion[question.id];
        if (tr) entries[question.id] = tr;
      }
      if (!Object.keys(entries).length) {
        batch.delete(trCollection.doc(locale));
        ops += 1;
        continue;
      }
      batch.set(trCollection.doc(locale), { locale, questions: entries, deletedAt: null });
      ops += 1;
      translated += Object.keys(entries).length;
    }
    // These documents are big; a commit is capped at 10 MB, so flush per topic.
    await flush();
  }
  console.log(`Translations: ${translated} question entries across ${Object.keys(translations).length} locale(s).`);

  console.log('Seed complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
