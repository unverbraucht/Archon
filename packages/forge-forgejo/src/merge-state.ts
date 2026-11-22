/**
 * `pr.merge-state` on Codeberg: how far a pull request's head is behind its own
 * base branch, and whether it merges into it.
 */

import { z } from 'zod';
import type { ForgeRequest, ForgeResponse } from '@archon/forge/operations';
import { ForgejoError, forgejoRequest, location, type Fetch } from './api';

const pullSchema = z.object({
  head: z.object({ sha: z.string().min(1) }),
  base: z.object({ ref: z.string().min(1) }),
  mergeable: z.boolean().nullable().optional(),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().nullable().optional(),
});

const branchSchema = z.object({
  name: z.string().min(1),
  commit: z.object({ id: z.string().min(1) }),
});

const compareSchema = z.object({
  total_commits: z.number().int().nonnegative(),
});

export async function handleForgejoPrMergeState(
  request: Extract<ForgeRequest, { op: 'pr.merge-state' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { repo, number } = request.ref;
  const { root, path } = location(repo);
  const pull = pullSchema.parse(
    await forgejoRequest(fetchImpl, token, `${root}/repos/${path}/pulls/${String(number)}`)
  );
  const branch = branchSchema.parse(
    await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/branches/${encodeURIComponent(pull.base.ref)}`
    )
  );
  let behind = 0;
  if (pull.head.sha !== branch.commit.id) {
    // Forgejo's `compare/{a}...{b}` returns commits reachable from `b` not in `a`.
    const basehead = `${encodeURIComponent(pull.head.sha)}...${encodeURIComponent(branch.commit.id)}`;
    const compare = compareSchema.parse(
      await forgejoRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/compare/${basehead}?verification=false&files=false`
      )
    );
    behind = compare.total_commits;
  }
  if (!branch.name) {
    throw new ForgejoError(
      { kind: 'not_found', message: `${repo.path} pull request ${String(number)} has no base` },
      true
    );
  }
  const mergeable =
    pull.mergeable === true ? 'clean' : pull.mergeable === false ? 'conflict' : 'unknown';
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'pr.merge-state',
      value: {
        ref: request.ref,
        head_revision: pull.head.sha,
        base_branch: branch.name,
        base_revision: branch.commit.id,
        behind,
        mergeable,
        merge_commit:
          pull.merged && pull.merge_commit_sha && pull.merge_commit_sha.length > 0
            ? pull.merge_commit_sha
            : null,
      },
    },
  };
}
