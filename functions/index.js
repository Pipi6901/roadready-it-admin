const crypto = require('crypto');
const zlib = require('zlib');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { GoogleAuth } = require('google-auth-library');

// Both functions run as the Firebase Admin SDK service account rather than
// the default compute one. publishTestSet deploys to Hosting through the REST
// API, and that needs Hosting deploy rights on whatever identity the function
// runs under: the British project got there by granting the compute account
// the Firebase Hosting Admin role in the Cloud console. This project's owner
// does not use that console, and the Admin SDK account already has those
// rights — it is what deploys content.json from the command line — so the
// function borrows it instead, and no IAM change is needed. The deployer
// needs to be a project owner (actAs on the account), which the CLI login is.
setGlobalOptions({
  serviceAccount: 'firebase-adminsdk-fbsvc@roadready-pl.iam.gserviceaccount.com',
});

initializeApp();
const auth = getAuth();
const db = getFirestore();

const ROLES = ['content_editor', 'admin'];
// The Polish project's Hosting site. publishTestSet deploys content.json
// here, and the app fetches it from the matching URL — the two must name
// the same site or the app silently keeps serving the previous bundle.
const HOSTING_SITE_ID = 'roadready-pl';

async function requireAdmin(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const callerDoc = await db.collection('adminUsers').doc(request.auth.uid).get();
  if (callerDoc.data()?.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admin role required.');
  }
}

/**
 * Invite a new editor/admin (docs/03-content-pipeline.md §6 — invite-only,
 * no public sign-up). Creates the Auth user with a random, never-surfaced
 * temp password, records the role, and sends Firebase's built-in
 * password-reset email as the "set your own password" invite via the
 * Identity Toolkit REST API — no third-party email service needed.
 *
 * Requires the WEB_API_KEY env var (the same apiKey the web app's
 * .env.local uses — see src/lib/firebase.ts).
 */
exports.inviteUser = onCall(async (request) => {
  await requireAdmin(request);

  const { email, role } = request.data ?? {};
  if (typeof email !== 'string' || !email.includes('@')) {
    throw new HttpsError('invalid-argument', 'A valid email is required.');
  }
  if (!ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', `role must be one of ${ROLES.join(', ')}.`);
  }

  const tempPassword = crypto.randomUUID() + crypto.randomUUID();
  const userRecord = await auth.createUser({ email, password: tempPassword, emailVerified: false });

  await db.collection('adminUsers').doc(userRecord.uid).set({
    email,
    role,
    invitedAt: new Date().toISOString(),
    invitedBy: request.auth.uid,
  });

  const apiKey = process.env.WEB_API_KEY;
  if (!apiKey) throw new HttpsError('failed-precondition', 'WEB_API_KEY is not configured.');

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });
  if (!res.ok) throw new HttpsError('internal', `Failed to send invite email: ${await res.text()}`);

  return { uid: userRecord.uid };
});

/**
 * Publish the draft test-set: validate, reassemble it into the exact
 * content.json shape the mobile app already fetches
 * (roadready/src/data/remoteContent.ts's isValidPayload), compute
 * versionHash, deploy to the Polish Hosting site, mark the
 * testset published.
 */
