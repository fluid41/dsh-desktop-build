import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM, compareVersions, selectUpstreamRelease, validateSource, shouldBuild, assertCompleteRelease, selectCurrentRelease, releaseTag, installerName, hash } from '../scripts/core.mjs';
import { discover, publish, refresh } from '../scripts/cli.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const BUILDER_SHA = 'b'.repeat(40);
const REPO = 'builder-owner/desktop-builder';
const VERSION = '0.2.1-alpha.10';
const TAG = `dsh-v${VERSION}`;
const baseEnv = { GITHUB_REPOSITORY: REPO, GITHUB_SHA: BUILDER_SHA };
const clone = value => value === undefined ? undefined : structuredClone(value);

function official(tag, overrides = {}) {
  return { tag_name: tag, draft: false, prerelease: true, published_at: '2026-01-01T00:00:00Z', ...overrides };
}

function complete(version = VERSION, overrides = {}) {
  const tag = `dsh-v${version}`;
  return {
    id: 10, tag_name: releaseTag(tag), draft: false, prerelease: true,
    published_at: '2026-01-01T00:00:00Z', html_url: `https://github.com/${REPO}/releases/tag/${releaseTag(tag)}`,
    body: `<!-- dsh-source-sha:${SOURCE_SHA} -->`,
    assets: [installerName(version), 'build.json', 'SHA256SUMS'].map((name, i) => ({
      id: i + 1, name, state: 'uploaded', size: 100,
      browser_download_url: `https://github.com/${REPO}/releases/download/${releaseTag(tag)}/${name}`,
    })),
    ...overrides,
  };
}

function discoveryApi({ releases = [official(TAG)], existing, sha = SOURCE_SHA } = {}) {
  const calls = [];
  return {
    calls,
    async listReleases(repo) { calls.push(['list', repo]); assert.equal(repo, UPSTREAM); return clone(releases); },
    async resolveTag(repo, tag) { calls.push(['resolve', repo, tag]); assert.equal(repo, UPSTREAM); return sha; },
    async manifest(repo, path, selectedSha) {
      calls.push(['manifest', repo, path, selectedSha]);
      assert.equal(repo, UPSTREAM); assert.equal(selectedSha, sha);
      return path === 'package.json'
        ? { version: VERSION, packageManager: 'pnpm@11.28.5' }
        : { version: VERSION, scripts: { 'package:win:x64:unsigned': 'official public entrypoint' } };
    },
    async getRelease(repo, tag) { calls.push(['get', repo, tag]); assert.equal(repo, REPO); assert.equal(tag, releaseTag(TAG)); return clone(existing); },
    async request() { assert.fail('Discovery must never write release state'); },
    async upload() { assert.fail('Discovery must never upload'); },
  };
}

async function bundle(t) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'channel-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${root}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const bytes = Buffer.from('mock EXE bytes, never executed');
  const build = {
    schemaVersion: 1, sourceRepository: UPSTREAM, sourceTag: TAG, version: VERSION,
    sourceSha: SOURCE_SHA, builderSha: BUILDER_SHA,
    runUrl: `https://github.com/${REPO}/actions/runs/123`, target: 'win-x64', unsigned: true,
    installer: installerName(VERSION), sha256: hash(bytes),
  };
  const manifest = `${JSON.stringify(build, null, 2)}\n`;
  await writeFile(join(directory, build.installer), bytes);
  await writeFile(join(directory, 'build.json'), manifest);
  await writeFile(join(directory, 'SHA256SUMS'), `${build.sha256}  ${build.installer}\n${hash(Buffer.from(manifest))}  build.json\n`);
  return { directory, build };
}

