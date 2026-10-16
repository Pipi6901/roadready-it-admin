'use strict';

// The publish path, end to end, with the network replaced by a recorder.
//
// What is worth pinning down is not that the happy path works — a publish
// would show that — but the properties a publish cannot afford to find out
// about on a live site: the order of the calls, that what is hashed is what is
// uploaded, and above all that a failure part-way through never reaches
// `release`. A version released with a file missing is a site serving a 404
// where the bundle was.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { deployFiles } = require('../hosting');

const SITE = 'roadready-it';
const VERSION = `sites/${SITE}/versions/abc123`;
const UPLOAD_URL = 'https://upload.example/files';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const gz = (text) => zlib.gzipSync(Buffer.from(text));

const FILES = {
  '/content.json': JSON.stringify({ versionHash: 'admin-it-1', questions: ['…'] }),
  '/version.json': JSON.stringify({ versionHash: 'admin-it-1' }),
};
const RULES = [
  { glob: '/content.json', headers: { 'Cache-Control': 'public, max-age=300' } },
  { glob: '/version.json', headers: { 'Cache-Control': 'public, max-age=60' } },
];

const reply = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/**
 * A fetch that records every call and answers each step of the flow. `override`
 * maps a step name to a replacement response, which is how a step is made to fail.
 */
function recorder(override = {}) {
  const calls = [];
  const step = (url, init) => {
    if (url.endsWith('/versions')) return 'create';
    if (url.endsWith(':populateFiles')) return 'populate';
    if (url.startsWith(UPLOAD_URL)) return 'upload';
    if (url.includes('?updateMask=status')) return 'finalize';
    if (url.includes('/releases?')) return 'release';
    throw new Error(`unexpected request ${init.method} ${url}`);
  };
  const defaults = {
    create: () => reply({ name: VERSION }),
    populate: () => reply({ uploadUrl: UPLOAD_URL }),
    upload: () => reply('', { ok: true }),
    finalize: () => reply({}),
    release: () => reply({}),
  };
  const fetchImpl = async (url, init) => {
    const name = step(url, init);
    calls.push({ name, url, method: init.method, headers: init.headers, body: init.body });
    return (override[name] ?? defaults[name])();
  };
  return { fetchImpl, calls };
}

const run = (rec, files = FILES) =>
  deployFiles({
    siteId: SITE,
    files,
    headers: RULES,
    getToken: async () => 'tok',
    fetchImpl: rec.fetchImpl,
  });

test('deploys in the documented order: create, populate, upload each, finalize, release', async () => {
  const rec = recorder();
  await run(rec);
  assert.deepEqual(rec.calls.map((c) => c.name), ['create', 'populate', 'upload', 'upload', 'finalize', 'release']);
});

test('the version carries the cache headers for both files', async () => {
  const rec = recorder();
  await run(rec);
  const create = rec.calls[0];
  assert.equal(create.url, `https://firebasehosting.googleapis.com/v1beta1/sites/${SITE}/versions`);
  assert.deepEqual(JSON.parse(create.body), { config: { headers: RULES } });
});

test('populateFiles names both paths, hashed over the gzipped bytes', async () => {
  const rec = recorder();
  await run(rec);
  const populate = rec.calls[1];
  assert.equal(populate.url, `https://firebasehosting.googleapis.com/v1beta1/${VERSION}:populateFiles`);
  assert.deepEqual(JSON.parse(populate.body).files, {
    '/content.json': sha(gz(FILES['/content.json'])),
    '/version.json': sha(gz(FILES['/version.json'])),
  });
});

test('what is uploaded under a hash is the gzip that hash was computed from', async () => {
  const rec = recorder();
  await run(rec);
  const uploads = rec.calls.filter((c) => c.name === 'upload');
  assert.equal(uploads.length, 2);
  for (const u of uploads) {
    const hash = u.url.slice(UPLOAD_URL.length + 1);
    assert.equal(sha(u.body), hash, 'the body does not hash to the hash in the URL');
    assert.equal(u.headers['Content-Type'], 'application/octet-stream');
    // ...and it round-trips to one of the two files we sent.
    assert.ok(Object.values(FILES).includes(zlib.gunzipSync(u.body).toString()));
  }
});

