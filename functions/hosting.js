'use strict';

// Deploys a handful of small static files to a Firebase Hosting site through
// the REST API: versions.create -> populateFiles -> upload -> finalize ->
// release. The same four steps `firebase deploy` performs, without the CLI,
// because a Cloud Function cannot shell out to it.
//
// Lives in its own module, with `fetch` and the token source passed in, for
// one reason: this is the only path content takes to reach the app, it can
// only be exercised for real by publishing, and a publish is not something to
// try out on a live site. With the network injected it is tested end to end
// in test/hosting.test.js — the order of the calls, what each one carries, and
// what happens when each step fails.

const crypto = require('crypto');
const zlib = require('zlib');

const API = 'https://firebasehosting.googleapis.com/v1beta1';

/**
 * @param {object}   o
 * @param {string}   o.siteId       Hosting site id (not the project id)
 * @param {Object<string,string>} o.files   absolute path -> text content
 * @param {Array<{glob: string, headers: Object<string,string>}>} [o.headers]
 * @param {() => Promise<string>} o.getToken   OAuth token with the hosting scope
 * @param {typeof fetch} [o.fetchImpl]
 */
async function deployFiles({ siteId, files, headers: headerRules = [], getToken, fetchImpl = fetch }) {
  const paths = Object.keys(files);
  if (paths.length === 0) throw new Error('deployFiles: nothing to deploy');
  for (const p of paths) {
    // Hosting addresses files by absolute path. Without the slash the API does
    // not fail — it records a file nobody can request.
    if (!p.startsWith('/')) throw new Error(`deployFiles: "${p}" must start with a slash`);
  }

  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Hosting wants the hash of the gzipped bytes, and the gzipped bytes are
  // what gets uploaded.
  const gzByHash = new Map();
  const hashByPath = {};
  for (const p of paths) {
    const gz = zlib.gzipSync(Buffer.from(files[p]));
    const sha = crypto.createHash('sha256').update(gz).digest('hex');
    gzByHash.set(sha, gz);
    hashByPath[p] = sha;
  }

  const versionRes = await fetchImpl(`${API}/sites/${siteId}/versions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ config: { headers: headerRules } }),
  });
  const version = await versionRes.json();
  if (!version.name) throw new Error(`Failed to create hosting version: ${JSON.stringify(version)}`);

  const popRes = await fetchImpl(`${API}/${version.name}:populateFiles`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ files: hashByPath }),
  });
  const pop = await popRes.json();
  if (!pop.uploadUrl) throw new Error(`Failed to populate files: ${JSON.stringify(pop)}`);

  // Only what the API says it does not already have. When the field is absent
  // every file is uploaded, which is what the single-file version of this did.
  const required = pop.uploadRequiredHashes ?? [...gzByHash.keys()];
  for (const sha of required) {
    const gz = gzByHash.get(sha);
    if (!gz) throw new Error(`Hosting asked for a hash we did not send: ${sha}`);
    const uploadRes = await fetchImpl(`${pop.uploadUrl}/${sha}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: gz,
    });
    if (!uploadRes.ok) throw new Error(`Hosting upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  const finalizeRes = await fetchImpl(`${API}/${version.name}?updateMask=status`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'FINALIZED' }),
  });
  if (!finalizeRes.ok) throw new Error(`Failed to finalize version: ${finalizeRes.status} ${await finalizeRes.text()}`);

  const releaseRes = await fetchImpl(`${API}/sites/${siteId}/releases?versionName=${version.name}`, {
    method: 'POST',
    headers,
  });
  if (!releaseRes.ok) throw new Error(`Failed to release version: ${releaseRes.status} ${await releaseRes.text()}`);

  return { version: version.name, files: hashByPath };
}

module.exports = { deployFiles };