// The full ministry catalogue is 3.5k questions in 23 topics, read one topic
// at a time, plus a Hosting deploy of a 4 MB file: well past the 60 s default.
exports.publishTestSet = onCall({ timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  await requireAdmin(request);

  const { countryCode } = request.data ?? {};
  if (typeof countryCode !== 'string') {
    throw new HttpsError('invalid-argument', 'countryCode is required.');
  }

  const countrySnap = await db.collection('countries').doc(countryCode).get();
  if (!countrySnap.exists) throw new HttpsError('not-found', `Unknown country ${countryCode}.`);

  const testsetRef = db.collection('countries').doc(countryCode).collection('testsets').doc('draft');
  const topicsSnap = await testsetRef.collection('topics').where('deletedAt', '==', null).orderBy('sortOrder').get();

  const topics = [];
  const questions = [];
  const translations = {};
  const errors = [];

  for (const topicDoc of topicsSnap.docs) {
    const topic = topicDoc.data();
    const questionsSnap = await topicDoc.ref
      .collection('questions')
      .where('deletedAt', '==', null)
      .orderBy('sortOrder')
      .get();

    let count = 0;
    for (const qDoc of questionsSnap.docs) {
      const q = qDoc.data();
      if (!q.correctOptionId || !(q.options || []).some((o) => o.id === q.correctOptionId)) {
        errors.push(`Question ${qDoc.id} (${topic.slug}): correctOptionId does not match any option.`);
        continue;
      }
      // No explanation is not an error any more: the official catalogue
      // ships none, and the app shows just the correct answer in that case.
      // An editor can still write one question by question.
      count += 1;
      questions.push({
        id: qDoc.id,
        topicId: topicDoc.id,
        type: q.type,
        text: q.text,
        options: q.options,
        correctOptionId: q.correctOptionId,
        explanation: q.explanation ?? '',
        mediaId: q.mediaId ?? null,
        subtopic: q.subtopic ?? null,
        sourceRef: q.sourceRef,
        // The Polish paper is built from these two: a fixed number of each
        // class and each weight. A question that inherits nothing is basic
        // and worth one point, which is what the app assumes anyway.
        category: q.category ?? topic.category ?? 'basic',
        points: q.points === 2 || q.points === 3 ? q.points : 1,
        // Which licence categories the question is asked for (AM, A1, …, PT
        // — the ministry's codes). Empty or missing means every category;
        // the app filters its whole bank by the learner's choice.
        licences: Array.isArray(q.licences) ? q.licences : [],
        // The catalogue's original media file name, kept so the media
        // import can be matched up later. Not used by the app itself.
        sourceMedia: q.sourceMedia ?? null,
      });
    }
    const questionIds = new Set(questions.map((q) => q.id));

    // Translations live one document per locale under the topic, keyed by
    // question id (see scripts/seed.js). Per topic rather than per set so a
    // full bank stays under Firestore's 1 MB document limit.
    const translationsSnap = await topicDoc.ref.collection('translations').get();
    for (const trDoc of translationsSnap.docs) {
      const locale = trDoc.id;
      const entries = trDoc.data().questions ?? {};
      translations[locale] = translations[locale] ?? {};
      for (const [questionId, tr] of Object.entries(entries)) {
        if (questionIds.has(questionId)) translations[locale][questionId] = tr;
      }
    }

    topics.push({
      id: topicDoc.id,
      name: topic.name,
      slug: topic.slug,
      icon: topic.icon,
      sortOrder: topic.sortOrder,
      questionCount: count,
      category: topic.category ?? 'basic',
    });
  }

  if (errors.length > 0) {
    throw new HttpsError('failed-precondition', `Validation failed:\n${errors.join('\n')}`);
  }

  // Only the media actually referenced by a published question — not the
  // whole library — keeps content.json from growing with unused uploads.
  const mediaIds = [...new Set(questions.map((q) => q.mediaId).filter(Boolean))];
  const mediaDocs = await Promise.all(mediaIds.map((id) => db.collection('media').doc(id).get()));
  const media = {};
  for (const doc of mediaDocs) {
    if (!doc.exists) continue;
    const m = doc.data();
    media[doc.id] = {
      id: doc.id,
      type: m.type,
      url: m.cdnUrl,
      width: m.width ?? null,
      height: m.height ?? null,
      durationMs: m.durationMs ?? null,
      bytes: m.bytes ?? null,
    };
  }

  const countriesSnap = await db.collection('countries').where('deletedAt', '==', null).get();
  const countries = countriesSnap.docs.map((d) => {
    const c = d.data();
    return {
      code: c.code,
      name: c.name,
      flagEmoji: c.flagEmoji,
      authority: c.authority,
      legalNotice: c.legalNotice,
      status: c.status,
      questionCount: d.id === countryCode ? questions.length : c.questionCount,
      mockTest: c.mockTest,
      currency: c.currency,
    };
  });

  // Translation languages of the Polish app: Ukrainian, Russian, English,
  // Spanish, German, Turkish (see the mobile repo, src/data/demo-bundle.ts).
  // The official catalogue carries English, German and Ukrainian; the rest
  // are the app's own. A publish-time filter, not a delete: another locale
  // doc in Firestore stays there until it is added here.
  const V1_LOCALE_CODES = ['uk', 'ru', 'en', 'es', 'de', 'tr'];
  const localesSnap = await db.collection('locales').get();
  // In dashboard order (sortOrder from the seed), not Firestore's document
  // order — the app splices this list straight into its language picker, and
  // alphabetical would put English above Ukrainian for an audience that is
  // three-quarters Ukrainian.
  const locales = localesSnap.docs
    .map((d) => d.data())
    .filter((l) => V1_LOCALE_CODES.includes(l.code))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((l) => ({
      code: l.code,
      nameNative: l.nameNative,
      nameEnglish: l.nameEnglish,
      direction: l.direction,
      flagEmoji: l.flagEmoji,
    }));

  const versionHash = `admin-${countryCode.toLowerCase()}-${Date.now()}`;

  const payload = {
    country: countries.find((c) => c.code === countryCode),
    topics: topics.map(({ id, name, slug, icon, sortOrder, questionCount, category }) => ({
      id,
      name,
      slug,
      icon,
      sortOrder,
      questionCount,
      category,
    })),
    questions,
    translations,
    media,
    versionHash,
    countries,
    locales,
  };

  await deployToHosting(JSON.stringify(payload));

  await testsetRef.set(
    {
      status: 'published',
      versionHash,
      publishedAt: new Date().toISOString(),
      publishedBy: request.auth.uid,
    },
    { merge: true },
  );

  return { versionHash, questionCount: questions.length, topicCount: topics.length };
});

