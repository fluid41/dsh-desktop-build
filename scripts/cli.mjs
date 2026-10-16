import { appendFile, mkdir, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub } from './github.mjs';
import { UPSTREAM, CURRENT_TAG, versionFromTag, releaseTag, installerName, hash, selectUpstreamRelease, validateSource, shouldBuild, assertCompleteRelease, selectCurrentRelease, releaseIdentity, renderReleaseBody, renderCurrentBody } from './core.mjs';

function required(env, name) { const value = env[name]; if (!value) throw new Error(`Missing ${name}`); return value; }
function repository(env) {
  const repo = required(env, 'GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Invalid GitHub repository name');
  return repo;
}
function commit(value) { if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error('Invalid commit SHA'); return value; }
function https(value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Expected a public HTTPS URL'); return url.href; }
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }

export async function discover(env, api) {
  const repo = repository(env);
  const selected = selectUpstreamRelease(await api.listReleases(UPSTREAM), env.INPUT_TAG?.trim() || 'latest');
  const tag = selected.tag_name;
  const sourceSha = await api.resolveTag(UPSTREAM, tag);
  const [root, desktop] = await Promise.all([api.manifest(UPSTREAM, 'package.json', sourceSha), api.manifest(UPSTREAM, 'apps/desktop/package.json', sourceSha)]);
  const source = validateSource(tag, root, desktop);
  const existing = await api.getRelease(repo, releaseTag(tag));
  const outputs = { should_build: String(shouldBuild(existing, tag, sourceSha)), tag, version: source.version, source_sha: sourceSha, pnpm_version: source.pnpmVersion, release_tag: releaseTag(tag) };
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  console.log(`${tag} (${sourceSha}) — ${outputs.should_build === 'true' ? 'build required' : 'already published'}`);
  return outputs;
}

