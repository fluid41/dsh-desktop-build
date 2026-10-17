import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderReleaseBody, renderCurrentBody, installerName, releaseTag } from '../scripts/core.mjs';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
const badge = '[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)';
const version = '0.2.1-alpha.5';
const sourceTag = `dsh-v${version}`;
const sourceSha = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);
const repo = 'owner/desktop-build';
const build = { sourceTag, sourceSha, runUrl: `https://github.com/${repo}/actions/runs/123` };
const release = {
  tag_name: releaseTag(sourceTag), draft: false, published_at: '2026-10-17T00:00:00Z',
  html_url: `https://github.com/${repo}/releases/tag/${releaseTag(sourceTag)}`,
  body: `<!-- dsh-source-sha:${sourceSha} -->`,
  assets: [installerName(version), 'build.json', 'SHA256SUMS'].map(name => ({
    name, state: 'uploaded', size: 100,
    browser_download_url: `https://github.com/${repo}/releases/download/${releaseTag(sourceTag)}/${name}`,
  })),
};

// GitHub 定时任务使用 UTC；北京时间没有夏令时。
test('每六小时整点检查，对应北京时间 00、06、12、18 点', () => {
  const schedules = [...workflow.matchAll(/cron: '([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(schedules, ['0 4,10,16,22 * * *']);
  const [minute, hours, day, month, weekday] = schedules[0].split(' ');
  assert.equal(minute, '0');
  assert.deepEqual([day, month, weekday], ['*', '*', '*']);
  const beijingHours = hours.split(',').map(hour => (Number(hour) + 8) % 24).sort((a, b) => a - b);
  assert.deepEqual(beijingHours, [0, 6, 12, 18]);
  for (const time of ['00:00', '06:00', '12:00', '18:00']) {
    assert.ok(readme.includes(time));
    assert.ok(renderCurrentBody(release).includes(time));
  }
});

test('说明文档与发布页均使用官方徽标，并紧随第一行主标题放置', () => {
  for (const text of [readme, renderReleaseBody(build, sha256), renderCurrentBody(release)]) {
    assert.equal(text.split(badge).length - 1, 1);
    const lines = text.split(/\r?\n/);
    assert.match(lines[0], /^#{1,2}\s+.+/);
    assert.equal(lines[1], '');
    assert.equal(lines[2], badge);
    assert.equal(lines[3], '');
    assert.ok(lines[4].length > 0);
  }
});

test('版本说明保留源码、日志、校验值与自动化标记', () => {
  const body = renderReleaseBody(build, sha256);
  assert.ok(body.includes(`https://github.com/deepseek-ai/deepseek-harness/tree/${sourceSha}`));
  assert.ok(body.includes(build.runUrl));
  assert.ok(body.includes(sha256));
  assert.ok(body.includes(`<!-- dsh-source-sha:${sourceSha} -->`));
  assert.match(body, /未签名/);
  assert.match(body, /手动更新/);
  assert.match(body, /无需先卸载/);
  assert.doesNotMatch(body, /尚未人工日用验收/);
});

test('固定下载页链接指向实际附件及本仓库历史版本', () => {
  const body = renderCurrentBody(release);
  for (const asset of release.assets.filter(asset => asset.name !== 'build.json')) {
    assert.ok(body.includes(asset.browser_download_url));
  }
  assert.ok(body.includes(`[历史版本](https://github.com/${repo}/releases/)`));
  assert.ok(body.includes(`<!-- dsh-current-version:${version} -->`));
  assert.ok(body.includes(`<!-- dsh-source-sha:${sourceSha} -->`));
  assert.doesNotMatch(body, /\]\(\.\.\//);
});

test('手动运行入口名称与工作流一致，不再描述旧轮询时间', () => {
  assert.match(workflow, /^name: 构建 Windows 安装包$/m);
  assert.match(readme, /Actions → 构建 Windows 安装包 → Run workflow/);
  assert.doesNotMatch(readme + workflow, /每小时第 17 分钟|17 \* \* \* \*|Build unsigned Windows desktop/);
});
