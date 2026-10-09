// Imports the ministry's media archive and attaches each file to the
// questions that refer to it.
//
// The official catalogue names a picture or clip per question
// (`sourceMedia`, e.g. "3106D15_a_org.jpg", "AK_D05_06_org.wmv" — see
// roadready-pl/scripts/import_katalog.py). The files themselves come as a
// 9.5 GB archive from https://www.gov.pl/web/infrastruktura/prawo-jazdy.
// This script walks a folder of those files, uploads each one that some
// draft question needs to Storage under media/{mediaId}/{filename}, writes
// the matching media/{mediaId} document — the same shape the admin's upload
// button produces (src/lib/media.ts) — and sets `mediaId` on every question
// that names the file. Publish afterwards for the app to pick them up.
//
// Clips arrive as WMV, which neither iOS nor Android plays. With ffmpeg on
// PATH (or FFMPEG=/path/to/ffmpeg) they are transcoded to H.264 MP4 into a
// cache folder next to the source and the MP4 is what gets uploaded; an
// already-present .mp4 with the same stem is used as is. Without ffmpeg,
// clips are skipped and counted, and the run can be repeated once it is
// installed — everything is idempotent: mediaId is derived from the file
// name, an existing Storage object is not re-uploaded, an existing media
// document is only re-linked.
//
// Usage: node scripts/import-media.js <folder> [--dry-run] [--limit N] [--only jpg|wmv] [--replace]
//   --dry-run  match and report, upload nothing, write nothing
//   --limit N  process at most N files (for a first look)
//   --only     restrict to pictures or to clips
//   --replace  re-upload files that already have a media document (new
//              download URL, refreshed size) — for swapping in a recompressed
//              set; without it an existing document is only re-linked

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, execFileSync, spawnSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');

const serviceAccount = require('../serviceAccountKey.json');
const BUCKET = 'roadready-pl.firebasestorage.app';
const COUNTRY = 'PL';
// Uploads are I/O-bound and run six at a time; transcodes are CPU-bound and
// ffmpeg already uses every core, so `--only wmv` runs two at a time
// (override either with CONCURRENCY=n).
const CONCURRENCY = Number(process.env.CONCURRENCY) || (process.argv.includes('wmv') ? 2 : 6);

initializeApp({ credential: cert(serviceAccount), storageBucket: BUCKET });
const db = getFirestore();
const bucket = getStorage().bucket();

/* --------------------------------------------------------------- args --- */

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const replace = args.includes('--replace');
if (!folder || !fs.existsSync(folder)) {
  console.error('Usage: node scripts/import-media.js <folder> [--dry-run] [--limit N] [--only jpg|wmv]');
  process.exit(1);
}

/* ------------------------------------------------------------ helpers --- */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);
const VIDEO_EXT = new Set(['.wmv', '.mp4', '.mov', '.avi']);
const CONTENT_TYPES = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };

/**
 * Lookup key for a file name: lower-cased, runs of whitespace collapsed. The
 * July 2026 catalogue names "W11 korytarz z 005.jpg" while the archive has
 * two spaces before the "z" — the same picture, so match them.
 */
function keyOf(name) {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Every file under the folder, keyed by normalised base name. */
function indexFiles(root) {
  const byName = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else byName.set(keyOf(entry.name), full);
    }
  };
  walk(root);
  return byName;
}

/** media/{id}: stable per file name, so a re-run finds its own documents. */
function mediaIdFor(sourceName) {
  const stem = sourceName.replace(/\.[^.]+$/, '');
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const hash = crypto.createHash('sha1').update(sourceName).digest('hex').slice(0, 6);
  return `kat-${slug}-${hash}`;
}

function findFfmpeg() {
  const candidate = process.env.FFMPEG || 'ffmpeg';
  const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
  return probe.status === 0 ? candidate : null;
}

function findFfprobe(ffmpeg) {
  if (!ffmpeg) return null;
  const candidate = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m, exe) => `ffprobe${exe ?? ''}`);
  const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
  return probe.status === 0 ? candidate : null;
}

