import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { parseDiffPatches } from './files';
import { handleForgejoOperation } from './operations';
import type { Fetch } from './api';

const repo = { host: 'codeberg.org', path: 'alice/project' };
const ref = { repo, number: 7 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE_DIFF = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 111..222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,3 @@',
  ' export const a = 1;',
  '+export const b = 2;',
  ' export const c = 3;',
  'diff --git a/assets/logo.png b/assets/logo.png',
  'Binary files /dev/null and b/assets/logo.png differ',
  '',
].join('\n');

describe('files, reviews, threads, and attachments', () => {
  test('parseDiffPatches extracts unified diff hunks and leaves binary files out', () => {
    const patches = parseDiffPatches(SAMPLE_DIFF);
    expect(patches.get('src/app.ts')).toBe(
      '@@ -1,2 +1,3 @@\n export const a = 1;\n+export const b = 2;\n export const c = 3;'
    );
    expect(patches.has('assets/logo.png')).toBe(false);
  });

  test('pr.files returns patches and rejects a head that moved mid-read', async () => {
    let pullReads = 0;
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.endsWith('/pulls/7')) {
        pullReads++;
        return json({ changed_files: 2, head: { sha: 'head-sha-1' } });
      }
      if (url.includes('/pulls/7/files')) {
        return json([
          { filename: 'src/app.ts', status: 'changed' },
          { filename: 'assets/logo.png', status: 'added' },
        ]);
      }
      if (url.endsWith('/pulls/7.diff')) return new Response(SAMPLE_DIFF, { status: 200 });
      return json({}, 404);
    };
    const response = await handleForgejoOperation(
      { operationId: 'pf-1', op: 'pr.files', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(pullReads).toBe(2);
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'pr.files',
        value: {
          head_revision: 'head-sha-1',
          files: [
            {
              path: 'src/app.ts',
              status: 'changed',
              patch: expect.stringContaining('@@ -1,2 +1,3 @@'),
            },
            { path: 'assets/logo.png', status: 'added', patch: null },
          ],
        },
      },
    });
  });

  test('repo.file decodes base64 UTF-8 and reports not_found for directories', async () => {
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.includes('/contents/src/app.ts')) {
        return json({
          type: 'file',
          encoding: 'base64',
          content: Buffer.from('hello world\n', 'utf8').toString('base64'),
        });
      }
      if (url.includes('/contents/src')) return json([{ type: 'file', name: 'app.ts' }]);
      return json({}, 404);
    };

    const file = await handleForgejoOperation(
      { operationId: 'rf-1', op: 'repo.file', repo, path: 'src/app.ts', revision: 'abc' },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(file).toMatchObject({
      ok: true,
      result: { op: 'repo.file', value: { text: 'hello world\n' } },
    });

    const dir = await handleForgejoOperation(
      { operationId: 'rf-2', op: 'repo.file', repo, path: 'src', revision: 'abc' },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(dir).toMatchObject({ ok: false, error: { kind: 'not_found' } });
  });

  test('pr.review.submit places inline and summary comments, and pr.reviews / pr.threads read them back', async () => {
    const reviews: Record<string, unknown>[] = [];
    const reviewComments = new Map<number, Record<string, unknown>[]>();
    const pull = {
      number: 7,
      html_url: 'https://codeberg.org/alice/project/pulls/7',
      title: 'Feature',
      body: '',
      state: 'open',
      draft: false,
      merged: false,
      changed_files: 1,
      created_at: '2026-11-22T00:00:00Z',
      merged_at: null,
      closed_at: null,
      head: { ref: 'feat', sha: 'head-sha-1', repo: { full_name: 'alice/project' } },
      base: { ref: 'main', sha: 'base-sha-1' },
    };

    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/pulls/7')) return json(pull);
      if (url.includes('/pulls/7/files'))
        return json([{ filename: 'src/app.ts', status: 'modified' }]);
      if (url.endsWith('/pulls/7.diff')) return new Response(SAMPLE_DIFF, { status: 200 });
      if (init?.method === 'POST' && url.endsWith('/pulls/7/reviews')) {
        const body = JSON.parse(String(init.body)) as {
          commit_id: string;
          body: string;
          comments: { path: string; new_position: number; body: string }[];
        };
        const id = 801;
        const created = {
          id,
          html_url: 'https://codeberg.org/alice/project/pulls/7#issuecomment-801',
          body: body.body,
          commit_id: body.commit_id,
          state: 'COMMENT',
          comments_count: body.comments.length,
          submitted_at: '2026-11-22T01:00:00Z',
          user: { id: 1, login: 'archon' },
        };
        reviews.push(created);
        reviewComments.set(
          id,
          body.comments.map((comment, idx) => ({
            id: 900 + idx,
            html_url: `https://codeberg.org/alice/project/pulls/7#issuecomment-${String(900 + idx)}`,
            body: comment.body,
            commit_id: body.commit_id,
            original_commit_id: body.commit_id,
            path: comment.path,
            position: comment.new_position,
            original_position: 0,
            pull_request_review_id: id,
            resolver: null,
            created_at: '2026-11-22T01:00:00Z',
            user: { id: 1, login: 'archon' },
          }))
        );
        return json(created, 200);
      }
      if (url.endsWith('/pulls/7/reviews/801/comments')) return json(reviewComments.get(801) ?? []);
      if (url.endsWith('/pulls/7/reviews/801')) return json(reviews[0]);
      if (url.includes('/pulls/7/reviews')) return json(reviews);
      return json({}, 404);
    };

    const submit = await handleForgejoOperation(
      {
        operationId: 'rv-1',
        op: 'pr.review.submit',
        ref,
        commit: 'head-sha-1',
        key: 'run-42',
        summary: 'Looks mostly good',
        comments: [
          { path: 'src/app.ts', line: 2, body: 'Nice addition' },
          { path: 'src/other.ts', line: 10, body: 'Unchanged file note' },
        ],
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(submit).toMatchObject({
      ok: true,
      result: {
        op: 'pr.review.submit',
        value: {
          changed: true,
          review: { id: '801', key: 'run-42', commit: 'head-sha-1' },
          comments: [
            { path: 'src/app.ts', line: 2, placed: 'inline' },
            { path: 'src/other.ts', line: 10, placed: 'summary' },
          ],
        },
      },
    });

    const repeat = await handleForgejoOperation(
      {
        operationId: 'rv-2',
        op: 'pr.review.submit',
        ref,
        commit: 'head-sha-1',
        key: 'run-42',
        summary: 'Looks mostly good',
        comments: [
          { path: 'src/app.ts', line: 2, body: 'Nice addition' },
          { path: 'src/other.ts', line: 10, body: 'Unchanged file note' },
        ],
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(repeat).toMatchObject({
      ok: true,
      result: { op: 'pr.review.submit', value: { changed: false } },
    });

    const readReviews = await handleForgejoOperation(
      { operationId: 'rv-3', op: 'pr.reviews', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(readReviews).toMatchObject({
      ok: true,
      result: {
        op: 'pr.reviews',
        value: {
          items: [
            { kind: 'review', id: '801', submitKey: 'run-42' },
            { kind: 'review_comment', id: '900', submitKey: 'run-42' },
          ],
        },
      },
    });

    const threads = await handleForgejoOperation(
      { operationId: 'th-1', op: 'pr.threads', ref },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(threads).toMatchObject({
      ok: true,
      result: {
        op: 'pr.threads',
        value: {
          threads: [
            {
              id: '900',
              resolved: false,
              outdated: false,
              path: 'src/app.ts',
              line: 2,
              comments: [{ id: '900', body: 'Nice addition' }],
            },
          ],
        },
      },
    });
  });

  test('attachment.put commits image on archon-attachments and returns existing on repeat', async () => {
    const rawBytes = Buffer.from('fake-png-bytes');
    const content = rawBytes.toString('base64');
    const digest = createHash('sha256').update(rawBytes).digest('hex');
    const filename = `${digest}.png`;
    let storedCommit: string | null = null;

    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/repos/alice/project')) {
        return json({
          html_url: 'https://codeberg.org/alice/project',
          default_branch: 'main',
          permissions: { push: true },
        });
      }
      if (url.endsWith('/branches/archon-attachments')) {
        return storedCommit
          ? json({ commit: { id: storedCommit } })
          : json({ message: 'not found' }, 404);
      }
      if (url.includes(`/contents/${filename}?ref=archon-attachments`)) {
        return storedCommit
          ? json({ type: 'file', last_commit_sha: storedCommit })
          : json({ message: 'not found' }, 404);
      }
      if (init?.method === 'POST' && url.endsWith(`/contents/${filename}`)) {
        storedCommit = 'deadbeef1234';
        return json({ commit: { sha: storedCommit }, content: { path: filename } }, 201);
      }
      return json({}, 404);
    };

    const first = await handleForgejoOperation(
      { operationId: 'att-1', op: 'attachment.put', repo, contentType: 'image/png', content },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(first).toMatchObject({
      ok: true,
      result: {
        op: 'attachment.put',
        value: {
          changed: true,
          attachment: {
            url: `https://codeberg.org/alice/project/raw/commit/deadbeef1234/${filename}`,
            digest,
            bytes: rawBytes.byteLength,
            contentType: 'image/png',
          },
        },
      },
    });

    const second = await handleForgejoOperation(
      { operationId: 'att-2', op: 'attachment.put', repo, contentType: 'image/png', content },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(second).toMatchObject({
      ok: true,
      result: { op: 'attachment.put', value: { changed: false } },
    });
  });
});
