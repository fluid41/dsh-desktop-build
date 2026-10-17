import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, validateBundle } from '../scripts/cli.mjs';
import { installerName } from '../scripts/core.mjs';

async function fixture(t) {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '.tmp');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'bundle-'));
  t.after(async () => { assert.ok(root.startsWith(`${base}${sep}`)); await rm(root, { recursive: true, force: true }); });
  const source = join(root, 'source');
  const desktop = join(source, 'apps', 'desktop');
  const artifacts = join(desktop, '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts');
  await mkdir(artifacts, { recursive: true });
  const version = '0.2.1-alpha.5';
  await writeFile(join(source, 'package.json'), JSON.stringify({ version, packageManager: 'pnpm@11.28.5' }));
  await writeFile(join(desktop, 'package.json'), JSON.stringify({ version, scripts: { 'package:win:x64:unsigned': 'upstream' } }));
  const exe = join(artifacts, installerName(version));
  await writeFile(exe, Buffer.alloc(1_000_001, 42));
  const env = { SOURCE_DIR: source, BUNDLE_DIR: join(root, 'output'), SOURCE_TAG: `dsh-v${version}`, SOURCE_SHA: 'a'.repeat(40), BUILDER_SHA: 'b'.repeat(40), BUILD_RUN_URL: 'https://github.com/owner/repo/actions/runs/1' };
  return { env, artifacts, exe, source };
}

test('a collected installer retains the full product version, source identity and matching hashes', async t => {
  const { env } = await fixture(t);
  const build = await collect(env);
  assert.equal(build.version, '0.2.1-alpha.5');
  assert.equal(build.sourceSha, env.SOURCE_SHA);
  assert.equal(build.unsigned, true);
  assert.deepEqual(await validateBundle(env.BUNDLE_DIR), build);
});

test('a modified asset is rejected before a release upload', async t => {
  const { env } = await fixture(t);
  const build = await collect(env);
  await writeFile(join(env.BUNDLE_DIR, build.installer), 'changed installer bytes');
  await assert.rejects(validateBundle(env.BUNDLE_DIR), /校验值不一致/);
});

test('more than one installer cannot become a publication bundle', async t => {
  const { env, artifacts } = await fixture(t);
  await writeFile(join(artifacts, 'unexpected.exe'), 'not the selected product');
  await assert.rejects(collect(env), /应有且仅有一个/);
});

test('source version mismatch and unexpectedly small output fail collection', async t => {
  const { env, exe, source } = await fixture(t);
  await writeFile(exe, 'tiny');
  await assert.rejects(collect(env), /体积异常/);
  const original = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  await writeFile(join(source, 'package.json'), JSON.stringify({ ...original, version: '0.2.1-alpha.4' }));
  await assert.rejects(collect(env), /不一致/);
});