function publicationApi({ releases = [], current, failUploadAt, badDigest = false, missingReadyAsset = false } = {}) {
  const state = clone(releases);
  let pointer = clone(current);
  const events = [];
  let uploads = 0;
  const api = {
    events, state,
    get current() { return pointer; },
    async getRelease(repo, tag) {
      assert.equal(repo, REPO); events.push({ op: 'get-tag', tag });
      return clone(tag === 'current' ? pointer : state.find(item => item.tag_name === tag && !item.draft));
    },
    async listReleases(repo) { assert.equal(repo, REPO); events.push({ op: 'list' }); return clone(state); },
    async request(path, { method = 'GET', body } = {}) {
      events.push({ op: 'request', path, method, body: clone(body) });
      assert.ok(path.startsWith(`/repos/${REPO}/releases`));
      if (method === 'POST' && path === `/repos/${REPO}/releases`) {
        const created = { id: 100 + state.length, assets: [], ...clone(body), published_at: body.draft ? null : '2026-01-02T00:00:00Z' };
        created.html_url = `https://github.com/${REPO}/releases/tag/${created.tag_name}`;
        if (body.tag_name === 'current') pointer = created;
        else state.push(created);
        return clone(created);
      }
      const assetMatch = new RegExp(`^/repos/${REPO}/releases/assets/([0-9]+)$`).exec(path);
      if (method === 'DELETE' && assetMatch) {
        for (const item of state) item.assets = item.assets.filter(asset => asset.id !== Number(assetMatch[1]));
        return undefined;
      }
      const match = new RegExp(`^/repos/${REPO}/releases/([0-9]+)$`).exec(path);
      assert.ok(match, `Unexpected request ${method} ${path}`);
      const target = pointer?.id === Number(match[1]) ? pointer : state.find(item => item.id === Number(match[1]));
      assert.ok(target, 'Requested release exists');
      if (method === 'GET') {
        const result = clone(target);
        if (missingReadyAsset) result.assets = result.assets.filter(item => item.name !== 'SHA256SUMS');
        return result;
      }
      assert.equal(method, 'PATCH');
      Object.assign(target, clone(body));
      if (body.draft === false) target.published_at = '2026-01-02T00:00:00Z';
      return clone(target);
    },
    async upload(repo, release, file, name) {
      assert.equal(repo, REPO); uploads++;
      const target = state.find(item => item.id === release.id);
      assert.equal(target.draft, true, 'Uploads happen only to a draft');
      events.push({ op: 'upload', name });
      if (uploads === failUploadAt) throw new Error('Simulated upload failure');
      const bytes = await readFile(file);
      const asset = {
        id: uploads, name, size: bytes.length, state: 'uploaded',
        digest: `sha256:${badDigest ? '0'.repeat(64) : hash(bytes)}`,
        browser_download_url: `https://github.com/${REPO}/releases/download/${target.tag_name}/${name}`,
      };
      target.assets.push(asset);
      return clone(asset);
    },
  };
  return api;
}

function publishesVersion(event) {
  return event.op === 'request' && event.method === 'PATCH' && event.body?.draft === false && !event.body?.name;
}
function writesCurrent(event) {
  return event.op === 'request' && (event.body?.tag_name === 'current' || event.body?.name?.startsWith('当前下载'));
}

test('SemVer compares numeric alpha fields rather than lexical names or dates', () => {
  assert.equal(compareVersions('0.2.1-alpha.9', '0.2.1-alpha.10'), -1);
  assert.equal(compareVersions('0.2.1-alpha.10', '0.2.1-alpha.9'), 1);
  assert.equal(compareVersions('0.2.1-alpha.10', '0.2.1-alpha.10'), 0);
  assert.equal(compareVersions('0.2.1-alpha.10', '0.2.1'), -1);
});

test('latest ignores SDK, master, drafts, unpublished and stable releases', () => {
  const selected = selectUpstreamRelease([
    official('dsh-v0.2.1-alpha.9', { published_at: '2030-01-01T00:00:00Z' }),
    official('sdk-v99.0.0-alpha.99'), official('master'), official('nightly'),
    official('dsh-v99.0.0-alpha.99', { draft: true }),
    official('dsh-v98.0.0-alpha.99', { published_at: null }),
    official('dsh-v97.0.0-alpha.99', { prerelease: false }),
    official('dsh-v96.0.0', { prerelease: false }), official('dsh-v95.0.0'),
    official(TAG),
  ]);
  assert.equal(selected.tag_name, TAG);
});

test('explicit published official prerelease tag is honored, but not a branch or unpublished tag', () => {
  const older = 'dsh-v0.2.1-alpha.9';
  const releases = [official(TAG), official(older), official('dsh-v0.2.1-alpha.11', { draft: true })];
  assert.equal(selectUpstreamRelease(releases, older).tag_name, older);
  assert.throws(() => selectUpstreamRelease(releases, 'master'), /official/);
  assert.throws(() => selectUpstreamRelease(releases, 'sdk-v0.2.1-alpha.9'), /official/);
  assert.throws(() => selectUpstreamRelease(releases, 'dsh-v0.2.1-alpha.11'), /published/);
  assert.throws(() => selectUpstreamRelease([], 'latest'), /No published/);
});

