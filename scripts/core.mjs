import { createHash } from 'node:crypto';

export const UPSTREAM = 'deepseek-ai/deepseek-harness';
export const CURRENT_TAG = 'current';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?$`);

/** Parse the product versions accepted by the upstream packaging entrypoint (no build metadata). */
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) throw new Error('Invalid product version');
  const match = versionPattern.exec(value);
  if (!match) throw new Error(`Invalid product version: ${value}`);
  return { value, main: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}

function compareInteger(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Compare SemVer precedence, including numeric prerelease identifiers rather than lexical dates. */
export function compareVersions(a, b) {
  const left = parseVersion(a); const right = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const order = compareInteger(left.main[i], right.main[i]);
    if (order) return order;
  }
  if (!left.pre.length || !right.pre.length) return compareInteger(!left.pre.length, !right.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i]; const y = right.pre[i];
    if (x === undefined || y === undefined) return compareInteger(left.pre.length, right.pre.length);
    if (x === y) continue;
    const nx = /^[0-9]+$/.test(x); const ny = /^[0-9]+$/.test(y);
    if (nx && ny) return compareInteger(BigInt(x), BigInt(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

export function versionFromTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith('dsh-v')) throw new Error('Expected an official dsh-v product tag');
  const version = tag.slice(5);
  const parsed = parseVersion(version);
  if (!parsed.pre.length) throw new Error('This channel follows prerelease product tags');
  return version;
}

export function releaseTag(tag) { versionFromTag(tag); return `desktop-${tag}`; }
export function installerName(version) { parseVersion(version); return `deepseek-harness-${version}-win-x64-unsigned.exe`; }
export function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

export function selectUpstreamRelease(releases, requested = 'latest') {
  const candidates = releases.filter(item => {
    if (item.draft || item.prerelease !== true || !item.published_at) return false;
    try { versionFromTag(item.tag_name); return true; } catch { return false; }
  });
  if (requested !== 'latest') {
    versionFromTag(requested);
    const found = candidates.find(item => item.tag_name === requested);
    if (!found) throw new Error(`No published official prerelease found for ${requested}`);
    return found;
  }
  candidates.sort((a, b) => compareVersions(versionFromTag(b.tag_name), versionFromTag(a.tag_name)));
  if (!candidates.length) throw new Error('No published official product prereleases found');
  return candidates[0];
}

export function validateSource(tag, root, desktop) {
  const version = versionFromTag(tag);
  if (root.version !== version || desktop.version !== version) throw new Error('Tag, root version and Desktop version disagree');
  const manager = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+sha[0-9]+\.[A-Za-z0-9+/=]+)?$/.exec(root.packageManager ?? '');
  if (!manager) throw new Error('Source must declare an exact pnpm version');
  if (!desktop.scripts?.['package:win:x64:unsigned']) throw new Error('Source no longer exposes the unsigned Windows packaging entrypoint');
  return { version, pnpmVersion: manager[1] };
}

export function releaseIdentity(release) {
  const tag = release.tag_name?.replace(/^desktop-/, '');
  if (release.tag_name !== `desktop-${tag}`) throw new Error('Not a versioned Desktop build release');
  const version = versionFromTag(tag);
  const sourceSha = /<!-- dsh-source-sha:([0-9a-f]{40}) -->/.exec(release.body ?? '')?.[1];
  if (!sourceSha) throw new Error('Release is missing its source commit record');
  return { tag, version, sourceSha };
}

export function assertCompleteRelease(release) {
  if (release.draft || !release.published_at) throw new Error('Release has not been published');
  const identity = releaseIdentity(release);
  for (const name of [installerName(identity.version), 'build.json', 'SHA256SUMS']) {
    const matching = (release.assets ?? []).filter(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0);
    if (matching.length !== 1) throw new Error(`Release is missing a complete ${name} asset`);
  }
  return identity;
}

export function shouldBuild(existing, tag, sourceSha) {
  if (!existing || existing.draft) return true;
  const identity = assertCompleteRelease(existing);
  if (identity.tag !== tag || identity.sourceSha !== sourceSha) throw new Error('An existing release records a different source commit; refusing to replace it');
  return false;
}

export function selectCurrentRelease(releases) {
  const complete = releases.filter(item => {
    if (!item.tag_name?.startsWith('desktop-dsh-v') || item.draft) return false;
    // A malformed product release must be visible as a failure, not silently become the download target.
    assertCompleteRelease(item);
    return true;
  });
  complete.sort((a, b) => compareVersions(releaseIdentity(b).version, releaseIdentity(a).version));
  if (!complete.length) throw new Error('No complete Desktop build release exists');
  return complete[0];
}

export function renderReleaseBody(build, exeHash) {
  const version = versionFromTag(build.sourceTag);
  return `## DSH Desktop ${version} · Windows x64\n\n非官方自行构建，产品源码未经修改。安装包未签名；构建与上游内置检查已通过，尚未人工日用验收。\n\n- 官方源码：[${build.sourceTag}](https://github.com/${UPSTREAM}/tree/${build.sourceSha})\n- 源码提交：\`${build.sourceSha}\`\n- 构建记录：[GitHub Actions](${build.runUrl})\n- 安装：先完全退出 DSH，再运行下方 EXE。下次更新同样手动下载安装。\n- 完整 SHA-256：\`${exeHash}\`\n\n保留原版数据行为和官方强制更新策略；此未签名包不启用普通自动更新。\n\n<!-- dsh-source-sha:${build.sourceSha} -->\n`;
}

export function renderCurrentBody(release) {
  const { version, sourceSha } = assertCompleteRelease(release);
  const exe = release.assets.find(asset => asset.name === installerName(version));
  const sums = release.assets.find(asset => asset.name === 'SHA256SUMS');
  return `# 当前可用构建：${version}\n\n## [下载 Windows x64 安装包](${exe.browser_download_url})\n\n[校验值](${sums.browser_download_url}) · [版本与构建详情](${release.html_url}) · [历史版本](../../releases)\n\n官方源码原样构建 · 未签名 · 自动检查通过 · 手动安装更新\n\n新构建失败不会改变此入口。首次使用请在仓库 Watch → Custom 中订阅 Releases；每个新版发布时由 GitHub 通知。\n\n<!-- dsh-current-version:${version} -->\n<!-- dsh-source-sha:${sourceSha} -->\n`;
}
