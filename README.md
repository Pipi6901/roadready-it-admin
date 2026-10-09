# RoadReady Admin (IT)

Content admin for [RoadReady IT](../roadready-it) — invite-only, Firestore-backed. Implements
`roadready/docs/00-decisions.md` ADR-003/004/015. Lives at **https://roadready-it-admin.web.app**
on Firebase project `roadready-it` (Blaze); the mobile app reads the published bank from
https://roadready-it.web.app/content.json.

**One admin per country.** Poland and Great Britain have their own deployments
(`roadready-admin-pl`, against their own Firebase projects) and this one is Italy's. The
Firestore schema is the shared multi-country one, so what separates the three is
`PRIMARY_COUNTRY_CODE` in `src/lib/content.ts` plus `.firebaserc` — never change one without
the other, or this instance will write Italian content into another country's database.

First admin: `node scripts/invite-first-admin.js <email>` prints a set-your-password link —
no password ever passes through chat or email. Needs Authentication (Email/Password) enabled
in the Firebase console first.

## Setup

```bash
npm install
```

You need `serviceAccountKey.json` in the repo root (never committed — see `.gitignore`) to
run the scripts in `scripts/`. Get it from Firebase Console → Project settings → Service
accounts → Generate new private key, for the `roadready-it` project.

## Running locally

```bash
npm run dev
```

Opens at http://localhost:3000. Sign in with an account that has a role in the `adminUsers`
Firestore collection (see "Inviting people" below).

## Data model

Firestore, matching `roadready/docs/02-architecture.md` §2:

```
countries/{code}
  testsets/draft
    topics/{topicId}
      questions/{questionId}
locales/{code}
adminUsers/{uid}          -- { email, role: 'content_editor' | 'admin' }
```

The app ships one country per build (ADR-013), so this admin's collection and content screens
are fixed to `countries/IT` rather than offering a country picker.

### What the Italian exam makes of the schema

The schema was built around the Polish paper, which splits questions into basic (TAK/NIE) and
specialist (A/B/C) and scores them in points. Italy's exam — **DM 27 ottobre 2021**, in force
since 20 December 2021 — is one kind of question only: a *scheda* of 30 statements marked VERO
or FALSO, 20 minutes, at most 3 errors, free navigation inside the scheda, and a blank answer
counts as an error.

So in the Italian bank `category` is absent on every topic and every question, and `points` is
1 throughout. Both fields stay in the schema (`src/lib/types.ts`) because all three admins read
the same documents; `publishTestSet` passes `category` through only when a source actually has
it, instead of defaulting it to `basic`.

## Seeding the listato

The bank is the ministry's own published question list — *listato dei quesiti per il
conseguimento delle patenti A e B* — turned into `content.json` by the mobile repo and loaded
into Firestore here:

```bash
cd ../roadready-it && python scripts/import_listato.py "path/to/210926_Conseguimento_A-B_italiano.pdf"
cd ../roadready-admin-it && node scripts/seed.js    # default: ../roadready-it/content/listato/content.json
```

That yields **7,020 statements across 25 argomenti**, of which 3,919 refer to one of **407
figures** extracted from the PDF itself. The listato is an official act of the State, which
art. 5 of L. 633/1941 places outside copyright.

`seed.js` upserts questions with `{ merge: true }`, deletes questions the file no longer has,
rewrites the per-topic translation documents whole, and leaves a question's `mediaId` alone
unless the file names one — so re-running after a listato update keeps attached figures. Pass
another `content.json` path as the first argument to seed something else.

## Translating the listato

