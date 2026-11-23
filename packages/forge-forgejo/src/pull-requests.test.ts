import { describe, expect, test } from 'bun:test';
import { contentDigest } from '@archon/forge/operations';
import { handleForgejoOperation } from './operations';
import type { Fetch } from './api';

const repo = { host: 'codeberg.org', path: 'alice/project' };
const ref = { repo, number: 12 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function samplePull(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    html_url: 'https://codeberg.org/alice/project/pulls/12',
    title: 'Add feature',
    body: 'Description',
    state: 'open',
    draft: false,
    merged: false,
    merge_commit_sha: null,
    allow_maintainer_edit: true,
    user: { id: 7, login: 'alice' },
    created_at: '2026-11-20T10:00:00Z',
    merged_at: null,
    closed_at: null,
    head: { ref: 'feat/x', sha: 'aaa111', repo: { full_name: 'alice/project' } },
    base: { ref: 'main', sha: 'bbb222' },
    mergeable: true,
    ...overrides,
  };
}

describe('pull requests', () => {
  test('pr.view reads by number and normalizes author and timestamps', async () => {
    let seenAuth = '';
    const fetchImpl: Fetch = async (input, init) => {
      seenAuth = new Headers(init?.headers).get('authorization') ?? '';
      expect(String(input)).toBe('https://codeberg.org/api/v1/repos/alice/project/pulls/12');
      return json(samplePull());
    };
    const response = await handleForgejoOperation(
      { operationId: 'pv-1', op: 'pr.view', selector: { kind: 'number', ref } },
      { token: 'secret-tok', fetch: fetchImpl }
    );
    expect(seenAuth).toBe('token secret-tok');
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.view',
        value: {
          title: 'Add feature',
          body: 'Description',
          author: { host: 'codeberg.org', id: '7', login: 'alice', type: null },
          pr: {
            number: 12,
            head: 'feat/x',
            base: 'main',
            is_draft: false,
            state: 'open',
            head_revision: 'aaa111',
            base_revision: 'bbb222',
            maintainer_can_modify: true,
          },
          timestamps: {
            created_at: '2026-11-20T10:00:00Z',
            merged_at: null,
            closed_at: null,
          },
        },
      },
    });
  });

  test('pr.view by head supports open, any state, and conflict on duplicate open PRs', async () => {
    const older = samplePull({
      number: 10,
      state: 'closed',
      merged: true,
      merged_at: '2026-11-19T10:00:00Z',
      closed_at: '2026-11-19T10:00:00Z',
      created_at: '2026-11-18T10:00:00Z',
    });
    const newer = samplePull({
      number: 12,
      state: 'closed',
      closed_at: '2026-11-21T10:00:00Z',
      created_at: '2026-11-20T10:00:00Z',
    });

    const fetchAny: Fetch = async input => {
      const url = String(input);
      if (url.includes('/pulls?state=all')) return json([older, newer]);
      if (url.endsWith('/pulls/12')) return json(newer);
      return json({}, 404);
    };
    const anyRes = await handleForgejoOperation(
      {
        operationId: 'pv-any',
        op: 'pr.view',
        selector: { kind: 'head', repo, headRepo: repo, head: 'feat/x', state: 'any' },
      },
      { token: 'tok', fetch: fetchAny }
    );
    expect(anyRes).toMatchObject({
      ok: true,
      result: { op: 'pr.view', value: { pr: { number: 12, state: 'closed' } } },
    });

    const fetchDup: Fetch = async () =>
      json([samplePull({ number: 12 }), samplePull({ number: 13 })]);
    const conflict = await handleForgejoOperation(
      {
        operationId: 'pv-dup',
        op: 'pr.view',
        selector: { kind: 'head', repo, headRepo: repo, head: 'feat/x' },
      },
      { token: 'tok', fetch: fetchDup }
    );
    expect(conflict).toMatchObject({ ok: false, error: { kind: 'conflict' } });
  });

  test('pr.view by head filters by branch name and verifies the fork repository', async () => {
    const fork = { host: 'codeberg.org', path: 'bob/project' };
    const pull = samplePull({
      head: { ref: 'feat/x', sha: 'aaa111', repo: { full_name: 'bob/project' } },
    });
    let listed = '';
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.includes('/pulls?state=open')) {
        listed = url;
        return json([pull]);
      }
      if (url.endsWith('/pulls/12')) return json(pull);
      if (url.endsWith('/repos/bob/project')) return json({ full_name: 'bob/project' });
      return json({}, 404);
    };

    const response = await handleForgejoOperation(
      {
        operationId: 'pv-fork',
        op: 'pr.view',
        selector: { kind: 'head', repo, headRepo: fork, head: 'feat/x', base: 'main' },
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.view',
        value: { pr: { number: 12, head_repo: fork, head: 'feat/x' } },
      },
    });
    expect(listed).toContain('head=feat%2Fx');
    expect(listed).not.toContain('bob%3A');
  });

  test('pr.create uses WIP prefix for draft PRs and verifies read-back', async () => {
    let postedBody: Record<string, unknown> | undefined;
    const created = samplePull({ title: 'WIP: New PR', draft: true, body: 'Body text' });
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/pulls')) {
        postedBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return json(created, 201);
      }
      if (url.endsWith('/pulls/12')) return json(created);
      return json({}, 404);
    };
    const response = await handleForgejoOperation(
      {
        operationId: 'pc-1',
        op: 'pr.create',
        repo,
        headRepo: repo,
        head: 'feat/x',
        headRevision: 'aaa111',
        base: 'main',
        title: 'New PR',
        body: 'Body text',
        draft: true,
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(postedBody).toEqual({
      head: 'feat/x',
      base: 'main',
      title: 'WIP: New PR',
      body: 'Body text',
    });
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.create',
        value: { outcome: 'applied', changed: true, pr: { number: 12, is_draft: true } },
      },
    });
  });

  test('pr.edit-body skips write when unchanged and verifies write when changed', async () => {
    let body = 'Old body';
    let patches = 0;
    const fetchImpl: Fetch = async (_input, init) => {
      if (init?.method === 'PATCH') {
        patches++;
        body = (JSON.parse(String(init.body)) as { body: string }).body;
        return json(samplePull({ body }), 201);
      }
      return json(samplePull({ body }));
    };
    const noop = await handleForgejoOperation(
      { operationId: 'eb-1', op: 'pr.edit-body', ref, body: 'Old body' },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(patches).toBe(0);
    expect(noop).toMatchObject({
      ok: true,
      result: {
        op: 'pr.edit-body',
        value: { changed: false, bodyDigest: contentDigest('Old body') },
      },
    });

    const updated = await handleForgejoOperation(
      { operationId: 'eb-2', op: 'pr.edit-body', ref, body: 'New body' },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(patches).toBe(1);
    expect(updated).toMatchObject({
      ok: true,
      result: {
        op: 'pr.edit-body',
        value: { changed: true, bodyDigest: contentDigest('New body') },
      },
    });
  });

  test('pr.draft and pr.ready toggle WIP prefix and refuse closed PRs', async () => {
    let current = samplePull({ title: 'My change', draft: false });
    const fetchImpl: Fetch = async (_input, init) => {
      if (init?.method === 'PATCH') {
        const nextTitle = (JSON.parse(String(init.body)) as { title: string }).title;
        current = samplePull({ title: nextTitle, draft: /^wip:/i.test(nextTitle) });
        return json(current, 201);
      }
      return json(current);
    };

    const drafted = await handleForgejoOperation(
      { operationId: 'dr-1', op: 'pr.draft', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(drafted).toMatchObject({
      ok: true,
      result: { op: 'pr.draft', value: { changed: true, pr: { is_draft: true } } },
    });

    const readied = await handleForgejoOperation(
      { operationId: 'rd-1', op: 'pr.ready', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(readied).toMatchObject({
      ok: true,
      result: { op: 'pr.ready', value: { changed: true, pr: { is_draft: false } } },
    });

    current = samplePull({ state: 'closed', closed_at: '2026-11-21T00:00:00Z' });
    const refused = await handleForgejoOperation(
      { operationId: 'dr-closed', op: 'pr.draft', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(refused).toMatchObject({
      ok: false,
      error: { kind: 'conflict' },
      mutation: { op: 'pr.draft', outcome: 'refused' },
    });
  });

  test('pr.merge atomically sends head_commit_id and reads landed commit metadata', async () => {
    let merged = false;
    let mergePayload: Record<string, unknown> | undefined;
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/pulls/12/merge')) {
        mergePayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        merged = true;
        return new Response(null, { status: 200 });
      }
      if (url.endsWith('/pulls/12')) {
        return json(
          merged
            ? samplePull({
                state: 'closed',
                merged: true,
                merged_at: '2026-11-22T00:00:00Z',
                closed_at: '2026-11-22T00:00:00Z',
                merge_commit_sha: 'ccc333',
              })
            : samplePull()
        );
      }
      if (url.includes('/git/commits/ccc333')) {
        return json({
          sha: 'ccc333',
          commit: { tree: { sha: 'ttt999' } },
          parents: [{ sha: 'bbb222' }],
        });
      }
      return json({}, 404);
    };

    const response = await handleForgejoOperation(
      { operationId: 'm-1', op: 'pr.merge', ref, method: 'squash', conditions: { head: 'aaa111' } },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(mergePayload).toEqual({ Do: 'squash', head_commit_id: 'aaa111' });
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.merge',
        value: {
          outcome: 'applied',
          changed: true,
          method: 'squash',
          enforcedConditions: ['head'],
          landed: { commit: 'ccc333', tree: 'ttt999', parents: ['bbb222'] },
        },
      },
    });
  });

  test('pr.merge-state compares head against base branch and reports behind count', async () => {
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.endsWith('/pulls/12')) return json(samplePull({ mergeable: false }));
      if (url.endsWith('/branches/main')) return json({ name: 'main', commit: { id: 'bbb999' } });
      if (url.includes('/compare/aaa111...bbb999')) return json({ total_commits: 4 });
      return json({}, 404);
    };
    const response = await handleForgejoOperation(
      { operationId: 'ms-1', op: 'pr.merge-state', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.merge-state',
        value: {
          ref,
          head_revision: 'aaa111',
          base_branch: 'main',
          base_revision: 'bbb999',
          behind: 4,
          mergeable: 'conflict',
          merge_commit: null,
        },
      },
    });
  });
});
