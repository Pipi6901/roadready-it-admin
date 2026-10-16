'use strict';

// Which languages a publish offers. The rule under test — a language with
// nothing translated into it is left out — exists because German and French
// are on the allowed list as languages the exam is sat in, while the
// ministry's German and French listati had not been imported: the first
// publish would have put both in the app's picker with every question falling
// back to Italian.

const test = require('node:test');
const assert = require('node:assert/strict');

const { publishableLocales } = require('../locales');

const ALLOWED = ['ro', 'ar', 'uk', 'es', 'en', 'de', 'fr'];
const loc = (code, sortOrder, extra = {}) => ({
  code,
  nameNative: code.toUpperCase(),
  nameEnglish: code,
  direction: code === 'ar' ? 'rtl' : 'ltr',
  flagEmoji: '🏳️',
  sortOrder,
  status: 'active',
  ...extra,
});
const entries = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q-${i}`, { text: 't' }]));
const codes = (r) => r.published.map((l) => l.code);

test('a language with no translations is left out, with the reason', () => {
  const r = publishableLocales([loc('ro', 0), loc('de', 5)], { ro: entries(3) }, ALLOWED);
  assert.deepEqual(codes(r), ['ro']);
  assert.deepEqual(r.leftOut, [{ code: 'de', why: 'no questions translated yet' }]);
});

test('a language that is on the list but whose catalogue is empty is left out too', () => {
  const r = publishableLocales([loc('fr', 6)], { fr: {} }, ALLOWED);
  assert.deepEqual(codes(r), []);
  assert.equal(r.leftOut[0].why, 'no questions translated yet');
});

test('a partly translated language is published — partial is better than none', () => {
  const r = publishableLocales([loc('ro', 0)], { ro: entries(1) }, ALLOWED);
  assert.deepEqual(codes(r), ['ro']);
});

test('a language that is not on the allowed list is left out even with content', () => {
  const r = publishableLocales([loc('zh', 3)], { zh: entries(5) }, ALLOWED);
  assert.deepEqual(codes(r), []);
  assert.deepEqual(r.leftOut, [{ code: 'zh', why: 'not on the allowed list' }]);
});

test('comes out in dashboard order, not in the order Firestore returned it', () => {
  const docs = [loc('en', 4), loc('uk', 2), loc('ro', 0), loc('ar', 1)];
  const t = { en: entries(1), uk: entries(1), ro: entries(1), ar: entries(1) };
  assert.deepEqual(codes(publishableLocales(docs, t, ALLOWED)), ['ro', 'ar', 'uk', 'en']);
});

test('carries the five fields the app reads and nothing internal', () => {
  const r = publishableLocales([loc('ar', 1, { secret: 'x' })], { ar: entries(1) }, ALLOWED);
  assert.deepEqual(Object.keys(r.published[0]).sort(), ['code', 'direction', 'flagEmoji', 'nameEnglish', 'nameNative']);
  assert.equal(r.published[0].direction, 'rtl');
});

test('no locales at all is an empty bundle list, not an error', () => {
  const r = publishableLocales([], {}, ALLOWED);
  assert.deepEqual(r, { published: [], leftOut: [] });
});

test('a missing sortOrder sorts first rather than breaking the comparison', () => {
  const docs = [loc('uk', 2), { ...loc('ro', 0), sortOrder: undefined }];
  const t = { uk: entries(1), ro: entries(1) };
  assert.deepEqual(codes(publishableLocales(docs, t, ALLOWED)), ['ro', 'uk']);
});
