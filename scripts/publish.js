// Publishes the PL test set from the command line, the way the admin UI's
// Publish button does: mint a custom token for an admin user with the service
// account, exchange it for an ID token, POST to the publishTestSet callable.
//
// Usage: node scripts/publish.js
//   GOOGLE_APPLICATION_CREDENTIALS  path to the service-account key
//                                   (default: ./serviceAccountKey.json)
//   PUBLISH_UID                     uid of an admin user (default: the first admin)
//
// Takes ~30–60 s; prints the new versionHash. Verify afterwards at
// https://roadready-pl.web.app/content.json
const path = require('path');
const admin = require('firebase-admin');

/**
 * An environment value with no fallback.
 *
 * Every country-specific value in this repository is read this way on purpose.
 * A default would let a misconfigured instance write one country's content
 * into another's bundle, and that bundle reaches every installed app within
 * minutes — there is no store review in the way to catch it.
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see .env.local.example`);
  return value;
}


const KEY = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, '..', 'serviceAccountKey.json');
const UID = process.env.PUBLISH_UID || 'qVJaWfidxvTgpvvysfuqT6t6WLJ3';
// The web app's public Firebase API key (not a secret — it is in the client bundle).
const WEB_API_KEY = 'AIzaSyCX2GqbqLMqMT1iI0qFVcMHeHUEtETCx80';
const FUNCTION_URL = 'https://us-central1-roadready-pl.cloudfunctions.net/publishTestSet';

admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(KEY))) });

async function main() {
  const customToken = await admin.auth().createCustomToken(UID);
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
    body: JSON.stringify({ data: { countryCode: requireEnv('COUNTRY_CODE') } }),
  });
  const text = await res.text();
  console.log(res.status, `${((Date.now() - started) / 1000).toFixed(1)}s`, text.slice(0, 2000));
  if (!res.ok) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