test('source manifests must agree with the tag and declare exact pnpm', () => {
  const root = { version: VERSION, packageManager: 'pnpm@11.28.5' };
  const desktop = { version: VERSION, scripts: { 'package:win:x64:unsigned': 'entry' } };
  assert.deepEqual(validateSource(TAG, root, desktop), { version: VERSION, pnpmVersion: '11.28.5' });
  assert.throws(() => validateSource(TAG, { ...root, version: '0.2.1-alpha.9' }, desktop), /disagree/);
  assert.throws(() => validateSource(TAG, { ...root, packageManager: 'pnpm@latest' }, desktop), /exact pnpm/);
  assert.throws(() => validateSource(TAG, root, { version: VERSION, scripts: {} }), /entrypoint/);
});

test('only a complete published release at the same tag and SHA skips a build', () => {
  assert.equal(shouldBuild(undefined, TAG, SOURCE_SHA), true);
  assert.equal(shouldBuild({ draft: true }, TAG, SOURCE_SHA), true);
  assert.equal(shouldBuild(complete(), TAG, SOURCE_SHA), false);
  assert.throws(() => shouldBuild(complete(), TAG, 'c'.repeat(40)), /different source commit/);
});

test('a published release missing any required asset is rejected, not rebuilt or accepted', () => {
  for (const name of [installerName(VERSION), 'build.json', 'SHA256SUMS']) {
    const release = complete();
    release.assets = release.assets.filter(asset => asset.name !== name);
    assert.throws(() => assertCompleteRelease(release), /missing a complete/);
    assert.throws(() => shouldBuild(release, TAG, SOURCE_SHA), /missing a complete/);
  }
  const release = complete();
  release.assets[0].state = 'new';
  assert.throws(() => shouldBuild(release, TAG, SOURCE_SHA), /missing a complete/);
});

test('discover is read-only and resolves official manifests at a single SHA', async () => {
  const api = discoveryApi();
  const outputs = await discover({ ...baseEnv, INPUT_TAG: 'latest' }, api);
  assert.deepEqual(outputs, {
    should_build: 'true', tag: TAG, version: VERSION, source_sha: SOURCE_SHA,
    pnpm_version: '11.28.5', release_tag: releaseTag(TAG),
  });
  assert.deepEqual(api.calls.filter(call => call[0] === 'manifest').map(call => call[3]), [SOURCE_SHA, SOURCE_SHA]);
});

test('discover skips an already successful matching release and rejects a moved tag', async () => {
  assert.equal((await discover(baseEnv, discoveryApi({ existing: complete() }))).should_build, 'false');
  await assert.rejects(discover(baseEnv, discoveryApi({ existing: complete(), sha: 'c'.repeat(40) })), /different source commit/);
});

test('upload failure leaves a draft and never publishes or changes current', async t => {
  const fixture = await bundle(t);
  const api = publicationApi({ failUploadAt: 2 });
  await assert.rejects(publish({ ...baseEnv, BUNDLE_DIR: fixture.directory }, api), /Simulated upload failure/);
  assert.equal(api.state.length, 1);
  assert.equal(api.state[0].draft, true);
  assert.equal(api.events.some(publishesVersion), false);
  assert.equal(api.events.some(writesCurrent), false);
  assert.equal(api.events.filter(event => event.op === 'list').length, 1, 'Only the draft-recovery lookup ran; current was not refreshed');
});

test('bad uploaded digest prevents publication and current update', async t => {
  const fixture = await bundle(t);
  const api = publicationApi({ badDigest: true });
  await assert.rejects(publish({ ...baseEnv, BUNDLE_DIR: fixture.directory }, api), /digest mismatch/);
  assert.equal(api.events.some(publishesVersion), false);
  assert.equal(api.events.some(writesCurrent), false);
});

