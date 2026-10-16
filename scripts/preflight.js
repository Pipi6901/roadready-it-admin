#!/usr/bin/env node
'use strict';

// One look at everything that has to be true before the first deploy, and what
// is still missing — local files, the cloud project, and the things the CLI
// cannot see, probed from outside with nothing but the public web key.
//
//   node scripts/preflight.js
//
// Changes nothing and needs no service-account key. Exit code 1 if anything it
// can check is missing, so it can sit in front of a deploy.
//
// The probes are what make this useful before the plan is upgraded. Whether the
// Storage bucket exists, whether Authentication is initialised with
// Email/Password on, whether Firestore has a database — none of that is in the
// CLI's reach without a token, but each has a distinct, unauthenticated answer:
//   Storage   GET  .../v0/b/<bucket>/o            404 = no bucket, 401/403 = there
//   Auth      POST accounts:signInWithPassword    CONFIGURATION_NOT_FOUND = never
//             initialised, OPERATION_NOT_ALLOWED = password sign-in off,
//             anything else about the credentials = on
//   Firestore GET  .../documents/countries        SERVICE_DISABLED = API off,
//             404 = no database, 403 = database there, rules closed

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { PROJECT_ID, ROOT, readEnvFile } = require('./lib/project');
const { validateBundle } = require('./lib/bundle');

const rows = [];
const ok = (label, detail = '') => rows.push({ s: 'ok', label, detail });
const missing = (label, detail = '') => rows.push({ s: 'MISSING', label, detail });
const manual = (label, detail = '') => rows.push({ s: 'manual', label, detail });
const note = (label, detail = '') => rows.push({ s: 'note', label, detail });
const section = (title) => rows.push({ s: 'section', label: title });

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);

/** Runs the Firebase CLI with --json; returns the parsed `result` or null. */
function cli(args) {
  try {
    const out = execSync(`firebase ${args} --project ${PROJECT_ID} --json`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90000,
    });
    return JSON.parse(out).result ?? null;
  } catch (e) {
    const text = `${e.stdout ?? ''}`;
    try {
      const body = JSON.parse(text.slice(text.indexOf('{')));
      return { error: String(body.error?.message ?? body.error ?? 'failed') };
    } catch {
      return { error: String(e.message).split('\n')[0] };
    }
  }
}

async function probe(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, error: e.message };
  }
}