The ministry publishes the listato in **German and French** besides Italian, and only those:
circolare 101771 of 21/12/2010 cut the exam's foreign languages back to the two protected
linguistic regimes (Alto Adige, Valle d'Aosta). Those two are not translations in the app —
they are languages the exam is sat in, so the app shows them as the question itself, on one
line, the same way it shows Italian. They are still published as locales — `V1_LOCALE_CODES`
in `functions/index.js` lists all seven — because the app reads every wording that is not the
bundle's Italian out of the translation catalogue. Take `de` or `fr` out of that list and they
disappear from the app's question-language picker on the next publish.

The five translation languages are **Romanian, Arabic, Ukrainian, Spanish and English**, and
none of them comes from the ministry, so all five are translated with Claude:

```bash
ANTHROPIC_API_KEY=sk-ant-… node scripts/translate-questions.js --dry-run                 # what would be sent
ANTHROPIC_API_KEY=sk-ant-… node scripts/translate-questions.js --lang ro --limit 2       # 40 statements to eyeball
ANTHROPIC_API_KEY=sk-ant-… node scripts/translate-questions.js                           # everything
```

Output lands in `../roadready-it/content/listato/translations/{lang}.json`, resumable batch by
batch; `scripts/import_listato.py` in the mobile repo merges it into `content.json`, then seed
and publish as usual. `--model` picks the model (default `claude-opus-5`; `claude-sonnet-5`
costs roughly a third if a re-run is needed).

Read a sample before trusting a language. The prompt (`systemPrompt` in that script) is built
around the traps a theory statement sets: *fermata / sosta / arresto* are three different legal
states, *carreggiata / corsia / banchina / marciapiede* four different parts of the road, and a
statement is often false because of one exact word, so a translation that tidies the sentence up
destroys the question.

## Importing the listato's figures

The figures are not published separately — `import_listato.py` pulls them out of the PDF into
`../roadready-it/content/listato/figures` (407 files, 3.7 MB, named by the md5 of their bytes,
so one sign drawn once is one file). Upload and attach them with:

```bash
node scripts/import-media.js "../roadready-it/content/listato/figures" --dry-run   # report what matches
node scripts/import-media.js "../roadready-it/content/listato/figures"             # upload + attach
```

The script matches files to questions by `sourceMedia`, uploads each needed file once to
`media/{mediaId}/{filename}`, writes the `media/{mediaId}` document (licence `ministero-it`)
and sets `mediaId` on every question that names the file. Everything is idempotent, so a run
can be repeated after a listato update. The Italian exam has no video clips, so the script's
WMV/ffmpeg half never fires here — it is kept because the script is shared with Poland.

Before publishing, `node scripts/verify-media.js --fix` checks every media document against
Storage (object present, download token matches, `bytes` right) and repairs what it can;
`node scripts/backfill-media-bytes.js` fills `bytes` on documents from before that field
existed. Then publish.

## Inviting people

Sign in as an `admin`, go to **Users**, enter an email + role. This calls the `inviteUser`
Cloud Function, which creates the Firebase Auth account and emails a "set your password" link
(Firebase's built-in template — no SendGrid or other email service involved). Note: the
default Firebase template names the sender/subject after the project ID (`roadready-it`) and
can land in spam on first send — customize it in Firebase Console → Authentication →
Templates if that matters, and tell the first invitee to check spam.

## Media library

**Media** in the nav: upload images/video (50 MB cap, `image/*` or `video/*`), tag with a
licence (`ministero-it` for the ministry's figures, `own` for ours), pick from the library on
a question's edit form. Delete is blocked (both in the UI and in `firestore.rules`) while a
question still references the file — detach it from every question first.

## Publishing

The **Publish** button on the Topics page (admin role only) calls `publishTestSet`, which
validates the draft test-set, reassembles it into the same `content.json` shape
`roadready/src/data/remoteContent.ts` already fetches, and deploys it to the `roadready-it`
Hosting site — the mobile app picks it up on next launch, no app rebuild. Only the locales in
`V1_LOCALE_CODES` are included; a locale document that exists in Firestore but is not listed
there stays unpublished rather than being deleted.

## Deploying changes

```bash
firebase deploy --only firestore:rules,storage,functions,hosting --project roadready-it
```

One-time setup each project needs:
- Firebase Storage "Get Started" clicked once in Console → Storage (separate from the Blaze
  upgrade itself — a manual bucket-provisioning step every project needs regardless of plan).
- `functions/.env` with `WEB_API_KEY` (the same `apiKey` as `.env.local`'s
  `NEXT_PUBLIC_FIREBASE_API_KEY`) — used by `inviteUser` to send the invite email via the
  Identity Toolkit REST API. (Named `WEB_API_KEY`, not `FIREBASE_WEB_API_KEY` — Cloud
  Functions reserves the `FIREBASE_` env var prefix.)
- No IAM step, unlike the British project: `functions/index.js` runs both functions as the
  Firebase Admin SDK service account (`setGlobalOptions({ serviceAccount })`), which already
  has Hosting deploy rights — `publishTestSet` deploys to Hosting via its REST API directly,
  without the `firebase` CLI. Deploying needs a project owner's CLI login (actAs).
- `firebase hosting:sites:create roadready-it-admin` + `firebase experiments:enable
  webframeworks` — this app's own Hosting site, deployed via Firebase's Next.js SSR
  integration (an `ssrroadreadyitadmin` Cloud Function, separate from
  `inviteUser`/`publishTestSet`).

## What's deferred (see ADR-015 for the full reasoning)

- **Translation review workflow** — `scripts/translate-questions.js` produces the five
  languages, but there is no glossary or second-pass review in the product; a native reader
  has to sample each language before it ships.
- **A country picker in the admin UI** — only `countries/IT` ships here, matching ADR-013.
  Another country means another deployment, not another dropdown.
