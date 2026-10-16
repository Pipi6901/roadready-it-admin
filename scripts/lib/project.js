'use strict';

// What every script that talks to the live project shares: which project that
// is, and the refusal to carry on if the key it was handed belongs to another.
//
// Why this exists. The Google account that owns this project also owns the
// Polish and the British ones, and a service-account key is a plain JSON file
// that looks the same whichever console it came from. Nothing in the Admin SDK
// objects to a key for the wrong project — it simply writes where the key
// points — so `seed.js` run with the Polish key would have put seven thousand
// Italian statements into the Polish database, and the first anyone would
// know is a Polish learner asked about the Codice della Strada. The same
// mistake has already been made once in this repo's neighbour: publish.js was
// copied from the Polish admin carrying the Polish web key and a Polish user
// id, and failed with an error that said nothing about either.
//
// So the project is named here once, checked against the key, and every
// script goes through loadServiceAccount() instead of requiring the file.

const fs = require('fs');
const path = require('path');

const PROJECT_ID = 'roadready-it';
const ROOT = path.resolve(__dirname, '..', '..');

function fail(lines) {
  console.error('');
  for (const line of lines) console.error(line);
  console.error('');
  process.exit(1);
}

/** The project `.firebaserc` makes the default, or null when it cannot be read. */
function firebasercDefault() {
  try {
    const rc = JSON.parse(fs.readFileSync(path.join(ROOT, '.firebaserc'), 'utf8'));
    return rc.projects?.default ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the service-account key and refuses to return it unless it belongs to
 * this project. `file` is for the one script that lets the caller point at a
 * key elsewhere (GOOGLE_APPLICATION_CREDENTIALS); the check applies all the same.
 */
function loadServiceAccount(file = path.join(ROOT, 'serviceAccountKey.json')) {
  if (!fs.existsSync(file)) {
    fail([
      `No service-account key at ${file}.`,
      `Firebase Console -> ${PROJECT_ID} -> Project settings -> Service accounts ->`,
      'Generate new private key, and save it there under that name.',
      'It is gitignored and must stay that way.',
    ]);
  }

  let key;
  try {
    key = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail([`${file} is not valid JSON (${e.message}).`, 'Download the key again; do not edit it by hand.']);
  }

  if (key.type !== 'service_account' || !key.private_key || !key.client_email) {
    fail([
      `${file} is not a service-account key.`,
      'A web app config or an OAuth client file will not do — it has to be the',
      '"Generate new private key" download from Service accounts.',
    ]);
  }

  if (key.project_id !== PROJECT_ID) {
    fail([
      `REFUSING TO RUN: this key belongs to project "${key.project_id}",`,
      `but this admin is for "${PROJECT_ID}".`,
      '',
      'Running it anyway would write Italian content into that other project.',
      `Download the key from the ${PROJECT_ID} console instead — the project`,
      'selector at the top left of the Firebase Console decides which one you get.',
    ]);
  }

  const rc = firebasercDefault();
  if (rc && rc !== PROJECT_ID) {
    fail([
      `.firebaserc names "${rc}" as the default project, but this admin is for "${PROJECT_ID}".`,
      'Those two must agree, or `firebase deploy` without --project goes to the wrong place.',
    ]);
  }

  return key;
}

/** `KEY=value` lines of an env file, without quoting rules or interpolation. */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/**
 * The web app's public API key. Read from the same place the admin itself reads
 * it (.env.local) rather than written into a script, so that it cannot be a
 * key from some other project's copy of the script.
 */
function webApiKey() {
  const key = process.env.NEXT_PUBLIC_FIREBASE_API_KEY || readEnvFile(path.join(ROOT, '.env.local')).NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!key) {
    fail([
      'NEXT_PUBLIC_FIREBASE_API_KEY is not set and .env.local does not have it.',
      'The web app config for this project goes in .env.local — see README.',
    ]);
  }
  return key;
}

module.exports = { PROJECT_ID, ROOT, loadServiceAccount, readEnvFile, webApiKey };
