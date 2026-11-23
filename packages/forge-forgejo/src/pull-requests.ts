/** Forgejo pull request reads and the create, body edit, and draft-state mutations. */

import { z } from 'zod';
import {
  contentDigest,
  forgePrRecordSchema,
  type ForgeMutationRequest,
  type ForgePrRecord,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef, RepoRef } from '@archon/forge';
import {
  ForgejoError,
  forgejoPages,
  forgejoRequest,
  location,
  repositoryPath,
  type Fetch,
} from './api';
import { authorField, userSchema } from './actor';
import { applied, failure, refused, unverified, type Submit } from './mutation-outcome';

/** Forgejo marks a PR as draft/WIP through title prefixes (default `WIP:` / `[WIP]`). */
const WIP_PREFIX_RE = /^(?:wip:|\[wip\])\s*/i;
const ZERO_TIME_RE = /^0001-01-01T00:00:00/;

const repoSchema = z.object({ full_name: z.string().min(1) });
const timestampSchema = z.iso.datetime({ offset: true }).nullable();

const pullSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().default(false),
  merged: z.boolean().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  allow_maintainer_edit: z.boolean().nullable().optional(),
  user: userSchema.optional(),
  created_at: z.iso.datetime({ offset: true }),
  merged_at: timestampSchema.optional(),
  closed_at: timestampSchema.optional(),
  head: z.object({ ref: z.string().min(1), sha: z.string(), repo: repoSchema.nullable() }),
  base: z.object({ ref: z.string().min(1), sha: z.string() }),
});
export type Pull = z.infer<typeof pullSchema>;

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value || ZERO_TIME_RE.test(value)) return null;
  return value;
}