test('finalizes, then releases exactly the version it created', async () => {
  const rec = recorder();
  const out = await run(rec);
  const [finalize, release] = rec.calls.slice(-2);
  assert.equal(finalize.method, 'PATCH');
  assert.deepEqual(JSON.parse(finalize.body), { status: 'FINALIZED' });
  assert.equal(release.url, `https://firebasehosting.googleapis.com/v1beta1/sites/${SITE}/releases?versionName=${VERSION}`);
  assert.equal(out.version, VERSION);
});

test('every call is authorised with the token it was given', async () => {
  const rec = recorder();
  await run(rec);
  for (const c of rec.calls) assert.equal(c.headers.Authorization, 'Bearer tok', `${c.name} lacks the token`);
});

test('asks for the token once, not once per request', async () => {
  const rec = recorder();
  let asked = 0;
  await deployFiles({
    siteId: SITE,
    files: FILES,
    headers: RULES,
    getToken: async () => {
      asked += 1;
      return 'tok';
    },
    fetchImpl: rec.fetchImpl,
  });
  assert.equal(asked, 1);
});

test('uploads only the hashes the API says it still needs', async () => {
  const wanted = sha(gz(FILES['/version.json']));
  const rec = recorder({ populate: () => reply({ uploadUrl: UPLOAD_URL, uploadRequiredHashes: [wanted] }) });
  await run(rec);
  const uploads = rec.calls.filter((c) => c.name === 'upload');
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].url.endsWith(wanted));
});

test('uploads nothing at all when the API already has every file', async () => {
  const rec = recorder({ populate: () => reply({ uploadUrl: UPLOAD_URL, uploadRequiredHashes: [] }) });
  await run(rec);
  assert.equal(rec.calls.filter((c) => c.name === 'upload').length, 0);
  assert.equal(rec.calls.at(-1).name, 'release');
});

test('refuses to upload a hash it never sent', async () => {
  const rec = recorder({ populate: () => reply({ uploadUrl: UPLOAD_URL, uploadRequiredHashes: ['f'.repeat(64)] }) });
  await assert.rejects(run(rec), /asked for a hash we did not send/);
  assert.ok(!rec.calls.some((c) => c.name === 'release'));
});

/* ---------------------------------------------------------------- failures */

const FAILURES = [
  ['create', () => reply({ error: { message: 'quota' } }), /Failed to create hosting version/, ['create']],
  ['populate', () => reply({ error: 'nope' }), /Failed to populate files/, ['create', 'populate']],
  ['upload', () => reply('forbidden', { ok: false, status: 403 }), /Hosting upload failed: 403 forbidden/, ['create', 'populate', 'upload']],
  ['finalize', () => reply('bad', { ok: false, status: 400 }), /Failed to finalize version: 400/, ['create', 'populate', 'upload', 'upload', 'finalize']],
  ['release', () => reply('denied', { ok: false, status: 403 }), /Failed to release version: 403/, ['create', 'populate', 'upload', 'upload', 'finalize', 'release']],
];

for (const [step, response, message, expectedCalls] of FAILURES) {
  test(`a failure at "${step}" throws, and nothing after it is called`, async () => {
    const rec = recorder({ [step]: response });
    await assert.rejects(run(rec), message);
    assert.deepEqual(rec.calls.map((c) => c.name), expectedCalls);
  });
}

test('a failed upload never reaches finalize or release — no half-published site', async () => {
  const rec = recorder({ upload: () => reply('boom', { ok: false, status: 500 }) });
  await assert.rejects(run(rec));
  assert.ok(!rec.calls.some((c) => c.name === 'finalize' || c.name === 'release'));
});

/* ------------------------------------------------------------------ inputs */

test('rejects a path without a leading slash before any request is made', async () => {
  const rec = recorder();
  await assert.rejects(run(rec, { 'content.json': '{}' }), /must start with a slash/);
  assert.equal(rec.calls.length, 0);
});

test('rejects an empty deploy before any request is made', async () => {
  const rec = recorder();
  await assert.rejects(run(rec, {}), /nothing to deploy/);
  assert.equal(rec.calls.length, 0);
});

test('a single file still deploys — the shape the function had before version.json', async () => {
  const rec = recorder();
  await run(rec, { '/content.json': FILES['/content.json'] });
  assert.deepEqual(rec.calls.map((c) => c.name), ['create', 'populate', 'upload', 'finalize', 'release']);
});