export async function collect(env) {
  const source = resolve(required(env, 'SOURCE_DIR'));
  const bundle = resolve(required(env, 'BUNDLE_DIR'));
  if (source === bundle || source.startsWith(`${bundle}/`) || source.startsWith(`${bundle}\\`)) throw new Error('Bundle must not contain the source directory');
  const tag = required(env, 'SOURCE_TAG');
  const root = await json(join(source, 'package.json'));
  const desktop = await json(join(source, 'apps', 'desktop', 'package.json'));
  const { version, pnpmVersion } = validateSource(tag, root, desktop);
  const artifacts = join(source, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts');
  const expected = installerName(version);
  const exes = (await readdir(artifacts, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.exe'));
  if (exes.length !== 1 || exes[0].name !== expected) throw new Error('Expected exactly one correctly versioned unsigned installer');
  if ((await stat(join(artifacts, expected))).size < 1_000_000) throw new Error('Installer is unexpectedly small');
  await mkdir(bundle, { recursive: true });
  if ((await readdir(bundle)).length) throw new Error('Bundle directory must start empty');
  await copyFile(join(artifacts, expected), join(bundle, expected));
  const build = {
    schemaVersion: 1, sourceRepository: UPSTREAM, sourceTag: tag, version,
    sourceSha: commit(required(env, 'SOURCE_SHA')), builderSha: commit(required(env, 'BUILDER_SHA')),
    runUrl: https(required(env, 'BUILD_RUN_URL')), builtAt: new Date().toISOString(),
    target: 'win-x64', unsigned: true, node: process.version, pnpm: pnpmVersion,
    installer: expected, sha256: hash(await readFile(join(bundle, expected))),
    checks: ['upstream packaged-runtime smoke', 'tracked source and root lock unchanged'],
  };
  const manifest = `${JSON.stringify(build, null, 2)}\n`;
  await writeFile(join(bundle, 'build.json'), manifest);
  await writeFile(join(bundle, 'SHA256SUMS'), `${build.sha256}  ${expected}\n${hash(Buffer.from(manifest))}  build.json\n`);
  console.log(`Collected ${expected}, SHA-256 ${build.sha256}`);
  return build;
}

export async function validateBundle(directory) {
  const build = await json(join(directory, 'build.json'));
  const version = versionFromTag(build.sourceTag);
  if (build.schemaVersion !== 1 || build.sourceRepository !== UPSTREAM || build.target !== 'win-x64' || build.unsigned !== true || version !== build.version || build.installer !== installerName(version)) throw new Error('Invalid build manifest');
  commit(build.sourceSha); commit(build.builderSha); https(build.runUrl);
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify([build.installer, 'build.json', 'SHA256SUMS'].sort())) throw new Error('Bundle must contain exactly the installer, manifest and checksum file');
  const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const expected = `${hash(await readFile(join(directory, build.installer)))}  ${build.installer}\n${hash(await readFile(join(directory, 'build.json')))}  build.json\n`;
  if (sums !== expected || !expected.startsWith(`${build.sha256}  `)) throw new Error('Bundle checksum mismatch');
  return build;
}

/** Publish a fully uploaded version before moving the fixed entry; partial drafts remain retryable. */
export async function publish(env, api) {
  const repo = repository(env);
  const directory = resolve(required(env, 'BUNDLE_DIR'));
  const build = await validateBundle(directory);
  const tag = releaseTag(build.sourceTag);
  let release = await api.getRelease(repo, tag);
  if (!release) {
    // GitHub's by-tag endpoint only returns published releases. Drafts must be recovered by ID.
    const drafts = (await api.listReleases(repo)).filter(item => item.tag_name === tag && item.draft);
    if (drafts.length > 1) throw new Error('Multiple drafts exist for this version; inspect the failed publication records');
    release = drafts[0];
  }
  if (release && !release.draft) {
    if (shouldBuild(release, build.sourceTag, build.sourceSha)) throw new Error('Unexpected published release state');
    await refresh(env, api);
    return release;
  }
  const body = renderReleaseBody(build, build.sha256);
  if (release) {
    const existing = releaseIdentity(release);
    if (existing.sourceSha !== build.sourceSha) throw new Error('Draft belongs to a different source commit');
    // Only draft assets for this exact version are replaced on retry, never published assets.
    for (const asset of release.assets ?? []) await api.request(`/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
    release = await api.request(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { body, target_commitish: build.builderSha } });
  } else {
    release = await api.request(`/repos/${repo}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: build.builderSha, name: `DSH Desktop ${build.version} · Windows x64`, body, draft: true, prerelease: true, make_latest: 'false' } });
  }
  for (const name of [build.installer, 'build.json', 'SHA256SUMS']) {
    const asset = await api.upload(repo, release, join(directory, name), name);
    if (asset.name !== name || asset.state !== 'uploaded' || asset.size !== (await stat(join(directory, name))).size) throw new Error(`Incomplete uploaded asset: ${name}`);
    if (asset.digest && asset.digest !== `sha256:${hash(await readFile(join(directory, name)))}`) throw new Error(`Uploaded digest mismatch: ${name}`);
  }
  const ready = await api.request(`/repos/${repo}/releases/${release.id}`);
  assertCompleteRelease({ ...ready, draft: false, published_at: new Date().toISOString() });
  release = await api.request(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { draft: false, make_latest: 'false' } });
  assertCompleteRelease(release);
  await refresh(env, api);
  return release;
}

export async function refresh(env, api) {
  const repo = repository(env);
  const release = selectCurrentRelease(await api.listReleases(repo));
  const identity = releaseIdentity(release);
  const current = await api.getRelease(repo, CURRENT_TAG);
  const body = renderCurrentBody(release);
  if (current?.body === body && current.draft === false) { console.log(`Current entry already points to ${identity.version}`); return release; }
  const oldVersion = /<!-- dsh-current-version:([^ ]+) -->/.exec(current?.body ?? '')?.[1];
  if (oldVersion) {
    const { compareVersions } = await import('./core.mjs');
    if (compareVersions(oldVersion, identity.version) > 0) throw new Error('Refusing to move the current download backwards');
  }
  const fields = { name: `当前下载 · DSH Desktop ${identity.version}`, body, draft: false, prerelease: true, make_latest: 'false' };
  if (current) await api.request(`/repos/${repo}/releases/${current.id}`, { method: 'PATCH', body: fields });
  else await api.request(`/repos/${repo}/releases`, { method: 'POST', body: { ...fields, tag_name: CURRENT_TAG, target_commitish: commit(required(env, 'GITHUB_SHA')) } });
  console.log(`Fixed download: https://github.com/${repo}/releases/tag/${CURRENT_TAG} → ${identity.version}`);
  return release;
}

export async function main(env = process.env, command = process.argv[2]) {
  const api = new GitHub(env.GH_TOKEN);
  if (command === 'discover') return discover(env, api);
  if (command === 'collect') return collect(env);
  if (command === 'publish') return publish(env, api);
  if (command === 'refresh') return refresh(env, api);
  throw new Error('Usage: node scripts/cli.mjs discover|collect|publish|refresh');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
