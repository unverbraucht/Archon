/**
 * Pull-request reviews and review threads on Codeberg: `pr.reviews`, `pr.threads`,
 * and `pr.review.submit`.
 *
 * Forgejo reviews carry no metadata field, so `pr.review.submit` writes the
 * contract's `submitKey` on the review body's first line as an HTML comment, which
 * Forgejo does not render. This module is the only writer and reader of that line.
 */

import { z } from 'zod';
import {
  contentDigest,
  reviewItemSchema,
  reviewKeySchema,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type reviewThreadSchema,
} from '@archon/forge/operations';
import type { PrRef } from '@archon/forge';
import { forgejoPages, forgejoRequest, location, type Fetch } from './api';
import { actor, userSchema } from './actor';
import { readPullFiles } from './files';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { prRecord, readPull } from './pull-requests';

type SubmitRequest = Extract<ForgeMutationRequest, { op: 'pr.review.submit' }>;
type Placed = 'inline' | 'summary';

const ZERO_TIME_RE = /^0001-01-01T00:00:00/;
const MARKER_PREFIX = '<!-- archon-review-key: ';
const MARKER_SUFFIX = ' -->';

const reviewSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  // Empty for a review request; Forgejo does not expose a per-review web page.
  html_url: z.string().nullable().optional(),
  pull_request_url: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  user: userSchema.optional(),
  commit_id: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  dismissed: z.boolean().optional(),
  comments_count: z.number().int().nonnegative().optional(),
  submitted_at: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
});
type Review = z.infer<typeof reviewSchema>;

const reviewCommentSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  html_url: z.string().nullable().optional(),
  pull_request_url: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  user: userSchema.optional(),
  commit_id: z.string().nullable().optional(),
  original_commit_id: z.string().nullable().optional(),
  path: z.string(),
  position: z.number().int().nonnegative().optional(),
  original_position: z.number().int().nonnegative().optional(),
  pull_request_review_id: z.number().int().nullable().optional(),
  resolver: userSchema.optional(),
  created_at: z.string().nullable().optional(),
});
type ReviewComment = z.infer<typeof reviewCommentSchema>;

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value || ZERO_TIME_RE.test(value)) return null;
  return value;
}

function normalizeCommit(value: string | null | undefined): string | null {
  return value && value.length > 0 ? value : null;
}

function reviewMarker(key: string): string {
  return `${MARKER_PREFIX}${key}${MARKER_SUFFIX}`;
}

function markerKey(body: string | null | undefined): string | undefined {
  const first = (body ?? '').split(/\r?\n/, 1)[0] ?? '';
  if (!first.startsWith(MARKER_PREFIX) || !first.endsWith(MARKER_SUFFIX)) return undefined;
  const key = reviewKeySchema.safeParse(first.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length));
  return key.success ? key.data : undefined;
}

function pullUrl(ref: PrRef): string {
  const { root, path } = location(ref.repo);
  return `${root}/repos/${path}/pulls/${String(ref.number)}`;
}

function pullWebUrl(ref: PrRef): string {
  const { webRoot, path } = location(ref.repo);
  return `${webRoot}/${path}/pulls/${String(ref.number)}`;
}

/**
 * A review or review comment's web URL. Forgejo leaves `html_url` empty on a
 * review request and does not expose a per-review page, so the pull request is
 * the honest link in that case.
 */
function itemWebUrl(
  value: string | null | undefined,
  ref: PrRef,
  pullRequestUrl?: string | null
): string {
  for (const candidate of [value, pullRequestUrl]) {
    const url = candidate?.trim();
    if (url && z.url().safeParse(url).success) return url;
  }
  return pullWebUrl(ref);
}

function isSubmittedReview(review: Review): boolean {
  const state = (review.state ?? '').toUpperCase();
  return state !== 'PENDING' && state !== 'REQUEST_REVIEW';
}

