import { describe, expect, test } from 'bun:test';
import { contentDigest } from '@archon/forge/operations';
import { handleForgejoOperation } from './operations';
import type { Fetch } from './api';

const repo = { host: 'codeberg.org', path: 'alice/project' };
const ref = { repo, number: 31 };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function sampleIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 31,
    html_url: 'https://codeberg.org/alice/project/issues/31',
    title: 'Bug report',
    body: 'Details here',
    state: 'open',
    labels: [{ id: 1, name: 'bug' }],
    pull_request: null,
    repository: { full_name: 'alice/project' },
    user: { id: 9, login: 'bob' },
    updated_at: '2026-11-22T09:00:00Z',
    ...overrides,
  };
}

describe('work items, labels, search, and comments', () => {
  test('workitem.view distinguishes issues from PRs using pull_request !== null', async () => {
    const fetchImpl: Fetch = async () => json(sampleIssue());
    const response = await handleForgejoOperation(
      { operationId: 'wv-1', op: 'workitem.view', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.view',
        value: {
          kind: 'issue',
          title: 'Bug report',
          labels: ['bug'],
          author: { host: 'codeberg.org', id: '9', login: 'bob', type: null },
        },
      },
    });
  });

  test('workitem.create creates once and recovers an existing marked issue idempotently', async () => {
    const marker = '<!-- archon-discovery abc -->';
    const body = `${marker}\nFound a defect`;
    const issues: ReturnType<typeof sampleIssue>[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/issues')) {
        const created = sampleIssue({ number: 40, title: 'Defect', body });
        issues.push(created);
        return json(created, 201);
      }
      if (url.includes('/issues/40')) return json(issues[0]);
      if (url.includes('/issues?')) return json(issues);
      return json({}, 404);
    };

    const first = await handleForgejoOperation(
      { operationId: 'wc-1', op: 'workitem.create', repo, title: 'Defect', body, marker },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(first).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.create',
        value: { changed: true, workitem: { ref: { repo, number: 40 }, kind: 'issue' } },
      },
    });

    const second = await handleForgejoOperation(
      { operationId: 'wc-2', op: 'workitem.create', repo, title: 'Defect', body, marker },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(second).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.create',
        value: { changed: false, workitem: { ref: { repo, number: 40 }, kind: 'issue' } },
      },
    });
  });

  test('workitem.edit-body edits an issue and refuses a pull request', async () => {
    let body = 'Before';
    const fetchImpl: Fetch = async (_input, init) => {
      if (init?.method === 'PATCH') {
        body = (JSON.parse(String(init.body)) as { body: string }).body;
        return json(sampleIssue({ body }), 201);
      }
      return json(sampleIssue({ body }));
    };
    const edited = await handleForgejoOperation(
      { operationId: 'web-1', op: 'workitem.edit-body', ref, body: 'After' },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(edited).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.edit-body',
        value: { changed: true, bodyDigest: contentDigest('After') },
      },
    });

    const onPr = await handleForgejoOperation(
      { operationId: 'web-pr', op: 'workitem.edit-body', ref, body: 'After' },
      { token: 'tok', fetch: async () => json(sampleIssue({ pull_request: { merged: false } })) }
    );
    expect(onPr).toMatchObject({
      ok: false,
      error: { kind: 'invalid_request' },
      mutation: { op: 'workitem.edit-body', outcome: 'refused' },
    });
  });

  test('repo.label.ensure, workitem.labels.set, add, and remove resolve exact label IDs', async () => {
    const repoLabels = [
      { id: 1, name: 'bug', color: 'd73a4a', description: 'Something is broken' },
    ];
    let issueLabels = [{ id: 1, name: 'bug' }];
    const handleIssueLabelWrite = (method: string | undefined, url: string, rawBody?: string) => {
      if (method === 'POST') {
        const ids = (JSON.parse(rawBody ?? '{}') as { labels: number[] }).labels;
        for (const id of ids) {
          const found = repoLabels.find(label => label.id === id);
          if (found && !issueLabels.some(label => label.id === id)) {
            issueLabels.push({ id: found.id, name: found.name });
          }
        }
        return json(issueLabels);
      }
      if (method === 'PUT') {
        const ids = (JSON.parse(rawBody ?? '{}') as { labels: number[] }).labels;
        issueLabels = repoLabels
          .filter(label => ids.includes(label.id))
          .map(label => ({ id: label.id, name: label.name }));
        return json(issueLabels);
      }
      if (method === 'DELETE' && url.endsWith('/issues/31/labels/1')) {
        issueLabels = issueLabels.filter(label => label.id !== 1);
        return new Response(null, { status: 204 });
      }
      return json({}, 404);
    };
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('/issues/31/labels')) {
        return handleIssueLabelWrite(init?.method, url, init?.body ? String(init.body) : undefined);
      }
      if (init?.method === 'POST' && url.endsWith('/labels')) {
        const body = JSON.parse(String(init.body)) as {
          name: string;
          color: string;
          description: string;
        };
        const created = {
          id: 2,
          name: body.name,
          color: body.color.replace(/^#/, ''),
          description: body.description,
        };
        repoLabels.push(created);
        return json(created, 201);
      }
      if (url.endsWith('/labels/2')) return json(repoLabels[1]);
      if (url.includes('/repos/alice/project/labels?')) return json(repoLabels);
      if (url.endsWith('/issues/31')) return json(sampleIssue({ labels: issueLabels }));
      return json({}, 404);
    };

    const ensured = await handleForgejoOperation(
      {
        operationId: 'lbl-ensure',
        op: 'repo.label.ensure',
        repo,
        name: 'queued',
        color: '00aaFF',
        description: 'Ready',
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(ensured).toMatchObject({
      ok: true,
      result: {
        op: 'repo.label.ensure',
        value: { changed: true, label: { name: 'queued', color: '00aaff' } },
      },
    });

    const added = await handleForgejoOperation(
      {
        operationId: 'lbl-add',
        op: 'workitem.label.add',
        subject: { kind: 'issue', ref },
        name: 'queued',
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(added).toMatchObject({
      ok: true,
      result: { op: 'workitem.label.add', value: { changed: true, labels: ['bug', 'queued'] } },
    });

    const removed = await handleForgejoOperation(
      {
        operationId: 'lbl-rm',
        op: 'workitem.label.remove',
        subject: { kind: 'issue', ref },
        name: 'bug',
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(removed).toMatchObject({
      ok: true,
      result: { op: 'workitem.label.remove', value: { changed: true, labels: ['queued'] } },
    });

    const setRes = await handleForgejoOperation(
      { operationId: 'lbl-set', op: 'workitem.labels.set', ref, labels: ['bug'] },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(setRes).toMatchObject({
      ok: true,
      result: { op: 'workitem.labels.set', value: { changed: true, labels: ['bug'] } },
    });
  });

  test('workitem.list filters exact label case and workitem.search reports truncated from x-total-count', async () => {
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.includes('labels=Queued')) {
        return json([
          sampleIssue({ number: 1, labels: [{ id: 1, name: 'Queued' }] }),
          sampleIssue({ number: 2, labels: [{ id: 2, name: 'queued' }] }),
        ]);
      }
      if (url.includes('q=backoff')) {
        return json(
          [sampleIssue({ number: 5, title: 'Retry backoff', updated_at: '2026-11-22T10:00:00Z' })],
          200,
          { 'x-total-count': '3' }
        );
      }
      return json([]);
    };

    const listed = await handleForgejoOperation(
      { operationId: 'wl-1', op: 'workitem.list', repo, label: 'Queued' },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(listed).toMatchObject({
      ok: true,
      result: { op: 'workitem.list', value: { items: [{ ref: { repo, number: 1 } }] } },
    });

    const searched = await handleForgejoOperation(
      { operationId: 'ws-1', op: 'workitem.search', repo, text: 'backoff', limit: 1 },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(searched).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.search',
        value: {
          truncated: true,
          items: [{ ref: { repo, number: 5 }, title: 'Retry backoff' }],
        },
      },
    });
  });

  test('workitem.comment.upsert creates, updates in place, and workitem.comments reads back', async () => {
    const marker = '<!-- archon-report -->';
    const comments: {
      id: number;
      html_url: string;
      issue_url: string;
      body: string;
      user: { id: number; login: string };
    }[] = [];
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/issues/31')) return json(sampleIssue());
      if (init?.method === 'POST' && url.endsWith('/issues/31/comments')) {
        const body = (JSON.parse(String(init.body)) as { body: string }).body;
        const created = {
          id: 501,
          html_url: 'https://codeberg.org/alice/project/issues/31#issuecomment-501',
          issue_url: 'https://codeberg.org/alice/project/issues/31',
          body,
          user: { id: 9, login: 'bob' },
        };
        comments.push(created);
        return json(created, 201);
      }
      if (init?.method === 'PATCH' && url.endsWith('/issues/comments/501')) {
        comments[0].body = (JSON.parse(String(init.body)) as { body: string }).body;
        return json(comments[0]);
      }
      if (url.endsWith('/issues/comments/501')) return json(comments[0]);
      if (url.includes('/issues/31/comments')) return json(comments);
      return json({}, 404);
    };

    const created = await handleForgejoOperation(
      {
        operationId: 'cm-1',
        op: 'workitem.comment.upsert',
        subject: { kind: 'issue', ref },
        marker,
        body: `${marker}\nv1`,
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(created).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.comment.upsert',
        value: {
          changed: true,
          comment: { id: '501', bodyDigest: contentDigest(`${marker}\nv1`) },
        },
      },
    });

    const updated = await handleForgejoOperation(
      {
        operationId: 'cm-2',
        op: 'comment.upsert',
        ref,
        marker,
        body: `${marker}\nv2`,
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(updated).toMatchObject({
      ok: true,
      result: {
        op: 'comment.upsert',
        value: {
          changed: true,
          comment: { id: '501', bodyDigest: contentDigest(`${marker}\nv2`) },
        },
      },
    });

    const read = await handleForgejoOperation(
      { operationId: 'cm-3', op: 'workitem.comments', subject: { kind: 'issue', ref } },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(read).toMatchObject({
      ok: true,
      result: {
        op: 'workitem.comments',
        value: { comments: [{ id: '501', body: `${marker}\nv2` }] },
      },
    });
  });

  test('workitem.comments reads the whole thread in one request', async () => {
    const comments = Array.from({ length: 60 }, (_, index) => ({
      id: 1_000 + index,
      html_url: `https://codeberg.org/alice/project/issues/31#issuecomment-${String(1_000 + index)}`,
      issue_url: 'https://codeberg.org/alice/project/issues/31',
      body: `comment ${String(index + 1)}`,
      user: { id: 9, login: 'bob' },
    }));
    const urls: string[] = [];
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/issues/31')) return json(sampleIssue());
      if (url.includes('/issues/31/comments')) return json(comments);
      return json({}, 404);
    };

    const response = await handleForgejoOperation(
      { operationId: 'cm-long', op: 'workitem.comments', subject: { kind: 'issue', ref } },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({ ok: true, result: { op: 'workitem.comments' } });
    if (!response.ok || response.result.op !== 'workitem.comments') {
      throw new Error('workitem.comments did not answer');
    }
    expect(response.result.value.comments).toHaveLength(60);
    expect(urls.filter(url => url.includes('/comments'))).toHaveLength(1);
  });
});
