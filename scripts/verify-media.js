// Checks every media document against Storage: the object exists, the token in
// the document's download URL is the one on the object, and `bytes` matches.
// Repairs what it can (re-stamps the object with the document's token, fixes
// bytes) and lists what it cannot. Run after an import, before publishing.
//
// Usage: node scripts/verify-media.js [--fix]

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const serviceAccount = require('../serviceAccountKey.json');
initializeApp({ credential: cert(serviceAccount), storageBucket: 'roadready-it.firebasestorage.app' });
const db = getFirestore();
const bucket = getStorage().bucket();
const fix = process.argv.includes('--fix');

function tokenOf(url) {
  const m = /[?&]token=([0-9a-f-]+)/i.exec(url ?? '');
  return m ? m[1] : null;
}

async function pool(items, size, worker) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) await worker(items[next++]);
    }),
  );
}

async function main() {
  const snap = await db.collection('media').get();
  const docs = snap.docs;
  console.log(`${docs.length} media documents`);
  const problems = { missingObject: [], tokenMismatch: [], bytesMismatch: [], noToken: [] };
  let fixed = 0;

  await pool(docs, 8, async (doc) => {
    const m = doc.data();
    const token = tokenOf(m.cdnUrl);
    if (!token) {
      problems.noToken.push(doc.id);
      return;
    }
    let meta;
    try {
      [meta] = await bucket.file(m.storagePath).getMetadata();
    } catch {
      problems.missingObject.push(`${doc.id} (${m.storagePath})`);
      return;
    }
    const objectTokens = String(meta.metadata?.firebaseStorageDownloadTokens ?? '').split(',').filter(Boolean);
    if (!objectTokens.includes(token)) {
      problems.tokenMismatch.push(doc.id);
      if (fix) {
        // The document's URL is what got published; make the object honour it.
        await bucket.file(m.storagePath).setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
        fixed += 1;
      }
    }
    const size = Number(meta.size);
    if (m.bytes !== size) {
      problems.bytesMismatch.push(doc.id);
      if (fix) {
        await doc.ref.update({ bytes: size });
        fixed += 1;
      }
    }
  });

  for (const [k, v] of Object.entries(problems)) {
    console.log(`${k}: ${v.length}${v.length ? '  e.g. ' + v.slice(0, 5).join(', ') : ''}`);
  }
  console.log(fix ? `fixed ${fixed}` : 'dry run — pass --fix to repair');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