async function readReviews(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Review[]> {
  return forgejoPages(fetchImpl, token, `${pullUrl(ref)}/reviews`, value =>
    z.array(reviewSchema).parse(value)
  );
}

async function readCommentsForReview(
  fetchImpl: Fetch,
  token: string,
  ref: PrRef,
  reviewId: string | number
): Promise<ReviewComment[]> {
  return z
    .array(reviewCommentSchema)
    .parse(
      await forgejoRequest(
        fetchImpl,
        token,
        `${pullUrl(ref)}/reviews/${encodeURIComponent(String(reviewId))}/comments`
      )
    );
}

async function readAllReviewComments(
  fetchImpl: Fetch,
  token: string,
  ref: PrRef,
  reviews: readonly Review[]
): Promise<ReviewComment[]> {
  const withComments = reviews.filter(review => (review.comments_count ?? 1) > 0);
  const batches = await Promise.all(
    withComments.map(review => readCommentsForReview(fetchImpl, token, ref, review.id))
  );
  return batches.flat();
}

export async function handleForgejoPrReviews(
  request: Extract<ForgeRequest, { op: 'pr.reviews' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const reviews = (await readReviews(fetchImpl, token, request.ref)).filter(isSubmittedReview);
  const comments = await readAllReviewComments(fetchImpl, token, request.ref, reviews);
  const keys = new Map<string, string>();
  for (const review of reviews) {
    const key = markerKey(review.body);
    if (key !== undefined) keys.set(String(review.id), key);
  }
  const projectReview = (review: Review): z.infer<typeof reviewItemSchema> => {
    const submitKey = keys.get(String(review.id));
    return {
      kind: 'review',
      id: String(review.id),
      author: actor(request.ref.repo.host, review.user ?? null),
      commit: normalizeCommit(review.commit_id),
      state: review.dismissed ? 'DISMISSED' : (review.state ?? null),
      createdAt: normalizeTimestamp(review.submitted_at) ?? normalizeTimestamp(review.updated_at),
      url: itemWebUrl(review.html_url, request.ref, review.pull_request_url),
      body: review.body ?? '',
      ...(submitKey === undefined ? {} : { submitKey }),
    };
  };
  const projectComment = (comment: ReviewComment): z.infer<typeof reviewItemSchema> => {
    const submitKey =
      comment.pull_request_review_id == null
        ? undefined
        : keys.get(String(comment.pull_request_review_id));
    return {
      kind: 'review_comment',
      id: String(comment.id),
      author: actor(request.ref.repo.host, comment.user ?? null),
      commit: normalizeCommit(comment.original_commit_id) ?? normalizeCommit(comment.commit_id),
      state: null,
      createdAt: normalizeTimestamp(comment.created_at),
      url: itemWebUrl(comment.html_url, request.ref, comment.pull_request_url),
      body: comment.body ?? '',
      ...(submitKey === undefined ? {} : { submitKey }),
    };
  };
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        ref: request.ref,
        items: [...reviews.map(projectReview), ...comments.map(projectComment)],
      },
    },
  };
}

function commentLine(comment: ReviewComment): number | null {
  if (comment.position && comment.position > 0) return comment.position;
  if (comment.original_position && comment.original_position > 0) return comment.original_position;
  return null;
}

function commentThreadKey(comment: ReviewComment): string {
  return JSON.stringify([comment.path, comment.position ?? 0, comment.original_position ?? 0]);
}

function buildThread(
  ref: PrRef,
  headSha: string,
  comments: readonly ReviewComment[]
): z.infer<typeof reviewThreadSchema> {
  const sorted = [...comments].sort((left, right) => {
    const leftTime = left.created_at ? Date.parse(left.created_at) : 0;
    const rightTime = right.created_at ? Date.parse(right.created_at) : 0;
    return leftTime - rightTime || Number(left.id) - Number(right.id);
  });
  const opening = sorted[0];
  const openingCommit =
    normalizeCommit(opening.original_commit_id) ?? normalizeCommit(opening.commit_id);
  const openingCreated = normalizeTimestamp(opening.created_at);
  return {
    id: String(opening.id),
    ...(openingCreated ? { createdAt: openingCreated } : {}),
    commit: openingCommit,
    resolved: sorted.some(comment => comment.resolver != null),
    outdated: openingCommit !== null && openingCommit !== headSha,
    path: opening.path || null,
    line: commentLine(opening),
    comments: sorted.map(comment => {
      const createdAt = normalizeTimestamp(comment.created_at);
      return {
        id: String(comment.id),
        author: actor(ref.repo.host, comment.user ?? null),
        ...(createdAt ? { createdAt } : {}),
        commit: normalizeCommit(comment.original_commit_id) ?? normalizeCommit(comment.commit_id),
        body: comment.body ?? '',
        url: itemWebUrl(comment.html_url, ref, comment.pull_request_url),
      };
    }),
  };
}

export async function handleForgejoPrThreads(
  request: Extract<ForgeRequest, { op: 'pr.threads' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const [pull, allReviews] = await Promise.all([
    readPull(fetchImpl, token, request.ref),
    readReviews(fetchImpl, token, request.ref),
  ]);
  const reviews = allReviews.filter(isSubmittedReview);
  const comments = await readAllReviewComments(fetchImpl, token, request.ref, reviews);
  const grouped = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const key = commentThreadKey(comment);
    const list = grouped.get(key) ?? [];
    list.push(comment);
    grouped.set(key, list);
  }
  const threads = [...grouped.values()].map(group =>
    buildThread(request.ref, pull.head.sha, group)
  );
  return {
    operationId: request.operationId,
    ok: true,
    result: { op: request.op, value: { ref: request.ref, threads } },
  };
}

/** The new-side lines a unified diff shows, added or context, which Forgejo accepts a comment on. */
function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  let next: number | undefined;
  for (const row of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (hunk) {
      next = Number(hunk[1]);
      continue;
    }
    if (next === undefined || row.startsWith('-') || row.startsWith('\\')) continue;
    lines.add(next);
    next++;
  }
  return lines;
}