async function main() {
  const envLocal = readEnvFile(path.join(ROOT, '.env.local'));
  const fnEnv = readEnvFile(path.join(ROOT, 'functions', '.env'));
  const apiKey = envLocal.NEXT_PUBLIC_FIREBASE_API_KEY;
  const bucket = envLocal.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET;

  /* ------------------------------------------------------------ local */
  section('Local files');

  let rc = null;
  try {
    rc = JSON.parse(read(path.join(ROOT, '.firebaserc'))).projects?.default;
  } catch {
    /* handled below */
  }
  rc === PROJECT_ID ? ok('.firebaserc default project', rc) : missing('.firebaserc default project', `is "${rc}", must be "${PROJECT_ID}"`);

  const required = [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
    'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
    'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
  ];
  const lacking = required.filter((k) => !envLocal[k]);
  if (!exists(path.join(ROOT, '.env.local'))) missing('.env.local', 'not there');
  else if (lacking.length) missing('.env.local', `lacks ${lacking.join(', ')}`);
  else if (envLocal.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PROJECT_ID) missing('.env.local', `names project "${envLocal.NEXT_PUBLIC_FIREBASE_PROJECT_ID}", not "${PROJECT_ID}"`);
  else if (!bucket.startsWith(`${PROJECT_ID}.`)) missing('.env.local', `storage bucket "${bucket}" is not this project's`);
  else ok('.env.local', 'six values, all for this project');

  if (!exists(path.join(ROOT, 'functions', '.env'))) missing('functions/.env', 'not there — inviteUser needs WEB_API_KEY');
  else if (!fnEnv.WEB_API_KEY) missing('functions/.env', 'has no WEB_API_KEY');
  else if (fnEnv.WEB_API_KEY !== apiKey) missing('functions/.env', 'WEB_API_KEY differs from NEXT_PUBLIC_FIREBASE_API_KEY');
  else ok('functions/.env', 'WEB_API_KEY matches the web key');

  const keyFile = path.join(ROOT, 'serviceAccountKey.json');
  if (!exists(keyFile)) {
    missing('serviceAccountKey.json', 'download it: Firebase Console -> Project settings -> Service accounts');
  } else {
    try {
      const k = JSON.parse(read(keyFile));
      k.project_id === PROJECT_ID
        ? ok('serviceAccountKey.json', `for ${k.project_id}`)
        : missing('serviceAccountKey.json', `belongs to "${k.project_id}" — WRONG PROJECT, do not use it`);
    } catch {
      missing('serviceAccountKey.json', 'is not valid JSON');
    }
  }

  // The same literals live in several files; they have to name one project.
  const fnIndex = read(path.join(ROOT, 'functions', 'index.js'));
  const siteId = (fnIndex.match(/HOSTING_SITE_ID\s*=\s*'([^']+)'/) ?? [])[1];
  siteId === PROJECT_ID ? ok('functions/index.js HOSTING_SITE_ID', siteId) : missing('functions/index.js HOSTING_SITE_ID', `"${siteId}" — the app fetches from ${PROJECT_ID}.web.app`);

  const importMedia = read(path.join(ROOT, 'scripts', 'import-media.js'));
  const importBucket = (importMedia.match(/BUCKET\s*=\s*'([^']+)'/) ?? [])[1];
  importBucket === bucket ? ok('import-media.js bucket', importBucket) : missing('import-media.js bucket', `"${importBucket}" vs .env.local "${bucket}"`);

  const appRemote = path.resolve(ROOT, '..', 'roadready-it', 'src', 'data', 'remoteContent.ts');
  if (exists(appRemote)) {
    const src = read(appRemote);
    const url = (src.match(/CONTENT_URL\s*=\s*'([^']+)'/) ?? [])[1] ?? '';
    const expected = (src.match(/EXPECTED_COUNTRY\s*=\s*'([^']+)'/) ?? [])[1];
    url.startsWith(`https://${siteId}.web.app/`) ? ok('app CONTENT_URL', url) : missing('app CONTENT_URL', `${url} does not point at ${siteId}.web.app`);
    expected === 'IT' ? ok('app EXPECTED_COUNTRY', expected) : missing('app EXPECTED_COUNTRY', `"${expected}"`);
  } else {
    note('app remoteContent.ts', 'sibling repo roadready-it not found, skipped');
  }

  const bundlePath = path.resolve(ROOT, '..', 'roadready-it', 'content', 'listato', 'content.json');
  if (exists(bundlePath)) {
    const report = validateBundle(JSON.parse(read(bundlePath)), { figuresDir: path.join(path.dirname(bundlePath), 'figures') });
    report.errors.length
      ? missing('listato bundle', `${report.errors.length} error(s) — run: node scripts/seed.js --dry-run`)
      : ok('listato bundle', `${report.stats.questions} statements, ${report.stats.topics} topics, ${report.stats.figuresReferenced} figures present`);
    for (const w of report.warnings) note('bundle', w);
  } else {
    missing('listato bundle', `${bundlePath} not found — run import_listato.py`);
  }

  /* ------------------------------------------------------------ cloud */
  section(`Cloud project ${PROJECT_ID} (through the Firebase CLI)`);

  const projects = cli('projects:list');
  const listed = Array.isArray(projects) && projects.some((p) => p.projectId === PROJECT_ID);
  if (!Array.isArray(projects)) {
    missing('CLI login', `${projects?.error ?? 'cannot list projects'} — run: firebase login`);
  } else {
    listed ? ok('project visible to the CLI login', PROJECT_ID) : missing('project visible to the CLI login', `${PROJECT_ID} is not in this account`);
  }

  if (listed) {
    const apps = cli('apps:list');
    Array.isArray(apps) && apps.some((a) => a.platform === 'WEB')
      ? ok('web app registered', apps.find((a) => a.platform === 'WEB').displayName)
      : missing('web app registered', 'firebase apps:create WEB "RoadReady IT Admin"');

    const sites = cli('hosting:sites:list');
    const ids = Array.isArray(sites?.sites) ? sites.sites.map((s) => String(s.name).split('/').pop()) : [];
    for (const id of [PROJECT_ID, 'roadready-it-admin']) {
      ids.includes(id) ? ok(`Hosting site ${id}`, `https://${id}.web.app`) : missing(`Hosting site ${id}`, `firebase hosting:sites:create ${id}`);
    }
  }

  /* ----------------------------------------------------------- probes */
  section('Probed from outside (public web key only)');

  if (!apiKey) {
    missing('probes', 'need NEXT_PUBLIC_FIREBASE_API_KEY in .env.local');
  } else {
    const fs_ = await probe(`https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/countries?pageSize=1&key=${apiKey}`);
    const reason = JSON.stringify(fs_.body ?? '');
    if (fs_.status === 200) ok('Firestore database', 'exists — and its rules are OPEN to the public, check firestore.rules');
    else if (fs_.status === 403 && /SERVICE_DISABLED|has not been used/i.test(reason)) missing('Firestore database', 'Firestore API is off, so there is no database — `firebase deploy --only firestore` enables it and creates one (in nam5, the CLI default; create it in the Console first to choose another)');
    else if (fs_.status === 404) missing('Firestore database', 'API is on but the (default) database does not exist — Console -> Firestore -> Create database, choosing the location yourself');
    else if (fs_.status === 403) {
      ok('Firestore database', 'exists, rules closed to the public');
      const dbs = cli('firestore:databases:list');
      const where = Array.isArray(dbs) && dbs[0] ? dbs[0].locationId : null;
      if (where) {
        const us = /^(nam|us-)/.test(where);
        note(
          'Firestore location',
          us
            ? `${where} (United States). Fine for the admin and for publishTestSet, which runs in us-central1 beside it, and the app never reads Firestore. It cannot be moved: to have it in Europe, delete the database and create it again in europe-west8, then redeploy the rules.`
            : `${where}`,
        );
      }
    }
    else note('Firestore database', `unexpected answer ${fs_.status} ${fs_.error ?? ''}`);

    const st = await probe(`https://firebasestorage.googleapis.com/v0/b/${bucket}/o?maxResults=1`);
    if (st.status === 404) missing('Storage bucket', `${bucket} does not exist — needs the Blaze plan, then Console -> Storage -> Get started, with a European location`);
    else if (st.status === 200) ok('Storage bucket', 'exists — and is readable without sign-in, check storage.rules');
    else if (st.status === 401 || st.status === 403) ok('Storage bucket', `${bucket} exists`);
    else note('Storage bucket', `unexpected answer ${st.status} ${st.error ?? ''}`);

    const au = await probe(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'preflight-probe@example.com', password: 'not-a-real-password', returnSecureToken: true }),
    });
    const msg = String(au.body?.error?.message ?? '');
    if (/CONFIGURATION_NOT_FOUND/.test(msg)) missing('Authentication', 'never initialised — Console -> Authentication -> Get started');
    else if (/OPERATION_NOT_ALLOWED|PASSWORD_LOGIN_DISABLED/.test(msg)) missing('Authentication Email/Password', 'initialised but password sign-in is off — enable it under Sign-in method');
    else if (/EMAIL_NOT_FOUND|INVALID_PASSWORD|INVALID_LOGIN_CREDENTIALS|USER_DISABLED/.test(msg)) ok('Authentication Email/Password', 'on');
    else if (/API_KEY|KEY_INVALID|API_KEY_SERVICE_BLOCKED/.test(msg)) missing('Authentication', `the web key was refused: ${msg}`);
    else note('Authentication', `unexpected answer ${au.status} ${msg || au.error || ''}`);
  }

  /* ----------------------------------------------------------- manual */
  section('Cannot be checked from here');
  manual('Blaze plan', 'Console -> Upgrade. Functions, Storage and the Next.js admin on Hosting all need it. Set a budget alert in the same visit — Blaze has no hard cap.');
  manual(
    'Storage bucket location',
    'Choose a European one (europe-west8, Milan, or the EU multi-region). This is the region that matters: the app loads every figure from the bucket, so its distance from Italian users is felt on each question. It cannot be changed afterwards.',
  );

  /* ----------------------------------------------------------- report */
  const icon = { ok: '  ok     ', MISSING: '  MISSING', manual: '  manual ', note: '  note   ' };
  console.log('');
  console.log(`Preflight for ${PROJECT_ID}`);
  for (const r of rows) {
    if (r.s === 'section') {
      console.log(`\n${r.label}`);
      continue;
    }
    console.log(`${icon[r.s]} ${r.label}${r.detail ? ' — ' + r.detail : ''}`);
  }

  const gaps = rows.filter((r) => r.s === 'MISSING');
  console.log('');
  if (gaps.length) {
    console.log(`${gaps.length} thing(s) still to do:`);
    for (const g of gaps) console.log(`  - ${g.label}`);
  } else {
    console.log('Everything checkable is in place.');
  }
  process.exit(gaps.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
