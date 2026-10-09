// Translates the listato's statements into the app's languages with Claude.
//
// The ministry translates the listato into German and French only: circolare
// 101771 of 21/12/2010 cut the exam's foreign languages back to the two
// protected linguistic regimes (Alto Adige, Valle d'Aosta). Those two are not
// translations in the app at all — they are languages the exam is sat in, so
// they come from the bundle as first-class text (see EXAM_LANGUAGES in the
// mobile repo). Everything else is this script's job: for each language it
// takes the statements that have no official translation and translates them
// in batches, writing
//
//   ../roadready-it/content/listato/translations/{lang}.json
//     { "q-123": { "text": "...", "options": { "A": "...", "B": "...", "C": "..." } } }
//
// which scripts/import_listato.py in the mobile repo merges into content.json
// (official translations always win). Then seed, then publish.
//
// Resumable: what is already in the file is skipped, and the file is written
// after every batch, so a crash or a Ctrl+C costs one batch. A failed batch is
// retried three times, then reported and left for the next run.
//
// Auth: ANTHROPIC_API_KEY in the environment (or an `ant auth login` profile).
//
// Usage: node scripts/translate-questions.js [--lang ro,ar,uk,es,en] [--limit N]
//          [--model claude-opus-5] [--concurrency 4] [--dry-run]
//   --lang         which languages (default: all five)
//   --limit N      stop after N batches per language (a first look at quality)
//   --dry-run      count what would be translated and estimate size; no API calls

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const ROOT = path.resolve(__dirname, '../../roadready-it/content/listato');
const CONTENT = path.join(ROOT, 'content.json');
const OUT_DIR = path.join(ROOT, 'translations');

// The five the Italian app ships. Italian is the bundle itself; German and
// French come from the ministry and are exam languages, not translations.
const LANGUAGES = {
  ro: 'Romanian',
  ar: 'Arabic',
  uk: 'Ukrainian',
  es: 'Spanish',
  en: 'English',
};

const BATCH_SIZE = 20;

/* --------------------------------------------------------------- args --- */

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const langs = flag('--lang', Object.keys(LANGUAGES).join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const limit = Number(flag('--limit', Infinity));
const model = flag('--model', 'claude-opus-5');
const concurrency = Number(flag('--concurrency', 4));
const dryRun = args.includes('--dry-run');

for (const l of langs) {
  if (!LANGUAGES[l]) {
    console.error(`Unknown language ${l}; known: ${Object.keys(LANGUAGES).join(', ')}`);
    process.exit(1);
  }
}

/* ------------------------------------------------------------- prompt --- */

function systemPrompt(language) {
  return `You translate statements from the official Italian driving-theory exam (esame di teoria per la patente, listato ministeriale) from Italian into ${language}.

Who reads this: someone living in Italy who will sit the real exam in Italian. The exam is 30 statements to be marked VERO or FALSO, and the translation sits directly under the Italian original in a learning app. Its job is to make the Italian sentence understood exactly — not to be a freer, nicer sentence of its own.

Rules:
- These are assertions, not questions. Keep them assertions: never turn one into a question, and never mark, hint at or explain whether it is true or false.
- Translate the meaning exactly. Do not add, drop, soften or explain anything. If the Italian is ambiguous, keep the ambiguity — a statement is often false precisely because of one exact word.
- Follow the Italian sentence structure closely (same clause order where the target language allows it), so the reader can map the two sentences word by word.
- Keep references to the picture literal: "il segnale raffigurato", "la figura", "il pannello raffigurato" point at an image the reader is looking at, so they must stay a pointer to that image and not become a description of it.
- Use the established traffic-law vocabulary of the target language for Italian legal terms. Be especially careful with terms the target language is likely to collapse into one: fermata, sosta and arresto are three distinct legal states; carreggiata, corsia, banchina and marciapiede are four distinct parts of the road; centro abitato is a legal area, not "the town centre"; dare la precedenza is not "to give way to the road". Others to get right: strada con diritto di precedenza, rotatoria, incrocio, sorpasso, distanza di sicurezza, massa complessiva a pieno carico, ciclomotore, autoarticolato, autotreno, veicolo in servizio di emergenza, carta di circolazione, revisione, assicurazione RCA, segnale di pericolo / divieto / obbligo / precedenza / indicazione, pannello integrativo, segnaletica orizzontale. Where a term has no exact equivalent, translate descriptively rather than borrowing a term that means something else in that country's traffic law.
- Keep every number, unit, speed, sign designation, licence category (AM, A1, A2, A, B1, B, BE, C, CE, D, DE...) and article reference as it is.
- Address the reader the way the Italian does.
- Return only the translations, in the requested JSON shape, one item per input id, all ids present.`;
}

const TEXT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

const OPTIONS_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          options: {
            type: 'object',
            properties: { A: { type: 'string' }, B: { type: 'string' }, C: { type: 'string' } },
            required: ['A', 'B', 'C'],
            additionalProperties: false,
          },
        },
        required: ['id', 'text', 'options'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

/* ------------------------------------------------------------ helpers --- */

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 0));
  fs.renameSync(tmp, file);
}

