import { createHash } from 'node:crypto';

export const UPSTREAM = 'deepseek-ai/deepseek-harness';
export const CURRENT_TAG = 'current';
const DSH_BADGE = '[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?$`);

/** 解析上游打包流程支持的产品版本号（不含构建元数据）。 */
export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 128) throw new Error('产品版本号无效');
  const match = versionPattern.exec(value);
  if (!match) throw new Error(`产品版本号无效：${value}`);
  return { value, main: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? [] };
}

function compareInteger(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** 按 SemVer 比较版本，包括预发布版本中的数字标识。 */
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
  if (typeof tag !== 'string' || !tag.startsWith('dsh-v')) throw new Error('请使用官方 dsh-v 产品标签');
  const version = tag.slice(5);
  const parsed = parseVersion(version);
  if (!parsed.pre.length) throw new Error('此项目仅跟随预发布产品标签');
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
    if (!found) throw new Error(`未找到此标签对应的官方预发布版本：${requested}`);
    return found;
  }
  candidates.sort((a, b) => compareVersions(versionFromTag(b.tag_name), versionFromTag(a.tag_name)));
  if (!candidates.length) throw new Error('未找到已发布的官方产品预发布版本');
  return candidates[0];
}

export function validateSource(tag, root, desktop) {
  const version = versionFromTag(tag);
  if (root.version !== version || desktop.version !== version) throw new Error('标签、根目录版本和 Desktop 版本不一致');
  const manager = /^pnpm@([0-9]+\.[0-9]+\.[0-9]+)(?:\+sha[0-9]+\.[A-Za-z0-9+/=]+)?$/.exec(root.packageManager ?? '');
  if (!manager) throw new Error('源码必须指定精确的 pnpm 版本');
  if (!desktop.scripts?.['package:win:x64:unsigned']) throw new Error('源码未提供 Windows 未签名打包入口');
  return { version, pnpmVersion: manager[1] };
}

export function releaseIdentity(release) {
  const tag = release.tag_name?.replace(/^desktop-/, '');
  if (release.tag_name !== `desktop-${tag}`) throw new Error('不是带版本号的 Desktop 构建记录');
  const version = versionFromTag(tag);
  const sourceSha = /<!-- dsh-source-sha:([0-9a-f]{40}) -->/.exec(release.body ?? '')?.[1];
  if (!sourceSha) throw new Error('发布记录缺少源码提交信息');
  return { tag, version, sourceSha };
}

export function assertCompleteRelease(release) {
  if (release.draft || !release.published_at) throw new Error('此版本尚未发布');
  const identity = releaseIdentity(release);
  for (const name of [installerName(identity.version), 'build.json', 'SHA256SUMS']) {
    const matching = (release.assets ?? []).filter(asset => asset.name === name && asset.state === 'uploaded' && asset.size > 0);
    if (matching.length !== 1) throw new Error(`发布文件 ${name} 缺失或不完整`);
  }
  return identity;
}

export function shouldBuild(existing, tag, sourceSha) {
  if (!existing || existing.draft) return true;
  const identity = assertCompleteRelease(existing);
  if (identity.tag !== tag || identity.sourceSha !== sourceSha) throw new Error('已有版本的源码提交不同，已停止替换');
  return false;
}

export function selectCurrentRelease(releases) {
  const complete = releases.filter(item => {
    if (!item.tag_name?.startsWith('desktop-dsh-v') || item.draft) return false;
    // 版本记录不完整时直接报错，不将它设为下载目标。
    assertCompleteRelease(item);
    return true;
  });
  complete.sort((a, b) => compareVersions(releaseIdentity(b).version, releaseIdentity(a).version));
  if (!complete.length) throw new Error('没有文件完整的 Desktop 构建版本');
  return complete[0];
}

export function renderReleaseBody(build, exeHash) {
  const version = versionFromTag(build.sourceTag);
  return `## DSH Desktop ${version} · Windows x64

基于官方预发布标签原样构建，已通过上游打包和运行时检查。

### 安装与更新

从系统托盘完全退出 DSH 后，运行下方 EXE，安装到原目录即可。更新或从官方版迁移无需先卸载；首次迁移前建议备份数据。

安装包未签名，Windows 可能提示未知发布者。此构建需手动更新，保留上游强制更新策略。

### 构建信息

- 官方源码：[${build.sourceTag}](https://github.com/${UPSTREAM}/tree/${build.sourceSha})
- 源码提交：\`${build.sourceSha}\`
- 构建日志：[GitHub Actions](${build.runUrl})
- 安装包 SHA-256：\`${exeHash}\`

${DSH_BADGE}

<!-- dsh-source-sha:${build.sourceSha} -->
`;
}

export function renderCurrentBody(release) {
  const { version, sourceSha } = assertCompleteRelease(release);
  const exe = release.assets.find(asset => asset.name === installerName(version));
  const sums = release.assets.find(asset => asset.name === 'SHA256SUMS');
  const historyUrl = new URL('../..', `${release.html_url}/`).href;
  return `# 当前版本：${version}

## [下载 Windows x64 安装包](${exe.browser_download_url})

[SHA-256 校验值](${sums.browser_download_url}) · [版本与构建详情](${release.html_url}) · [历史版本](${historyUrl})

官方源码原样构建 · 检查通过 · 未签名 · 手动更新

完全退出 DSH 后运行安装包，安装到原目录即可，无需先卸载。

每天北京时间 **00:00、06:00、12:00、18:00** 检查新版。新版本构建并校验成功后更新此入口，失败时保留上一可用版本。

在仓库 **Watch → Custom → Releases** 订阅新版通知。

${DSH_BADGE}

<!-- dsh-current-version:${version} -->
<!-- dsh-source-sha:${sourceSha} -->
`;
}
