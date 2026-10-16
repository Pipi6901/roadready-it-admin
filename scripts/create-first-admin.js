// One-off: creates the very first admin account (Admin SDK bypasses the
// invite Cloud Function, which doesn't exist yet on the very first run).
// Usage: node scripts/create-first-admin.js <email> <password>
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./lib/project').loadServiceAccount();

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

async function main() {
  const [email, password] = process.argv.slice(2);
  if (!email || !password) {
    console.error('Usage: node scripts/create-first-admin.js <email> <password>');
    process.exit(1);
  }

  const user = await auth.createUser({ email, password, emailVerified: true });
  await db.collection('adminUsers').doc(user.uid).set({
    email,
    role: 'admin',
    invitedAt: new Date().toISOString(),
  });

  console.log(`Created admin ${email} (uid ${user.uid})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