/** Questions a language still needs: no official translation and not done yet. */
function pending(content, lang, done) {
  const official = content.translations[lang] ?? {};
  return content.questions.filter((q) => !official[q.id] && !done[q.id]);
}

function batchesOf(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function payloadFor(batch, specialist) {
  return batch.map((q) =>
    specialist
      ? { id: q.id, text: q.text, options: Object.fromEntries(q.options.map((o) => [o.id, o.text])) }
      : { id: q.id, text: q.text },
  );
}

/* --------------------------------------------------------------- main --- */

async function translateBatch(client, language, batch, specialist, usage) {
  const payload = payloadFor(batch, specialist);
  const stream = client.messages.stream({
    model,
    max_tokens: 16000,
    system: [{ type: 'text', text: systemPrompt(language), cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Translate these ${batch.length} ${specialist ? 'questions with their three options' : 'true/false statements'} into ${language}.\n\n${JSON.stringify(payload)}`,
      },
    ],
    // Translation is not a reasoning task: low effort keeps the model from
    // spending tokens deliberating and the schema keeps the shape honest.
    output_config: { effort: 'low', format: { type: 'json_schema', schema: specialist ? OPTIONS_SCHEMA : TEXT_SCHEMA } },
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error(`refused: ${message.stop_details?.explanation ?? ''}`);
  if (message.stop_reason === 'max_tokens') throw new Error('truncated at max_tokens');

  usage.input += message.usage.input_tokens;
  usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
  usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
  usage.output += message.usage.output_tokens;

  const text = message.content.find((b) => b.type === 'text')?.text ?? '';
  const parsed = JSON.parse(text);
  const byId = new Map(parsed.items.map((it) => [it.id, it]));
  const result = {};
  for (const q of batch) {
    const it = byId.get(q.id);
    if (!it || !it.text?.trim()) throw new Error(`missing translation for ${q.id}`);
    const entry = { text: it.text.trim(), options: {}, explanation: '' };
    if (specialist) {
      for (const o of q.options) {
        const v = it.options?.[o.id];
        if (!v?.trim()) throw new Error(`missing option ${o.id} for ${q.id}`);
        entry.options[o.id] = v.trim();
      }
    }
    result[q.id] = entry;
  }
  return result;
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
  const content = loadJson(CONTENT, null);
  if (!content) {
    console.error(`No ${CONTENT} — run scripts/import_listato.py in the mobile repo first.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Plan first, so a dry run can say what it would cost.
  const plan = [];
  for (const lang of langs) {
    const file = path.join(OUT_DIR, `${lang}.json`);
    const done = loadJson(file, {});
    const todo = pending(content, lang, done);
    const basic = todo.filter((q) => q.category !== 'specialist');
    const specialist = todo.filter((q) => q.category === 'specialist');
    const chars = todo.reduce((n, q) => n + q.text.length + (q.category === 'specialist' ? q.options.reduce((m, o) => m + o.text.length, 0) : 0), 0);
    plan.push({ lang, file, done, todo, basic, specialist, chars });
    console.log(
      `${lang} (${LANGUAGES[lang]}): official ${Object.keys(content.translations[lang] ?? {}).length}, generated so far ${Object.keys(done).length}, ` +
        `to translate ${todo.length} (${basic.length} true/false, ${specialist.length} with options), ${(chars / 1000).toFixed(0)}k chars`,
    );
  }
  if (dryRun) {
    const chars = plan.reduce((n, p) => n + p.chars, 0);
    console.log(`Dry run. ~${(chars / 1e6).toFixed(2)}M source characters in total; nothing sent.`);
    return;
  }

  const client = new Anthropic();
  const usage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  const started = Date.now();

  for (const p of plan) {
    if (p.todo.length === 0) continue;
    const jobs = [
      ...batchesOf(p.basic, BATCH_SIZE).map((b) => ({ batch: b, specialist: false })),
      ...batchesOf(p.specialist, BATCH_SIZE).map((b) => ({ batch: b, specialist: true })),
    ].slice(0, Number.isFinite(limit) ? limit : undefined);
    console.log(`\n${p.lang}: ${jobs.length} batches`);
    let doneBatches = 0;
    const failed = [];

    await pool(jobs, concurrency, async (job) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const result = await translateBatch(client, LANGUAGES[p.lang], job.batch, job.specialist, usage);
          Object.assign(p.done, result);
          saveJson(p.file, p.done);
          doneBatches += 1;
          if (doneBatches % 10 === 0 || doneBatches === jobs.length) {
            console.log(`  ${p.lang}: ${doneBatches}/${jobs.length} batches · ${Object.keys(p.done).length} translated · ${((Date.now() - started) / 60000).toFixed(1)} min`);
          }
          return;
        } catch (err) {
          const retryable =
            err instanceof Anthropic.RateLimitError ||
            err instanceof Anthropic.InternalServerError ||
            err instanceof Anthropic.APIConnectionError ||
            !(err instanceof Anthropic.APIError); // our own shape checks
          if (err instanceof Anthropic.AuthenticationError) throw err;
          if (!retryable || attempt >= 3) {
            failed.push(`${job.batch[0].id}…${job.batch[job.batch.length - 1].id}: ${err.message}`);
            return;
          }
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    });

    if (failed.length) {
      console.log(`  ${p.lang}: ${failed.length} batch(es) failed — run again to retry:`);
      for (const f of failed.slice(0, 10)) console.log('   ', f);
    }
  }

  const cost = estimateCost(model, usage);
  console.log(
    `\nTokens: input ${usage.input.toLocaleString()} (+${usage.cacheRead.toLocaleString()} cached, ${usage.cacheWrite.toLocaleString()} written), output ${usage.output.toLocaleString()}` +
      (cost ? ` · ≈ $${cost.toFixed(2)}` : ''),
  );
  console.log('Next: python scripts/import_listato.py … (mobile repo) → node scripts/seed.js → publish.');
}

/** Rough bill from list prices, so the run reports what it cost. */
function estimateCost(m, u) {
  const price = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5] }[m];
  if (!price) return null;
  const [inPrice, outPrice] = price;
  return (u.input * inPrice + u.cacheWrite * inPrice * 1.25 + u.cacheRead * inPrice * 0.1 + u.output * outPrice) / 1e6;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    if (err instanceof Anthropic.AuthenticationError) {
      console.error('No usable Anthropic credential: set ANTHROPIC_API_KEY (or run `ant auth login`).');
    } else {
      console.error(err);
    }
    process.exit(1);
  });
