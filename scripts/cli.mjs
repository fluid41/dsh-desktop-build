import { appendFile, mkdir, readFile, readdir, stat, writeFile, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub } from './github.mjs';
import { UPSTREAM, CURRENT_TAG, versionFromTag, releaseTag, installerName, hash, selectUpstreamRelease, validateSource, shouldBuild, assertCompleteRelease, selectCurrentRelease, releaseIdentity, renderReleaseBody, renderCurrentBody } from './core.mjs';

function required(env, name) { const value = env[name]; if (!value) throw new Error(`缺少环境变量 ${name}`); return value; }
function repository(env) {
  const repo = required(env, 'GITHUB_REPOSITORY');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('GitHub 仓库名称无效');
  return repo;
}
function commit(value) { if (!/^[0-9a-f]{40}$/.test(value ?? '')) throw new Error('提交 SHA 无效'); return value; }
function https(value) { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('请使用不含凭据的 HTTPS 地址'); return url.href; }
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
  console.log(`${tag} (${sourceSha}) — ${outputs.should_build === 'true' ? '需要构建' : '已发布，跳过构建'}`);
  return outputs;
}

export async function collect(env) {
  const source = resolve(required(env, 'SOURCE_DIR'));
  const bundle = resolve(required(env, 'BUNDLE_DIR'));
  if (source === bundle || source.startsWith(`${bundle}/`) || source.startsWith(`${bundle}\\`)) throw new Error('发布目录不能包含源码目录');
  const tag = required(env, 'SOURCE_TAG');
  const root = await json(join(source, 'package.json'));
  const desktop = await json(join(source, 'apps', 'desktop', 'package.json'));
  const { version, pnpmVersion } = validateSource(tag, root, desktop);
  const artifacts = join(source, 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts');
  const expected = installerName(version);
  const exes = (await readdir(artifacts, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.exe'));
  if (exes.length !== 1 || exes[0].name !== expected) throw new Error('应有且仅有一个版本匹配的未签名安装包');
  if ((await stat(join(artifacts, expected))).size < 1_000_000) throw new Error('安装包体积异常，已停止收集');
  await mkdir(bundle, { recursive: true });
  if ((await readdir(bundle)).length) throw new Error('收集前的发布目录必须为空');
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
  console.log(`已收集 ${expected}，SHA-256：${build.sha256}`);
  return build;
}

export async function validateBundle(directory) {
  const build = await json(join(directory, 'build.json'));
  const version = versionFromTag(build.sourceTag);
  if (build.schemaVersion !== 1 || build.sourceRepository !== UPSTREAM || build.target !== 'win-x64' || build.unsigned !== true || version !== build.version || build.installer !== installerName(version)) throw new Error('构建清单无效');
  commit(build.sourceSha); commit(build.builderSha); https(build.runUrl);
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify([build.installer, 'build.json', 'SHA256SUMS'].sort())) throw new Error('发布目录只能包含安装包、构建清单和校验文件');
  const sums = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const expected = `${hash(await readFile(join(directory, build.installer)))}  ${build.installer}\n${hash(await readFile(join(directory, 'build.json')))}  build.json\n`;
  if (sums !== expected || !expected.startsWith(`${build.sha256}  `)) throw new Error('发布文件校验值不一致');
  return build;
}

/** 全部文件上传完成后再发布并更新下载入口；未完成的草稿可重试。 */
export async function publish(env, api) {
  const repo = repository(env);
  const directory = resolve(required(env, 'BUNDLE_DIR'));
  const build = await validateBundle(directory);
  const tag = releaseTag(build.sourceTag);
  let release = await api.getRelease(repo, tag);
  if (!release) {
    // GitHub 的标签接口只返回已发布版本；从版本列表中找回草稿。
    const drafts = (await api.listReleases(repo)).filter(item => item.tag_name === tag && item.draft);
    if (drafts.length > 1) throw new Error('此版本存在多个草稿，请检查失败的发布记录');
    release = drafts[0];
  }
  if (release && !release.draft) {
    if (shouldBuild(release, build.sourceTag, build.sourceSha)) throw new Error('已发布版本的状态异常');
    await refresh(env, api);
    return release;
  }
  const body = renderReleaseBody(build, build.sha256);
  if (release) {
    const existing = releaseIdentity(release);
    if (existing.sourceSha !== build.sourceSha) throw new Error('草稿对应的源码提交不同');
    // 重试时仅替换此版本的草稿附件，不修改已发布文件。
    for (const asset of release.assets ?? []) await api.request(`/repos/${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
    release = await api.request(`/repos/${repo}/releases/${release.id}`, { method: 'PATCH', body: { body, target_commitish: build.builderSha } });
  } else {
    release = await api.request(`/repos/${repo}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: build.builderSha, name: `DSH Desktop ${build.version} · Windows x64`, body, draft: true, prerelease: true, make_latest: 'false' } });
  }
  for (const name of [build.installer, 'build.json', 'SHA256SUMS']) {
    const asset = await api.upload(repo, release, join(directory, name), name);
    if (asset.name !== name || asset.state !== 'uploaded' || asset.size !== (await stat(join(directory, name))).size) throw new Error(`上传文件不完整：${name}`);
    if (asset.digest && asset.digest !== `sha256:${hash(await readFile(join(directory, name)))}`) throw new Error(`上传文件校验值不一致：${name}`);
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
  if (current?.body === body && current.draft === false) { console.log(`下载入口已是 ${identity.version}`); return release; }
  const oldVersion = /<!-- dsh-current-version:([^ ]+) -->/.exec(current?.body ?? '')?.[1];
  if (oldVersion) {
    const { compareVersions } = await import('./core.mjs');
    if (compareVersions(oldVersion, identity.version) > 0) throw new Error('目标版本低于当前版本，已停止更新下载入口');
  }
  const fields = { name: `当前下载 · DSH Desktop ${identity.version}`, body, draft: false, prerelease: true, make_latest: 'false' };
  if (current) await api.request(`/repos/${repo}/releases/${current.id}`, { method: 'PATCH', body: fields });
  else await api.request(`/repos/${repo}/releases`, { method: 'POST', body: { ...fields, tag_name: CURRENT_TAG, target_commitish: commit(required(env, 'GITHUB_SHA')) } });
  console.log(`下载入口：https://github.com/${repo}/releases/tag/${CURRENT_TAG} → ${identity.version}`);
  return release;
}

export async function main(env = process.env, command = process.argv[2]) {
  const api = new GitHub(env.GH_TOKEN);
  if (command === 'discover') return discover(env, api);
  if (command === 'collect') return collect(env);
  if (command === 'publish') return publish(env, api);
  if (command === 'refresh') return refresh(env, api);
  throw new Error('用法：node scripts/cli.mjs discover|collect|publish|refresh');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
