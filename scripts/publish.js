// Publishes the Italian test set from the command line, the way the admin UI's
// Publish button does: mint a custom token for an admin user with the service
// account, exchange it for an ID token, POST to the publishTestSet callable.
//
// Usage: node scripts/publish.js
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account key
//                                   (default: ./serviceAccountKey.json)
//   PUBLISH_UID                     uid of an admin user (default: the first
//                                   document in adminUsers with role "admin")
//
// Takes ~30–60 s; prints the new versionHash. Verify afterwards at
// https://roadready-it.web.app/content.json
//
// This script was copied from the Polish admin and came with three things that
// were the Polish project's, none of which said so: its web API key, a literal
// user id standing in for "the first admin", and a header that said PL. With
// the Polish key the sign-in step is refused by a project that has never heard
// of this service account; with the Polish uid the function answers
// permission-denied, because that user is not in this project's adminUsers.
// Neither error mentions where it came from. Now the key is read from
// .env.local, the admin is looked up, and the function's address is built from
// the project the service-account key was checked against.
const path = require('path');
const admin = require('firebase-admin');
const { PROJECT_ID, loadServiceAccount, webApiKey } = require('./lib/project');

const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  : undefined;
// Refuses a key that belongs to any other project.
admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount(keyFile)) });

const WEB_API_KEY = webApiKey();
// Derived, not typed: the address and the key cannot name different projects.
const FUNCTION_URL = `https://us-central1-${PROJECT_ID}.cloudfunctions.net/publishTestSet`;

async function adminUid() {
  if (process.env.PUBLISH_UID) return process.env.PUBLISH_UID;
  const snap = await admin.firestore().collection('adminUsers').where('role', '==', 'admin').limit(1).get();
  if (snap.empty) {
    throw new Error('No admin in adminUsers yet — run `node scripts/invite-first-admin.js <email>` first.');
  }
  return snap.docs[0].id;
}

async function main() {
  const uid = await adminUid();
  console.log(`Publishing to ${PROJECT_ID} as ${uid}`);

  const customToken = await admin.auth().createCustomToken(uid);
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const { idToken, error } = await r.json();
  if (!idToken) throw new Error('sign-in failed: ' + JSON.stringify(error));

  const started = Date.now();
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
    body: JSON.stringify({ data: { countryCode: 'IT' } }),
  });
  const text = await res.text();
  console.log(res.status, `${((Date.now() - started) / 1000).toFixed(1)}s`, text.slice(0, 2000));
  if (!res.ok) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
