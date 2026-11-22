import { describe, expect, test } from 'bun:test';
import { forgejoPluginMetadata, handleForgejoOperation } from './operations';
import type { Fetch } from './api';

const repo = { host: 'codeberg.org', path: 'alice/project' };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('resolve', () => {
  test.each([
    ['git@codeberg.org:alice/project.git', 'codeberg.org', 'alice/project'],
    ['git@gitea.com:org/repo.git', 'gitea.com', 'org/repo'],
    ['ssh://git@codeberg.org/alice/project.git', 'codeberg.org', 'alice/project'],
    ['https://codeberg.org/alice/project.git', 'codeberg.org', 'alice/project'],
    ['https://gitea.com/org/repo', 'gitea.com', 'org/repo'],
    ['http://forge.example.org:8080/team/app.git', 'forge.example.org:8080', 'team/app'],
  ])('resolves git remote %s', async (remote, host, path) => {
    const response = await handleForgejoOperation(
      { operationId: 'res-1', op: 'resolve', remote },
      { token: undefined }
    );
    expect(response).toEqual({
      operationId: 'res-1',
      ok: true,
      result: {
        op: 'resolve',
        value: {
          kind: 'resolved',
          forge: 'forgejo',
          repo: { host, path },
          plugin: forgejoPluginMetadata,
        },
      },
    });
  });

  test('resolves issue and pull request web URLs with resolve:subject', async () => {
    const issue = await handleForgejoOperation(
      {
        operationId: 'web-1',
        op: 'resolve',
        remote: 'https://codeberg.org/alice/project/issues/42#issuecomment-7',
        web: true,
      },
      { token: undefined }
    );
    expect(issue).toMatchObject({
      ok: true,
      result: {
        op: 'resolve',
        value: {
          kind: 'resolved',
          forge: 'forgejo',
          repo: { host: 'codeberg.org', path: 'alice/project' },
          subject: { kind: 'issue', number: 42 },
        },
      },
    });

    const pr = await handleForgejoOperation(
      {
        operationId: 'web-2',
        op: 'resolve',
        remote: 'https://gitea.com/alice/project/pulls/99?tab=files',
        web: true,
      },
      { token: undefined }
    );
    expect(pr).toMatchObject({
      ok: true,
      result: {
        op: 'resolve',
        value: {
          kind: 'resolved',
          forge: 'forgejo',
          repo: { host: 'gitea.com', path: 'alice/project' },
          subject: { kind: 'pr', number: 99 },
        },
      },
    });

    const repoOnly = await handleForgejoOperation(
      {
        operationId: 'web-3',
        op: 'resolve',
        remote: 'https://codeberg.org/alice/project',
        web: true,
      },
      { token: undefined }
    );
    expect(repoOnly).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });
  });

  test('returns none for null or non-repository remotes and refuses credentials or query', async () => {
    const none = await handleForgejoOperation(
      { operationId: 'res-null', op: 'resolve', remote: null },
      { token: undefined }
    );
    expect(none).toMatchObject({
      ok: true,
      result: { op: 'resolve', value: { kind: 'none', forge: 'none' } },
    });

    const withCreds = await handleForgejoOperation(
      { operationId: 'res-cred', op: 'resolve', remote: 'https://user:pass@codeberg.org/a/b.git' },
      { token: undefined }
    );
    expect(withCreds).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });

    const withQuery = await handleForgejoOperation(
      { operationId: 'res-query', op: 'resolve', remote: 'https://codeberg.org/a/b?foo=bar' },
      { token: undefined }
    );
    expect(withQuery).toMatchObject({ ok: false, error: { kind: 'invalid_request' } });
  });
});

describe('credentials and error classification', () => {
  test('refuses missing token on reads and mutations without calling fetch', async () => {
    let called = false;
    const fetchImpl: Fetch = async () => {
      called = true;
      return jsonResponse({});
    };
    const read = await handleForgejoOperation(
      { operationId: 'no-tok-read', op: 'repo.labels.list', repo },
      { token: undefined, fetch: fetchImpl }
    );
    expect(read).toMatchObject({ ok: false, error: { kind: 'no_credential' } });

    const write = await handleForgejoOperation(
      { operationId: 'no-tok-write', op: 'pr.ready', ref: { repo, number: 5 } },
      { token: undefined, fetch: fetchImpl }
    );
    expect(write).toMatchObject({
      ok: false,
      error: { kind: 'no_credential' },
      mutation: { op: 'pr.ready', outcome: 'refused' },
    });
    expect(called).toBe(false);
  });

  test.each([
    [429, {}, 'rate_limited'],
    [403, { 'retry-after': '60' }, 'rate_limited'],
    [403, { 'x-ratelimit-remaining': '0' }, 'rate_limited'],
    [403, { ratelimit: '"baseline";r=0;t=60' }, 'rate_limited'],
    [403, {}, 'authorization'],
    [401, {}, 'authorization'],
    [404, {}, 'not_found'],
    [405, {}, 'conflict'],
    [409, {}, 'conflict'],
    [422, {}, 'conflict'],
    [502, {}, 'unavailable'],
  ] as const)('maps HTTP %i with headers %j to %s', async (status, headers, expectedKind) => {
    const fetchImpl: Fetch = async () => jsonResponse({ message: 'err' }, status, headers);
    const response = await handleForgejoOperation(
      { operationId: 'err-map', op: 'repo.labels.list', repo },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({ ok: false, error: { kind: expectedKind, status } });
  });

  test('maps network errors to unavailable', async () => {
    const fetchImpl: Fetch = async () => {
      throw new TypeError('connection reset');
    };
    const response = await handleForgejoOperation(
      { operationId: 'net-err', op: 'repo.labels.list', repo },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({ ok: false, error: { kind: 'unavailable' } });
  });

  test('refuses unsupported mutations with unsupported_op and refused outcome', async () => {
    const response = await handleForgejoOperation(
      {
        operationId: 'unsup-1',
        op: 'workitem.close',
        ref: { repo, number: 1 },
        reason: 'completed',
      },
      { token: 'tok' }
    );
    expect(response).toMatchObject({
      ok: false,
      error: { kind: 'unsupported_op' },
      mutation: { op: 'workitem.close', outcome: 'refused' },
    });
  });
});
