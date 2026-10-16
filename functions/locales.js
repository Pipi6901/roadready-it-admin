'use strict';

// Which locales a publish puts in the bundle.
//
// A locale is listed in two senses at once: it has to be allowed (the
// V1_LOCALE_CODES list in index.js), and it has to have something in it. The
// second rule is new. Before it, a locale document that existed in Firestore
// and was on the allowed list was published whether or not a single question
// had been translated into it — and the app splices the bundle's locale list
// straight into its question-language picker. German and French in particular
// sit on the list because they are languages the exam is sat in, but the
// ministry's German and French listati are separate files that had not been
// imported, so the first publish would have offered two languages whose every
// question then fell back to Italian.
//
// Kept as a pure function so that rule has a test; the function it is called
// from needs Firestore to run at all.

/**
 * @param {Array<object>} localeDocs   the `locales` collection, as stored
 * @param {Object<string, object>} translations   locale code -> { questionId -> entry }
 * @param {string[]} allowed
 * @returns {{ published: object[], leftOut: Array<{code: string, why: string}> }}
 */
function publishableLocales(localeDocs, translations, allowed) {
  const published = [];
  const leftOut = [];

  for (const l of localeDocs) {
    if (!allowed.includes(l.code)) {
      leftOut.push({ code: l.code, why: 'not on the allowed list' });
      continue;
    }
    const covered = Object.keys(translations[l.code] ?? {}).length;
    if (covered === 0) {
      leftOut.push({ code: l.code, why: 'no questions translated yet' });
      continue;
    }
    published.push(l);
  }

  // In dashboard order (sortOrder from the seed), not Firestore's document
  // order — the app splices this list straight into its language picker, and
  // alphabetical would put English above Ukrainian for an audience that is
  // three-quarters Ukrainian.
  published.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

  return {
    published: published.map((l) => ({
      code: l.code,
      nameNative: l.nameNative,
      nameEnglish: l.nameEnglish,
      direction: l.direction,
      flagEmoji: l.flagEmoji,
    })),
    leftOut,
  };
}

module.exports = { publishableLocales };
