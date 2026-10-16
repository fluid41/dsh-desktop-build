import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');

test('job-level environment uses contexts available before a runner starts', () => {
  const environments = [...workflow.matchAll(/^    env:\r?\n((?:^      .*(?:\r?\n|$))+)/gm)];
  assert.equal(environments.length, 2);
  for (const [, block] of environments) {
    const contexts = [...block.matchAll(/\$\{\{\s*([A-Za-z_]+)\./g)].map(match => match[1]);
    assert.ok(contexts.every(context => ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'].includes(context)), `Unsupported job env context in ${block}`);
  }
});

test('only the isolated publisher can write repository contents', () => {
  assert.match(workflow, /^permissions: \{\}/m);
  assert.equal((workflow.match(/contents: write/g) ?? []).length, 1);
  const publisher = workflow.split(/^  publish:/m)[1];
  assert.match(publisher, /contents: write/);
  assert.doesNotMatch(publisher, /working-directory: source|repository: deepseek-ai/);
});

test('source checkout and upstream packaging stay separate from all local configuration', () => {
  assert.match(workflow, /repository: deepseek-ai\/deepseek-harness/);
  assert.match(workflow, /ref: \$\{\{ needs\.discover\.outputs\.source_sha \}\}/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm run package:desktop:win:x64:unsigned/);
  assert.match(workflow, /git -C \$env:SOURCE_DIR diff --exit-code HEAD/);
  assert.doesNotMatch(workflow, /account-policy|git apply|git reset|--no-verify/);
});