/**
 * Deploys `content.json` to the project's default Hosting site via the
 * Firebase Hosting REST API (versions.create -> populateFiles -> upload ->
 * finalize -> release) — the same four-step flow the `firebase deploy` CLI
 * performs, done here without a local CLI (Cloud Functions can't shell out
 * to it). Requires the Cloud Function's runtime service account to have the
 * "Firebase Hosting Admin" IAM role.
 */
async function deployToHosting(contentJson) {
  const authClient = await new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/firebase.hosting'],
  }).getClient();
  const { token } = await authClient.getAccessToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const gz = zlib.gzipSync(Buffer.from(contentJson));
  const sha256 = crypto.createHash('sha256').update(gz).digest('hex');

  const versionRes = await fetch(`https://firebasehosting.googleapis.com/v1beta1/sites/${HOSTING_SITE_ID}/versions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      config: {
        headers: [
          {
            glob: '/content.json',
            headers: { 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
          },
        ],
      },
    }),
  });
  const version = await versionRes.json();
  if (!version.name) throw new Error(`Failed to create hosting version: ${JSON.stringify(version)}`);

  const popRes = await fetch(`https://firebasehosting.googleapis.com/v1beta1/${version.name}:populateFiles`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ files: { '/content.json': sha256 } }),
  });
  const pop = await popRes.json();
  if (!pop.uploadUrl) throw new Error(`Failed to populate files: ${JSON.stringify(pop)}`);

  const uploadRes = await fetch(`${pop.uploadUrl}/${sha256}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: gz,
  });
  if (!uploadRes.ok) throw new Error(`Hosting upload failed: ${uploadRes.status} ${await uploadRes.text()}`);

  const finalizeRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/${version.name}?updateMask=status`,
    { method: 'PATCH', headers, body: JSON.stringify({ status: 'FINALIZED' }) },
  );
  if (!finalizeRes.ok) throw new Error(`Failed to finalize version: ${finalizeRes.status} ${await finalizeRes.text()}`);

  const releaseRes = await fetch(
    `https://firebasehosting.googleapis.com/v1beta1/sites/${HOSTING_SITE_ID}/releases?versionName=${version.name}`,
    { method: 'POST', headers },
  );
  if (!releaseRes.ok) throw new Error(`Failed to release version: ${releaseRes.status} ${await releaseRes.text()}`);
}
