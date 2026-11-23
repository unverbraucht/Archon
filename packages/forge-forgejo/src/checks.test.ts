import { describe, expect, test } from 'bun:test';
import { runForgeMutationConformance, runForgeReadConformance } from '@archon/forge/conformance';
import { forgejoPluginMetadata, handleForgejoOperation } from './operations';
import type { Fetch } from './api';

const repo = { host: 'codeberg.org', path: 'alice/project' };
const ref = { repo, number: 15 };
const giteaRepo = { host: 'gitea.com', path: 'org/service' };
const giteaRef = { repo: giteaRepo, number: 22 };
const headSha = '1111111111111111111111111111111111111111';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('checks and forge conformance', () => {
  test('checks.state combines Forgejo Actions jobs with external commit statuses and passes read conformance', async () => {
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.endsWith('/pulls/15')) return json({ head: { sha: headSha } });
      if (url.includes(`/commits/${headSha}/statuses`)) {
        return json([
          {
            id: 50,
            context: 'ci / test',
            status: 'failure',
            target_url: '/alice/project/actions/runs/9/jobs/0',
          },
          {
            id: 51,
            context: 'woodpecker/build',
            status: 'success',
            target_url: 'https://ci.codeberg.org/repos/1/pipeline/2',
          },
        ]);
      }
      if (url.includes(`/actions/runs?head_sha=${headSha}`)) {
        return json({
          total_count: 1,
          workflow_runs: [
            {
              id: 700,
              index_in_repo: 9,
              workflow_id: 'ci.yml',
              commit_sha: headSha,
              status: 'failure',
              need_approval: true,
            },
          ],
        });
      }
      if (url.split('?')[0]?.endsWith('/actions/runs/700/jobs')) {
        return json([{ id: 7001, run_id: 700, name: 'test', status: 'failure', attempt: 1 }]);
      }
      return json({}, 404);
    };

    const failures = await runForgeReadConformance(
      request => handleForgejoOperation(request, { token: 'tok', fetch: fetchImpl }),
      [
        {
          name: 'forgejo actions job + external commit status',
          request: { operationId: 'chk-1', op: 'checks.state', ref },
          expected: {
            revision: headSha,
            state: 'red',
            approvalPending: true,
            units: [
              { kind: 'check', id: '7001', rerun: { id: '7001', attempt: 1 } },
              { kind: 'commit_status', id: '51', rerun: null },
            ],
          },
        },
      ]
    );
    expect(failures).toEqual([]);
  });

  test('checks.state and checks.rerun support Gitea Actions payloads and rerun route', async () => {
    let runAttempt = 1;
    let rerunPath = '';
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/pulls/22')) return json({ head: { sha: headSha } });
      if (url.includes(`/commits/${headSha}/statuses`)) return json([]);
      if (url.includes(`/actions/runs?head_sha=${headSha}`)) {
        return json({
          total_count: 1,
          workflow_runs: [
            {
              id: 900,
              run_number: 12,
              path: '.gitea/workflows/test.yml',
              head_sha: headSha,
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        });
      }
      if (url.split('?')[0]?.endsWith('/actions/runs/900/jobs')) {
        return json({
          total_count: 1,
          jobs: [
            {
              id: 9001,
              run_id: 900,
              name: 'unit',
              status: 'completed',
              conclusion: 'failure',
              run_attempt: runAttempt,
            },
          ],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/actions/runs/900/jobs/9001/rerun')) {
        rerunPath = url;
        runAttempt = 2;
        return new Response(null, { status: 201 });
      }
      if (url.endsWith('/actions/jobs/9001')) {
        return json({
          id: 9001,
          run_id: 900,
          name: 'unit',
          status: 'completed',
          conclusion: 'failure',
          run_attempt: runAttempt,
        });
      }
      if (url.endsWith('/actions/runs/900')) {
        return json({ id: 900, head_sha: headSha, status: 'completed', conclusion: 'failure' });
      }
      return json({}, 404);
    };

    const readFailures = await runForgeReadConformance(
      request => handleForgejoOperation(request, { token: 'tok', fetch: fetchImpl }),
      [
        {
          name: 'gitea actions workflow job',
          request: { operationId: 'gt-chk-1', op: 'checks.state', ref: giteaRef },
          expected: {
            revision: headSha,
            state: 'red',
            approvalPending: null,
            units: [{ kind: 'check', id: '9001', rerun: { id: '9001', attempt: 1 } }],
          },
        },
      ]
    );
    expect(readFailures).toEqual([]);

    const rerunFailures = await runForgeMutationConformance(
      request =>
        handleForgejoOperation(request, { token: 'tok', fetch: fetchImpl, sleep: async () => {} }),
      forgejoPluginMetadata,
      [
        {
          name: 'gitea actions job rerun uses /actions/runs/{run}/jobs/{job}/rerun',
          request: {
            operationId: 'gt-rr-1',
            op: 'checks.rerun',
            ref: giteaRef,
            revision: headSha,
            units: [
              {
                unit: { kind: 'check', id: '9001', name: 'unit' },
                rerun: { id: '9001', attempt: 1 },
              },
            ],
          },
          expectedOutcome: 'applied',
        },
      ]
    );
    expect(rerunFailures).toEqual([]);
    expect(rerunPath).toContain('/actions/runs/900/jobs/9001/rerun');
  });

  test('checks.state reads every page of a paginated Gitea job list', async () => {
    const job = (id: number, name: string) => ({
      id,
      run_id: 900,
      name,
      status: 'completed',
      conclusion: 'success',
      run_attempt: 1,
    });
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.endsWith('/pulls/22')) return json({ head: { sha: headSha } });
      if (url.includes(`/commits/${headSha}/statuses`)) return json([]);
      if (url.includes(`/actions/runs?head_sha=${headSha}`)) {
        return json({
          total_count: 1,
          workflow_runs: [
            {
              id: 900,
              run_number: 12,
              path: '.gitea/workflows/test.yml',
              head_sha: headSha,
              status: 'completed',
              conclusion: 'success',
            },
          ],
        });
      }
      if (url.split('?')[0]?.endsWith('/actions/runs/900/jobs')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        return json(
          page === 1
            ? { total_count: 3, jobs: [job(9001, 'one'), job(9002, 'two')] }
            : { total_count: 3, jobs: [job(9003, 'three')] }
        );
      }
      return json({}, 404);
    };

    const response = await handleForgejoOperation(
      { operationId: 'gt-chk-pages', op: 'checks.state', ref: giteaRef },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({ ok: true, result: { op: 'checks.state' } });
    if (!response.ok || response.result.op !== 'checks.state') {
      throw new Error('checks.state did not answer');
    }
    expect(response.result.value.units.map(unit => unit.unit.id)).toEqual(['9001', '9002', '9003']);
  });

  test('checks.commit reads default branch head and degrades cleanly when Actions is disabled (404)', async () => {
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.endsWith('/repos/alice/project')) return json({ default_branch: 'main' });
      if (url.endsWith('/branches/main')) return json({ name: 'main', commit: { id: headSha } });
      if (url.includes(`/commits/${headSha}/statuses`)) {
        return json([{ id: 88, context: 'woodpecker/lint', status: 'success', target_url: '' }]);
      }
      if (url.includes('/actions/runs')) return json({ message: 'actions disabled' }, 404);
      return json({}, 404);
    };

    const response = await handleForgejoOperation(
      { operationId: 'cc-1', op: 'checks.commit', repo, at: { kind: 'default_branch' } },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(response).toMatchObject({
      ok: true,
      result: {
        op: 'checks.commit',
        value: {
          branch: 'main',
          revision: headSha,
          approvalPending: null,
          summary: { state: 'green', counts: { total: 1, green: 1 } },
        },
      },
    });
  });

  test('checks.logs tails job log text and reports unit_has_no_log for commit statuses', async () => {
    const fetchImpl: Fetch = async input => {
      const url = String(input);
      if (url.endsWith('/actions/jobs/7001')) {
        return json({ id: 7001, run_id: 700, name: 'test', status: 'failure', attempt: 1 });
      }
      if (url.endsWith('/actions/jobs/7001/logs')) {
        return new Response('line 1\nline 2\nFAIL here\n', { status: 200 });
      }
      return json({}, 404);
    };

    const log = await handleForgejoOperation(
      {
        operationId: 'log-1',
        op: 'checks.logs',
        repo,
        unit: { kind: 'check', id: '7001', name: 'test' },
        maxBytes: 10,
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(log).toMatchObject({
      ok: true,
      result: {
        op: 'checks.logs',
        value: {
          log: {
            kind: 'text',
            text: 'FAIL here\n',
            truncated: true,
            totalBytes: 24,
          },
        },
      },
    });

    const statusLog = await handleForgejoOperation(
      {
        operationId: 'log-2',
        op: 'checks.logs',
        repo,
        unit: { kind: 'commit_status', id: '51', name: 'woodpecker/build' },
      },
      { token: 'tok', fetch: fetchImpl }
    );
    expect(statusLog).toMatchObject({
      ok: true,
      result: { op: 'checks.logs', value: { log: { kind: 'none', reason: 'unit_has_no_log' } } },
    });
  });

  test('checks.rerun and lifecycle mutations pass forge mutation conformance', async () => {
    let attempt = 1;
    let pollsAfterRerun = 0;
    let body = 'Original';
    const fetchImpl: Fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST' && url.endsWith('/actions/jobs/7001/rerun')) {
        return new Response(null, { status: 204 });
      }
      if (url.endsWith('/actions/jobs/7001')) {
        if (pollsAfterRerun > 0) attempt = 2;
        pollsAfterRerun++;
        return json({ id: 7001, run_id: 700, name: 'test', status: 'failure', attempt });
      }
      if (url.endsWith('/actions/runs/700')) {
        return json({ id: 700, commit_sha: headSha, status: 'failure' });
      }
      if (init?.method === 'PATCH' && url.endsWith('/pulls/15')) {
        body = (JSON.parse(String(init.body)) as { body: string }).body;
      }
      if (url.endsWith('/pulls/15')) {
        return json({
          number: 15,
          html_url: 'https://codeberg.org/alice/project/pulls/15',
          title: 'PR',
          body,
          state: 'open',
          draft: false,
          merged: false,
          created_at: '2026-11-22T00:00:00Z',
          merged_at: null,
          closed_at: null,
          head: { ref: 'feat', sha: headSha, repo: { full_name: 'alice/project' } },
          base: { ref: 'main', sha: '2222222222222222222222222222222222222222' },
        });
      }
      return json({}, 404);
    };

    const failures = await runForgeMutationConformance(
      request =>
        handleForgejoOperation(request, {
          token: 'tok',
          fetch: fetchImpl,
          sleep: async () => {},
        }),
      forgejoPluginMetadata,
      [
        {
          name: 'rerun eligible failed Forgejo Actions job',
          request: {
            operationId: 'rr-1',
            op: 'checks.rerun',
            ref,
            revision: headSha,
            units: [
              {
                unit: { kind: 'check', id: '7001', name: 'test' },
                rerun: { id: '7001', attempt: 1 },
              },
            ],
          },
          expectedOutcome: 'applied',
        },
        {
          name: 'refuse commit status rerun',
          request: {
            operationId: 'rr-2',
            op: 'checks.rerun',
            ref,
            revision: headSha,
            units: [{ unit: { kind: 'commit_status', id: '51', name: 'woodpecker' }, rerun: null }],
          },
          expectedOutcome: 'refused',
        },
        {
          name: 'edit PR body applied',
          request: { operationId: 'pe-1', op: 'pr.edit-body', ref, body: 'Updated body' },
          expectedOutcome: 'applied',
        },
      ]
    );
    expect(failures).toEqual([]);
  });
});
