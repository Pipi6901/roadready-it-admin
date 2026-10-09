const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('../serviceAccountKey.json');

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  const countries = await db.collection('countries').get();
  const locales = await db.collection('locales').get();
  const topics = await db
    .collection('countries')
    .doc('PL')
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
