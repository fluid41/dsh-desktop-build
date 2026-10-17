import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub, GitHubError } from '../scripts/github.mjs';

test('API credentials are never forwarded to arbitrary hosts or redirect targets', async () => {
  let calls = 0;
  const api = new GitHub('test-token', { fetcher: async (url, options) => {
    calls++;
    assert.equal(url.hostname, 'api.github.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    return new Response('{"login":"test"}', { status: 200 });
  } });
  await assert.rejects(api.request('https://example.com/collect'), /不允许向此地址/);
  await assert.rejects(api.request('http://api.github.com/user'), /不允许向此地址/);
  assert.equal(calls, 0);
  assert.equal((await api.request('/user')).login, 'test');
  assert.equal(calls, 1);
});

test('discovery paginates releases rather than ignoring older product tags', async () => {
  const pages = [];
  const api = new GitHub(undefined, { fetcher: async url => {
    pages.push(url.searchParams.get('page'));
    return Response.json(pages.length === 1 ? Array.from({ length: 100 }, (_, i) => ({ id: i })) : [{ id: 100 }]);
  } });
  assert.equal((await api.listReleases('owner/repo')).length, 101);
  assert.deepEqual(pages, ['1', '2']);
});

test('only a real 404 represents a missing release', async () => {
  const missing = new GitHub(undefined, { fetcher: async () => Response.json({ message: 'Not Found' }, { status: 404 }) });
  assert.equal(await missing.getRelease('owner/repo', 'tag'), undefined);
  const denied = new GitHub(undefined, { fetcher: async () => Response.json({ message: 'rate limited' }, { status: 403 }) });
  await assert.rejects(denied.getRelease('owner/repo', 'tag'), error => error instanceof GitHubError && error.status === 403);
});

test('annotated and lightweight source tags resolve to immutable commits', async () => {
  const sha = 'a'.repeat(40);
  const tag = 'b'.repeat(40);
  const api = new GitHub(undefined, { fetcher: async url => Response.json(url.pathname.includes('/git/ref/') ? { object: { type: 'tag', sha: tag } } : { object: { type: 'commit', sha } }) });
  assert.equal(await api.resolveTag('owner/repo', 'dsh-v1.0.0-alpha.1'), sha);
});

test('unexpected release upload destinations are rejected before opening a file', async () => {
  const api = new GitHub('test-token');
  await assert.rejects(api.upload('owner/repo', { id: 1, upload_url: 'https://example.com/steal' }, 'not-a-file', 'build.json'), /上传地址不匹配/);
});
