// One-off: creates the very first admin without anyone ever seeing a
// password. The account gets a random password that is thrown away, and
// the script prints a password-reset link — the new admin opens it, sets
// their own password, signs in. Same idea as the inviteUser Cloud Function,
// minus the email: on the first run there is no admin to call the function.
//
// Usage: node scripts/invite-first-admin.js <email>
// Needs: Authentication enabled in the Firebase console (Sign-in method →
// Email/Password), otherwise createUser fails with CONFIGURATION_NOT_FOUND.
const crypto = require('crypto');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('../serviceAccountKey.json');

initializeApp({ credential: cert(serviceAccount) });
const auth = getAuth();
const db = getFirestore();

async function main() {
  const [email] = process.argv.slice(2);
  if (!email || !email.includes('@')) {
    console.error('Usage: node scripts/invite-first-admin.js <email>');
    process.exit(1);
  }

  let user;
  try {
    user = await auth.getUserByEmail(email);
    console.log(`Auth user already exists (uid ${user.uid}); reusing it.`);
  } catch {
    user = await auth.createUser({
      email,
      password: crypto.randomUUID() + crypto.randomUUID(),
      emailVerified: true,
    });
    console.log(`Created auth user ${email} (uid ${user.uid}).`);
  }

  await db.collection('adminUsers').doc(user.uid).set(
    { email, role: 'admin', invitedAt: new Date().toISOString() },
    { merge: true },
  );

  const link = await auth.generatePasswordResetLink(email);
  console.log('\nSet-your-password link (single use, expires in about an hour):\n');
  console.log(link);
  console.log('\nAfter setting the password, sign in at https://roadready-it-admin.web.app');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
