// Fills in `bytes` on media documents that were imported before the field
// existed, from the Storage object's own metadata. Idempotent; skips
// documents that already have it.
//
// Usage: node scripts/backfill-media-bytes.js

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const serviceAccount = require('../serviceAccountKey.json');
initializeApp({ credential: cert(serviceAccount), storageBucket: 'roadready-it.firebasestorage.app' });
const db = getFirestore();
const bucket = getStorage().bucket();

async function main() {
  const snap = await db.collection('media').get();
  const todo = snap.docs.filter((d) => typeof d.data().bytes !== 'number' && d.data().storagePath);
  console.log(`${snap.size} media documents, ${todo.length} without bytes`);

  let done = 0;
  let missing = 0;
  let batch = db.batch();
  let ops = 0;
  for (const doc of todo) {
    try {
      const [meta] = await bucket.file(doc.data().storagePath).getMetadata();
      batch.update(doc.ref, { bytes: Number(meta.size) });
      ops += 1;
      done += 1;
    } catch (err) {
      missing += 1;
      console.log(`  no object for ${doc.id}: ${err.message}`);
    }
    if (ops >= 400) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
      console.log(`  … ${done}/${todo.length}`);
    }
  }
  if (ops > 0) await batch.commit();
  console.log(`Done: ${done} updated, ${missing} without a Storage object`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