/** Width/height from the JPEG SOF marker — enough to size the frame in the app. */
function jpegDimensions(file) {
  const buf = fs.readFileSync(file);
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function pngDimensions(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function videoInfo(ffprobe, file) {
  if (!ffprobe) return { width: null, height: null, durationMs: null };
  try {
    const out = execFileSync(
      ffprobe,
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file],
      { encoding: 'utf8' },
    );
    const info = JSON.parse(out);
    const stream = info.streams?.[0] ?? {};
    const duration = Number(info.format?.duration);
    return {
      width: stream.width ?? null,
      height: stream.height ?? null,
      durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
    };
  } catch {
    return { width: null, height: null, durationMs: null };
  }
}

/**
 * WMV -> MP4 the phones can play: H.264 main profile, AAC, faststart so the
 * clip begins before it has fully downloaded. The archive's clips are
 * 1024x576 at 50 fps; 25 fps and a 1280 px cap halve the encode and the
 * download for no visible loss on a phone. Output cached beside the source
 * in an `_mp4` folder; an existing file is reused.
 */
async function transcode(ffmpeg, src) {
  const outDir = path.join(path.dirname(src), '_mp4');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, path.basename(src).replace(/\.[^.]+$/, '.mp4'));
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return out;
  // Written to a temp name and renamed, so a crash mid-encode cannot leave a
  // truncated file that the next run would take for a finished one.
  const part = `${out}.part.mp4`;
  // crf 25 at 576p: ~1.8 MB for a ten-second clip, against 2.7 MB at the
  // x264 default of 23 — the difference is invisible on a phone and adds up
  // to a gigabyte across the archive.
  await execFileAsync(
    ffmpeg,
    ['-y', '-v', 'error', '-i', src, '-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-crf', '25',
      '-preset', 'fast', '-r', '25', '-vf', "scale='min(1280,iw)':-2", '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', part],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  await renameWithRetry(part, out);
  return out;
}

/**
 * Windows can still hold a just-closed file for a moment (indexer, antivirus),
 * and rename then fails with EBUSY; a few short retries are all it needs.
 */
async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 10 || !['EBUSY', 'EPERM', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

/** The download URL the client SDK would hand back — same token scheme. */
function downloadUrl(storagePath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
}

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/* --------------------------------------------------------------- main --- */

async function main() {
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe(ffmpeg);
  console.log(`ffmpeg: ${ffmpeg ?? 'not found (clips will be skipped unless an .mp4 sibling exists)'}`);

  console.log(`Indexing ${folder} …`);
  const files = indexFiles(folder);
  console.log(`  ${files.size} files on disk`);

  // Every draft question that names a file: sourceMedia -> [question refs].
  const testsetRef = db.collection('countries').doc(COUNTRY).collection('testsets').doc('draft');
  const topicsSnap = await testsetRef.collection('topics').where('deletedAt', '==', null).get();
  const wanted = new Map();
  let questionsSeen = 0;
  for (const topicDoc of topicsSnap.docs) {
    const qs = await topicDoc.ref.collection('questions').where('deletedAt', '==', null).get();
    for (const qDoc of qs.docs) {
      questionsSeen += 1;
      const q = qDoc.data();
      if (!q.sourceMedia) continue;
      const list = wanted.get(q.sourceMedia) ?? [];
      list.push({ ref: qDoc.ref, id: qDoc.id, mediaId: q.mediaId ?? null });
      wanted.set(q.sourceMedia, list);
    }
  }
  console.log(`  ${questionsSeen} questions, ${wanted.size} distinct media names referenced`);

  // Existing media documents from a previous run, by id.
  const existingSnap = await db.collection('media').get();
  const existing = new Map(existingSnap.docs.map((d) => [d.id, d.data()]));

  const jobs = [];
  const missing = [];
  const skippedClips = [];
  for (const [sourceName, questions] of wanted) {
    const ext = path.extname(sourceName).toLowerCase();
    const isVideo = VIDEO_EXT.has(ext);
    if (only === 'jpg' && isVideo) continue;
    if (only === 'wmv' && !isVideo) continue;

    let file = files.get(keyOf(sourceName));
    if (isVideo) {
      // Prefer a ready MP4 with the same stem; else the WMV, transcoded below.
      const mp4 = files.get(keyOf(sourceName).replace(/\.[^.]+$/, '.mp4'));
      if (mp4) file = mp4;
      else if (!file) { missing.push(sourceName); continue; }
      else if (!ffmpeg) { skippedClips.push(sourceName); continue; }
    } else if (!file) {
      missing.push(sourceName);
      continue;
    }
    jobs.push({ sourceName, file, isVideo, questions });
  }
  console.log(`  ${jobs.length} to process, ${missing.length} not in folder, ${skippedClips.length} clips need ffmpeg`);
  if (missing.length) console.log('  missing e.g.:', missing.slice(0, 8).join(', '));
  if (dryRun) {
    console.log('Dry run — nothing written.');
    return;
  }

  const todo = jobs.slice(0, Number.isFinite(limit) ? limit : undefined);
  let uploaded = 0;
  let reused = 0;
  let linked = 0;
  const failed = [];

  await pool(todo, CONCURRENCY, async (job, i) => {
    const { sourceName, isVideo, questions } = job;
    const mediaId = mediaIdFor(sourceName);
    try {
      let file = job.file;
      if (isVideo && path.extname(file).toLowerCase() !== '.mp4') file = await transcode(ffmpeg, file);
      const filename = path.basename(file);
      const ext = path.extname(filename).toLowerCase();
      const storagePath = `media/${mediaId}/${filename}`;
      const object = bucket.file(storagePath);

      let media = existing.get(mediaId);
      if (media && replace) {
        // Same document id and path, new bytes: the old object (possibly a
        // different file name after transcoding) goes, so nothing stale is
        // left to serve.
        if (media.storagePath && media.storagePath !== storagePath) {
          await bucket.file(media.storagePath).delete({ ignoreNotFound: true });
        }
        media = null;
      }
      if (!media) {
        const token = crypto.randomUUID();
        const [exists] = replace ? [false] : await object.exists();
        if (!exists) {
          await object.save(fs.readFileSync(file), {
            resumable: false,
            contentType: CONTENT_TYPES[ext] ?? 'application/octet-stream',
            metadata: { cacheControl: 'public, max-age=31536000, immutable', metadata: { firebaseStorageDownloadTokens: token } },
          });
          uploaded += 1;
        } else {
          // Re-run after a crash between upload and document write: reuse
          // the object, but it needs a token we know.
          await object.setMetadata({ metadata: { firebaseStorageDownloadTokens: token } });
          reused += 1;
        }
        const dims = isVideo
          ? videoInfo(ffprobe, file)
          : ext === '.png'
            ? { ...(pngDimensions(file) ?? { width: null, height: null }), durationMs: null }
            : { ...(jpegDimensions(file) ?? { width: null, height: null }), durationMs: null };
        media = {
          type: isVideo ? 'video' : 'image',
          filename,
          storagePath,
          cdnUrl: downloadUrl(storagePath, token),
          width: dims.width,
          height: dims.height,
          durationMs: dims.durationMs,
          // File size, so the app can say how big the offline pack is
          // before the learner taps download.
          bytes: fs.statSync(file).size,
          hazardWindow: null,
          usedByQuestions: [],
          // Public-sector material published by the Ministry of Infrastructure.
          licence: 'gov-pl',
          sourceName,
          deletedAt: null,
        };
        await db.collection('media').doc(mediaId).set(media);
        existing.set(mediaId, media);
      } else {
        reused += 1;
      }

      // Link every question that names this file.
      const batch = db.batch();
      const ids = [];
      for (const q of questions) {
        ids.push(q.id);
        if (q.mediaId !== mediaId) batch.update(q.ref, { mediaId });
      }
      batch.set(db.collection('media').doc(mediaId), { usedByQuestions: ids }, { merge: true });
      await batch.commit();
      linked += questions.length;
    } catch (err) {
      failed.push(`${sourceName}: ${err.message}`);
    }
    if ((i + 1) % 25 === 0) console.log(`  … ${i + 1}/${todo.length}  (uploaded ${uploaded}, reused ${reused}, failed ${failed.length})`);
  });

  console.log(`Done. uploaded ${uploaded}, reused ${reused}, questions linked ${linked}, failed ${failed.length}`);
  for (const f of failed.slice(0, 20)) console.log('  failed', f);
  if (skippedClips.length) console.log(`${skippedClips.length} clips skipped — install ffmpeg (or drop .mp4 files next to the .wmv) and run again.`);
  if (missing.length) console.log(`${missing.length} referenced files were not in the folder.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
