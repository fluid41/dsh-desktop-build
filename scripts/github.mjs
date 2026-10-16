import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

export class GitHubError extends Error {
  constructor(status, method, path, detail) {
    super(`GitHub ${method} ${path}: HTTP ${status}${detail ? ` (${detail})` : ''}`);
    this.status = status;
  }
}

/** A narrowly scoped client. Credentials are sent only to GitHub API/upload hosts. */
export class GitHub {
  constructor(token, { fetcher = fetch } = {}) { this.token = token; this.fetcher = fetcher; }

  async request(path, { method = 'GET', body, contentType, length } = {}) {
    const url = new URL(path, 'https://api.github.com');
    if (!['api.github.com', 'uploads.github.com'].includes(url.hostname) || url.protocol !== 'https:') throw new Error('Untrusted GitHub API destination');
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'dsh-desktop-build' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['Content-Type'] = contentType ?? 'application/json';
    if (length !== undefined) headers['Content-Length'] = String(length);
    const stream = body && typeof body.pipe === 'function';
    const payload = body === undefined ? undefined : contentType ? body : JSON.stringify(body);
    const response = await this.fetcher(url, { method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(stream ? 20 * 60_000 : 90_000), ...(stream ? { duplex: 'half' } : {}) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new GitHubError(response.status, method, url.pathname, typeof data.message === 'string' ? data.message : '');
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  async listReleases(repo) {
    const releases = [];
    for (let page = 1; page <= 50; page++) {
      const batch = await this.request(`/repos/${repo}/releases?per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error('GitHub returned an invalid release list');
      releases.push(...batch);
      if (batch.length < 100) return releases;
    }
    throw new Error('Release history exceeds the discovery pagination limit');
  }

  async getRelease(repo, tag) {
    try { return await this.request(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`); }
    catch (error) { if (error instanceof GitHubError && error.status === 404) return undefined; throw error; }
  }

  async resolveTag(repo, tag) {
    let ref = (await this.request(`/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
    for (let depth = 0; depth < 8; depth++) {
      if (!/^[0-9a-f]{40}$/.test(ref?.sha ?? '')) throw new Error('GitHub returned an invalid tag object');
      if (ref.type === 'commit') return ref.sha;
      if (ref.type !== 'tag') throw new Error('Product tag does not resolve to a commit');
      ref = (await this.request(`/repos/${repo}/git/tags/${ref.sha}`)).object;
    }
    throw new Error('Product tag has too many annotated-tag indirections');
  }

  async manifest(repo, path, sha) {
    const file = await this.request(`/repos/${repo}/contents/${path}?ref=${sha}`);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') throw new Error(`Missing source manifest ${path}`);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }

  async upload(repo, release, filePath, name) {
    const url = new URL(release.upload_url.split('{')[0]);
    if (url.hostname !== 'uploads.github.com' || url.pathname !== `/repos/${repo}/releases/${release.id}/assets`) throw new Error('Unexpected release upload destination');
    url.searchParams.set('name', name);
    const size = (await stat(filePath)).size;
    return this.request(url.href, { method: 'POST', body: createReadStream(filePath), contentType: 'application/octet-stream', length: size });
  }
}