function normalizeSha(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

export async function readPull(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Pull> {
  const { root, path } = location(ref.repo);
  return pullSchema.parse(
    await forgejoRequest(fetchImpl, token, `${root}/repos/${path}/pulls/${String(ref.number)}`)
  );
}

export function prRecord(repo: RepoRef, pull: Pull): ForgePrRecord {
  return forgePrRecordSchema.parse({
    schemaVersion: 1,
    repo,
    number: pull.number,
    url: pull.html_url,
    head: pull.head.ref,
    base: pull.base.ref,
    is_draft: pull.draft,
    state: pull.merged ? 'merged' : pull.state,
    head_repo: pull.head.repo ? { ...repo, path: pull.head.repo.full_name } : null,
    head_revision: normalizeSha(pull.head.sha),
    base_revision: normalizeSha(pull.base.sha),
    maintainer_can_modify: pull.allow_maintainer_edit ?? null,
  });
}

function sameRepo(left: RepoRef, right: RepoRef): boolean {
  return (
    left.host.toLowerCase() === right.host.toLowerCase() &&
    left.path.toLowerCase() === right.path.toLowerCase()
  );
}

/** Prove a fork head repository exists and matches the qualified repository. */
async function verifyRepository(fetchImpl: Fetch, token: string, repo: RepoRef): Promise<void> {
  const { root, path } = location(repo);
  const observed = repoSchema.parse(
    await forgejoRequest(fetchImpl, token, `${root}/repos/${path}`)
  );
  if (observed.full_name.toLowerCase() !== repo.path.toLowerCase()) {
    throw new ForgejoError(
      {
        kind: 'invalid_response',
        message: 'Forgejo repository read-back did not match the qualified repository',
      },
      true
    );
  }
}

function draftTitle(title: string): string {
  return WIP_PREFIX_RE.test(title) ? title : `WIP: ${title}`;
}

function pullMatchesCreate(
  request: Extract<ForgeMutationRequest, { op: 'pr.create' }>,
  observed: Pull,
  pr: ForgePrRecord,
  submittedTitle: string
): boolean {
  return (
    observed.title === submittedTitle &&
    (observed.body ?? '') === request.body &&
    pr.head === request.head &&
    pr.head_revision === request.headRevision &&
    pr.head_repo !== null &&
    sameRepo(pr.head_repo, request.headRepo) &&
    pr.base === request.base &&
    pr.is_draft === request.draft &&
    pr.state === 'open'
  );
}

export async function createPullRequest(
  request: Extract<ForgeMutationRequest, { op: 'pr.create' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  if (request.headRepo.host.toLowerCase() !== request.repo.host.toLowerCase()) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'Forgejo pull request head and base repositories must use the same host',
    });
  }
  const headRepository = repositoryPath(request.headRepo.path);
  if (!headRepository) {
    return refused(request, {
      kind: 'invalid_request',
      message: `Invalid Forgejo head repository path: ${request.headRepo.path}`,
    });
  }
  const sameRepository = request.headRepo.path.toLowerCase() === request.repo.path.toLowerCase();
  if (!sameRepository) await verifyRepository(fetchImpl, token, request.headRepo);
  const submittedTitle = request.draft ? draftTitle(request.title) : request.title;
  const { root, path } = location(request.repo);
  submit('submitted');
  const raw = await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls`,
    {
      method: 'POST',
      body: JSON.stringify({
        head: sameRepository ? request.head : `${headRepository.owner}:${request.head}`,
        base: request.base,
        title: submittedTitle,
        body: request.body,
      }),
    },
    () => {
      submit('acknowledged');
    }
  );
  const created = pullSchema.safeParse(raw);
  if (!created.success) {
    return unverified(
      request,
      'Created pull request response was malformed',
      'a pull request may exist'
    );
  }
  const leaveBehind = `pull request ${String(created.data.number)} may exist`;
  let observed: Pull;
  try {
    observed = await readPull(fetchImpl, token, {
      repo: request.repo,
      number: created.data.number,
    });
  } catch {
    return unverified(request, 'Created pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.repo, observed);
  return pullMatchesCreate(request, observed, pr, submittedTitle)
    ? applied(request, { changed: true, pr })
    : unverified(request, 'Created pull request did not match requested fields', leaveBehind, {
        pr,
      });
}

export async function editPullRequestBody(
  request: Extract<ForgeMutationRequest, { op: 'pr.edit-body' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const before = await readPull(fetchImpl, token, request.ref);
  if ((before.body ?? '') === request.body) {
    return applied(request, {
      changed: false,
      pr: prRecord(request.ref.repo, before),
      bodyDigest: contentDigest(request.body),
    });
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the pull request body may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Updated pull request could not be read back', leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return (after.body ?? '') === request.body
    ? applied(request, { changed: true, pr, bodyDigest: contentDigest(request.body) })
    : unverified(request, 'Pull request body read-back did not match', leaveBehind, { pr });
}

function nextDraftTitle(title: string, draft: boolean): string | null {
  if (draft) return draftTitle(title);
  const stripped = title.replace(WIP_PREFIX_RE, '').trimStart();
  return stripped.length > 0 ? stripped : null;
}

export async function setDraftState(
  request: Extract<ForgeMutationRequest, { op: 'pr.ready' | 'pr.draft' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const draft = request.op === 'pr.draft';
  const transition = draft ? 'converted to draft' : 'marked ready';
  const before = await readPull(fetchImpl, token, request.ref);
  const beforeRecord = prRecord(request.ref.repo, before);
  if (beforeRecord.state !== 'open') {
    return refused(
      request,
      { kind: 'conflict', message: `A ${beforeRecord.state} pull request cannot be ${transition}` },
      beforeRecord
    );
  }
  if (beforeRecord.is_draft === draft) {
    return applied(request, { changed: false, pr: beforeRecord });
  }
  const title = nextDraftTitle(before.title, draft);
  if (title === null || title === before.title) {
    return refused(
      request,
      {
        kind: 'conflict',
        message: `Pull request title cannot be ${transition} via WIP prefix`,
      },
      beforeRecord
    );
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/pulls/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ title }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the pull request draft state may have changed';
  let after: Pull;
  try {
    after = await readPull(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, `${request.op} pull request could not be read back`, leaveBehind);
  }
  const pr = prRecord(request.ref.repo, after);
  return pr.state === 'open' && pr.is_draft === draft
    ? applied(request, { changed: true, pr })
    : unverified(request, `${request.op} read-back did not match`, leaveBehind, { pr });
}

function formatPrView(operationId: string, pull: Pull | undefined, repo: RepoRef): ForgeResponse {
  if (!pull) {
    return { operationId, ok: true, result: { op: 'pr.view', value: null } };
  }
  const pr = prRecord(repo, pull);
  const mergedAt = normalizeTimestamp(pull.merged_at);
  const closedAt = normalizeTimestamp(pull.closed_at);
  return {
    operationId,
    ok: true,
    result: {
      op: 'pr.view',
      value: {
        pr,
        title: pull.title,
        body: pull.body ?? '',
        ...authorField(repo.host, pull.user),
        timestamps: {
          created_at: pull.created_at,
          merged_at: pr.state === 'merged' ? mergedAt : null,
          closed_at: pr.state === 'open' ? null : closedAt,
        },
      },
    },
  };
}

function matchesHeadSelector(
  pull: Pull,
  selector: Extract<Extract<ForgeRequest, { op: 'pr.view' }>['selector'], { kind: 'head' }>
): boolean {
  if (pull.head.ref !== selector.head) return false;
  if (selector.base !== undefined && pull.base.ref !== selector.base) return false;
  if (!pull.head.repo) return false;
  return pull.head.repo.full_name.toLowerCase() === selector.headRepo.path.toLowerCase();
}

export async function handleForgejoPrView(
  request: Extract<ForgeRequest, { op: 'pr.view' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  if (request.selector.kind === 'number') {
    const pull = await readPull(fetchImpl, token, request.selector.ref);
    return formatPrView(request.operationId, pull, request.selector.ref.repo);
  }
  const selector = request.selector;
  if (selector.headRepo.host.toLowerCase() !== selector.repo.host.toLowerCase()) {
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: 'Forgejo pull request head and base repositories must use the same host',
    });
  }
  const headRepository = repositoryPath(selector.headRepo.path);
  if (!headRepository) {
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: `Invalid Forgejo head repository path: ${selector.headRepo.path}`,
    });
  }
  const sameRepository = selector.headRepo.path.toLowerCase() === selector.repo.path.toLowerCase();
  if (!sameRepository) await verifyRepository(fetchImpl, token, selector.headRepo);
  const { root, path } = location(selector.repo);
  const anyState = selector.state === 'any';
  // Forgejo/Gitea filter `head` by branch name only; the owner-qualified form finds
  // nothing, including for a fork. `matchesHeadSelector` verifies the head repository
  // against `headRepo` afterwards, so the branch-name query is safe.
  const query = `state=${anyState ? 'all' : 'open'}&head=${encodeURIComponent(selector.head)}${
    selector.base === undefined ? '' : `&base=${encodeURIComponent(selector.base)}`
  }`;
  const listed = await forgejoPages(fetchImpl, token, `${root}/repos/${path}/pulls?${query}`, raw =>
    z.array(pullSchema).parse(raw)
  );
  const matches = listed.filter(pull => matchesHeadSelector(pull, selector));
  if (!anyState && matches.length > 1) {
    return failure(request.operationId, {
      kind: 'conflict',
      message: 'Pull request head selector matched more than one pull request',
    });
  }
  matches.sort(
    (left, right) =>
      Date.parse(right.created_at) - Date.parse(left.created_at) || right.number - left.number
  );
  const selected = matches[0];
  const full = selected
    ? await readPull(fetchImpl, token, { repo: selector.repo, number: selected.number })
    : undefined;
  return formatPrView(request.operationId, full, selector.repo);
}
