const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('../serviceAccountKey.json');

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


initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  const countries = await db.collection('countries').get();
  const locales = await db.collection('locales').get();
  const topics = await db
    .collection('countries')
    .doc(requireEnv('COUNTRY_CODE'))
    .collection('testsets')
    .doc('draft')
    .collection('topics')
    .get();
  let qCount = 0;
  for (const t of topics.docs) {
    const qs = await t.ref.collection('questions').get();
    qCount += qs.size;
  }
  console.log(
    JSON.stringify({ countries: countries.size, locales: locales.size, topics: topics.size, questions: qCount }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
