/** Merging a Forgejo pull request at its approved head, with the landed commit as evidence. */

import { z } from 'zod';
import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { forgejoRequest, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { prRecord, readPull } from './pull-requests';

const commitSchema = z.object({
  sha: z.string().min(1),
  commit: z.object({ tree: z.object({ sha: z.string().min(1) }).optional() }).optional(),
  parents: z.array(z.object({ sha: z.string().min(1) })).optional(),
});

async function readLandedMetadata(
  fetchImpl: Fetch,
  token: string,
  root: string,
  path: string,
  commit: string
): Promise<{ matched: boolean; tree: string | null; parents: string[] | null }> {
  let raw: unknown;
  try {
    raw = await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/git/commits/${encodeURIComponent(commit)}?stat=false&verification=false&files=false`
    );
  } catch {
    return { matched: true, tree: null, parents: null };
  }
  const parsed = commitSchema.safeParse(raw);
  if (!parsed.success || parsed.data.sha !== commit) {
    return { matched: false, tree: null, parents: null };
  }
  return {
    matched: true,
    tree: parsed.data.commit?.tree?.sha ?? null,
    parents: parsed.data.parents?.map(parent => parent.sha) ?? null,
  };
}

export async function mergePullRequest(
  request: Extract<ForgeMutationRequest, { op: 'pr.merge' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  if (!request.conditions.head) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'A merge requires the approved head condition',
    });
  }
  if (Object.keys(request.conditions).some(key => key !== 'head')) {
    return refused(request, {
      kind: 'unsupported_op',
      message: 'Forgejo enforces only the head merge condition',
    });
  }
  const before = await readPull(fetchImpl, token, request.ref);
  if (
    before.number !== request.ref.number ||
    before.head.sha !== request.conditions.head ||
    before.state !== 'open' ||
    before.merged ||
    before.draft
  ) {
    return refused(
      request,
      { kind: 'conflict', message: 'Pull request is not open and ready at the requested head' },
      prRecord(request.ref.repo, before)
    );
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  // Forgejo atomically enforces `head_commit_id` on the merge endpoint.
  await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls/${String(request.ref.number)}/merge`,
    {
      method: 'POST',
      body: JSON.stringify({
        Do: request.method,
        head_commit_id: request.conditions.head,
      }),
    },
    () => {
      submit('acknowledged');
    },
    'empty'
  );
  const observed = await readPull(fetchImpl, token, request.ref);
  const pr = prRecord(request.ref.repo, observed);
  const commit = observed.merge_commit_sha ?? null;
  if (
    pr.number !== request.ref.number ||
    pr.state !== 'merged' ||
    pr.head_revision !== request.conditions.head ||
    !commit
  ) {
    return unverified(
      request,
      'Merged pull request read-back did not match',
      'the pull request may be merged',
      { pr, landed: { commit, tree: null, parents: null } }
    );
  }
  const metadata = await readLandedMetadata(fetchImpl, token, root, path, commit);
  if (!metadata.matched) {
    return unverified(
      request,
      'Landed commit identity did not match',
      'the pull request is merged',
      { pr, landed: { commit, tree: null, parents: null } }
    );
  }
  return applied(request, {
    changed: true,
    pr,
    method: request.method,
    conditions: request.conditions,
    enforcedConditions: ['head'],
    landed: { commit, tree: metadata.tree, parents: metadata.parents },
  });
}