function composeBody(request: SubmitRequest, placed: readonly Placed[]): string {
  const elsewhere = request.comments.filter((_, index) => placed[index] === 'summary');
  const sections = [`${reviewMarker(request.key)}\n${request.summary}`];
  if (elsewhere.length > 0) {
    sections.push('### Findings not on a changed line');
    for (const comment of elsewhere) {
      sections.push(`**\`${comment.path}\`, line ${String(comment.line)}**\n\n${comment.body}`);
    }
  }
  return sections.join('\n\n');
}

function observedPlacement(request: SubmitRequest, comments: readonly ReviewComment[]): Placed[] {
  const unmatched = [...comments];
  return request.comments.map(wanted => {
    const index = unmatched.findIndex(
      comment =>
        comment.path === wanted.path &&
        commentLine(comment) === wanted.line &&
        (comment.body ?? '') === wanted.body
    );
    if (index === -1) return 'summary';
    unmatched.splice(index, 1);
    return 'inline';
  });
}

function showsRequest(
  request: SubmitRequest,
  review: Review,
  comments: readonly ReviewComment[],
  placed: readonly Placed[]
): boolean {
  return (
    (review.body ?? '') === composeBody(request, placed) &&
    comments.length === placed.filter(where => where === 'inline').length
  );
}

function submitResult(request: SubmitRequest, review: Review, placed: readonly Placed[]): object {
  return {
    review: {
      ref: request.ref,
      id: String(review.id),
      url: itemWebUrl(review.html_url, request.ref, review.pull_request_url),
      commit: request.commit,
      key: request.key,
      bodyDigest: contentDigest(review.body ?? ''),
    },
    comments: request.comments.map((comment, index) => ({
      path: comment.path,
      line: comment.line,
      placed: placed[index],
    })),
  };
}

async function checkExistingReview(
  request: SubmitRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse | null> {
  const posted = (await readReviews(fetchImpl, token, request.ref)).filter(
    review =>
      isSubmittedReview(review) &&
      review.commit_id === request.commit &&
      markerKey(review.body) === request.key
  );
  if (posted.length > 1) {
    return refused(request, {
      kind: 'conflict',
      message: `More than one review on this pull request carries key ${request.key} at ${request.commit}`,
    });
  }
  const previous = posted[0];
  if (!previous) return null;
  const comments = await readCommentsForReview(fetchImpl, token, request.ref, previous.id);
  const placed = observedPlacement(request, comments);
  if (!showsRequest(request, previous, comments, placed)) {
    return refused(request, {
      kind: 'conflict',
      message: `Review ${String(previous.id)} already carries key ${request.key} at ${request.commit} with other content; submit under another key`,
    });
  }
  return applied(request, { changed: false, ...submitResult(request, previous, placed) });
}

export async function submitReview(
  request: SubmitRequest,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const pull = await readPull(fetchImpl, token, request.ref);
  const headMoved = (head: string) =>
    refused(
      request,
      {
        kind: 'conflict',
        message: `Pull request ${String(request.ref.number)}'s head is ${head}, not the reviewed commit ${request.commit}`,
      },
      prRecord(request.ref.repo, pull)
    );
  if (pull.head.sha !== request.commit) return headMoved(pull.head.sha);

  const existing = await checkExistingReview(request, fetchImpl, token);
  if (existing) return existing;

  const { head, files } = await readPullFiles(fetchImpl, token, request.ref);
  if (head !== request.commit) return headMoved(head);
  const shown = new Map(
    files.flatMap(file =>
      file.patch === null ? [] : [[file.path, commentableLines(file.patch)] as const]
    )
  );
  const placed: Placed[] = request.comments.map(comment =>
    shown.get(comment.path)?.has(comment.line) ? 'inline' : 'summary'
  );
  const body = composeBody(request, placed);

  submit('submitted');
  const raw = await forgejoRequest(
    fetchImpl,
    token,
    `${pullUrl(request.ref)}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify({
        commit_id: request.commit,
        body,
        event: 'COMMENT',
        comments: request.comments
          .filter((_, index) => placed[index] === 'inline')
          .map(comment => ({
            path: comment.path,
            new_position: comment.line,
            body: comment.body,
          })),
      }),
    },
    () => {
      submit('acknowledged');
    }
  );
  const written = reviewSchema.safeParse(raw);
  if (!written.success) {
    return unverified(
      request,
      'Review submit response was malformed',
      'a review may have been posted'
    );
  }
  const leaveBehind = `review ${String(written.data.id)} exists on the pull request`;
  let review: Review;
  let comments: ReviewComment[];
  try {
    review = reviewSchema.parse(
      await forgejoRequest(
        fetchImpl,
        token,
        `${pullUrl(request.ref)}/reviews/${String(written.data.id)}`
      )
    );
    comments = await readCommentsForReview(fetchImpl, token, request.ref, review.id);
  } catch {
    return unverified(request, 'Review could not be read back', leaveBehind);
  }
  if (
    String(review.id) !== String(written.data.id) ||
    review.commit_id !== request.commit ||
    observedPlacement(request, comments).some((where, index) => where !== placed[index]) ||
    !showsRequest(request, review, comments, placed)
  ) {
    return unverified(request, 'Review read-back did not match', leaveBehind);
  }
  return applied(request, { changed: true, ...submitResult(request, review, placed) });
}