test('the fetched draft must contain every uploaded asset before publication', async t => {
  const fixture = await bundle(t);
  const api = publicationApi({ missingReadyAsset: true });
  await assert.rejects(publish({ ...baseEnv, BUNDLE_DIR: fixture.directory }, api), /missing a complete/);
  assert.equal(api.events.filter(event => event.op === 'upload').length, 3);
  assert.equal(api.events.some(publishesVersion), false);
  assert.equal(api.events.some(writesCurrent), false);
});

test('publish completes all uploads, verifies draft, publishes version, then writes current', async t => {
  const fixture = await bundle(t);
  const api = publicationApi();
  const published = await publish({ ...baseEnv, BUNDLE_DIR: fixture.directory }, api);
  assert.equal(published.draft, false);
  assert.equal(published.prerelease, true);
  const create = api.events.find(event => event.method === 'POST' && event.body?.tag_name === releaseTag(TAG));
  assert.equal(create.body.draft, true);
  assert.equal(create.body.make_latest, 'false');
  const lastUpload = api.events.findLastIndex(event => event.op === 'upload');
  const ready = api.events.findIndex(event => event.op === 'request' && event.method === 'GET');
  const publishIndex = api.events.findIndex(publishesVersion);
  const currentIndex = api.events.findIndex(writesCurrent);
  assert.ok(lastUpload < ready && ready < publishIndex && publishIndex < currentIndex);
  assert.equal(api.events.filter(event => event.op === 'upload').length, 3);
  assert.match(api.current.body, new RegExp(`dsh-current-version:${VERSION.replaceAll('.', '\\.')}`));
});

test('refresh chooses the greatest complete SemVer regardless of list order', async () => {
  const low = complete('0.2.1-alpha.9', { id: 9 });
  const high = complete(VERSION, { id: 10 });
  assert.equal(selectCurrentRelease([low, high]).tag_name, high.tag_name);
  const api = publicationApi({ releases: [low, high], current: { id: 90, tag_name: 'current', draft: false, body: '<!-- dsh-current-version:0.2.1-alpha.9 -->' } });
  const selected = await refresh(baseEnv, api);
  assert.equal(selected.tag_name, high.tag_name);
  assert.match(api.current.body, /dsh-current-version:0\.2\.1-alpha\.10/);
  assert.equal(api.events.filter(writesCurrent).length, 1);
});

test('refresh refuses to downgrade a newer current pointer', async () => {
  const api = publicationApi({ releases: [complete()], current: { id: 90, tag_name: 'current', draft: false, body: '<!-- dsh-current-version:0.2.1-alpha.11 -->' } });
  await assert.rejects(refresh(baseEnv, api), /backwards/);
  assert.equal(api.events.some(writesCurrent), false);
});

test('an already-published discover result can still repair a missing current pointer', async () => {
  const published = complete();
  const result = await discover(baseEnv, discoveryApi({ existing: published }));
  assert.equal(result.should_build, 'false');
  const api = publicationApi({ releases: [published] });
  await refresh(baseEnv, api);
  assert.match(api.current.body, /dsh-current-version:0\.2\.1-alpha\.10/);
  assert.equal(api.events.some(event => event.op === 'upload'), false);
  assert.equal(api.events.some(publishesVersion), false);
});

test('a failed draft is recovered from the release list when the by-tag API returns 404', async t => {
  const fixture = await bundle(t);
  const draft = complete(VERSION, { draft: true, published_at: null });
  const api = publicationApi({ releases: [draft] });
  const result = await publish({ ...baseEnv, BUNDLE_DIR: fixture.directory }, api);
  assert.equal(result.id, draft.id);
  assert.equal(result.draft, false);
  assert.equal(api.events.filter(event => event.method === 'POST' && event.body?.tag_name === releaseTag(TAG)).length, 0);
  assert.equal(api.events.filter(event => event.method === 'DELETE').length, 3);
  assert.equal(api.events.filter(event => event.op === 'upload').length, 3);
});

test('publish retry of an existing completed version only repairs current', async t => {
  const fixture = await bundle(t);
  const api = publicationApi({ releases: [complete()] });
  await publish({ ...baseEnv, BUNDLE_DIR: fixture.directory }, api);
  assert.equal(api.events.some(event => event.op === 'upload'), false);
  assert.equal(api.events.some(publishesVersion), false);
  assert.equal(api.events.filter(writesCurrent).length, 1);
});
