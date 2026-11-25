/**
 * Conversation comments on a Forgejo issue or pull request: the canonical marked
 * comment, written in place, and the read of every comment with its author.
 */

import { z } from 'zod';
import {
  contentDigest,
  type ForgeCommentRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { PrRef } from '@archon/forge';
import { forgejoRequest, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';
import { readIssue, subjectRecord } from './workitems';
import { actor, userSchema } from './actor';

const commentSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  html_url: z.url(),
  issue_url: z.string().optional(),
  pull_request_url: z.string().optional(),
  body: z.string().nullable(),
  user: userSchema.optional(),
});
type Comment = z.infer<typeof commentSchema>;

function commentRecord(ref: PrRef, comment: Comment): ForgeCommentRecord {
  return {
    ref,
    id: String(comment.id),
    url: comment.html_url,
    bodyDigest: contentDigest(comment.body ?? ''),
  };
}

/**
 * A comment belongs to the item when its web URL names the same repository and the same number.
 * The host is not part of that test: Forgejo builds these URLs from its own `ROOT_URL`, which says
 * nothing about the address a client reached the instance on. On 2026-11-25 the instance still
 * returned `http://nas.kevin-read.com:3864/...` while the clients had moved to the LAN address, so
 * every `workitem.comment.upsert` was written, read back, compared against the *client's* host and
 * reported `unverified` — which a caller treating a verified write as part of its contract (the
 * review guard) treats as fatal. A vanity domain or a proxy in front of the forge does the same.
 *
 * The path is what carries the identity: `/<repo>/issues/<n>` or `/<repo>/pulls/<n>`. Parsing the
 * URL also drops a `#comment` fragment and any query, which the old string comparison kept.
 *
 * The repository segment comes from `location` because that is the encoded form the adapter puts in
 * every request: comparing a decoded `owner/repo` against a parsed URL would agree only while the
 * names happen to need no encoding.
 */
function commentBelongsToRef(comment: Comment, ref: PrRef): boolean {
  const expectedPath = `/${location(ref.repo).path}`.toLowerCase();
  const suffixIssue = `/issues/${String(ref.number)}`;
  const suffixPull = `/pulls/${String(ref.number)}`;
  const urls = [comment.issue_url, comment.pull_request_url].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (urls.length === 0) return true;
  return urls.some(url => {
    let pathname: string;
    try {
      pathname = new URL(url).pathname.toLowerCase();
    } catch {
      return false;
    }
    const endsAtItem = pathname.endsWith(suffixIssue) || pathname.endsWith(suffixPull);
    return endsAtItem && pathname.startsWith(`${expectedPath}/`);
  });
}

export async function upsertComment(
  request: Extract<ForgeMutationRequest, { op: 'comment.upsert' | 'workitem.comment.upsert' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  if ((request.body.split(/\r?\n/, 1)[0] ?? '') !== request.marker) {
    return refused(request, {
      kind: 'invalid_request',
      message: 'Comment body must begin with the exact canonical marker',
    });
  }
  const ref = request.op === 'comment.upsert' ? request.ref : request.subject.ref;
  const subject =
    request.op === 'workitem.comment.upsert'
      ? { workitem: subjectRecord(request.subject, await readIssue(fetchImpl, token, ref)) }
      : {};
  const { root, path } = location(ref.repo);
  const issue = `${root}/repos/${path}/issues/${String(ref.number)}`;
  // This endpoint has no page/limit parameters: Gitea/Forgejo answer the whole
  // comment list, and appending them would re-read the same list forever once an
  // item has enough comments.
  const comments = z
    .array(commentSchema)
    .parse(await forgejoRequest(fetchImpl, token, `${issue}/comments`));
  const marked = comments.filter(
    comment => (comment.body ?? '').split(/\r?\n/, 1)[0] === request.marker
  );
  if (marked.length > 1) {
    return refused(request, {
      kind: 'conflict',
      message: 'Multiple comments on this item carry the canonical marker',
    });
  }
  const previous = marked[0];
  if (previous && (previous.body ?? '') === request.body) {
    return applied(request, {
      changed: false,
      ...subject,
      comment: commentRecord(ref, previous),
    });
  }
  submit('submitted');
  const raw = await forgejoRequest(
    fetchImpl,
    token,
    previous ? `${root}/repos/${path}/issues/comments/${String(previous.id)}` : `${issue}/comments`,
    { method: previous ? 'PATCH' : 'POST', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  const written = commentSchema.safeParse(raw);
  if (!written.success) {
    return unverified(
      request,
      'Comment write response was malformed',
      'a comment may have changed',
      subject
    );
  }
  const leaveBehind = `comment ${String(written.data.id)} may have changed`;
  let observed: Comment;
  try {
    observed = commentSchema.parse(
      await forgejoRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/issues/comments/${String(written.data.id)}`
      )
    );
  } catch {
    return unverified(request, 'Comment could not be read back', leaveBehind, subject);
  }
  const comment = commentRecord(ref, observed);
  if (
    String(observed.id) !== String(written.data.id) ||
    !commentBelongsToRef(observed, ref) ||
    (observed.body ?? '') !== request.body
  ) {
    return unverified(request, 'Comment read-back did not match', leaveBehind, {
      ...subject,
      comment,
    });
  }
  return applied(request, { changed: true, ...subject, comment });
}

export async function handleForgejoWorkItemComments(
  request: Extract<ForgeRequest, { op: 'workitem.comments' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { ref } = request.subject;
  const workitem = subjectRecord(request.subject, await readIssue(fetchImpl, token, ref));
  const { root, path } = location(ref.repo);
  const comments = z
    .array(commentSchema)
    .parse(
      await forgejoRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/issues/${String(ref.number)}/comments`
      )
    );
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'workitem.comments',
      value: {
        workitem,
        comments: comments.map(comment => ({
          id: String(comment.id),
          author: actor(ref.repo.host, comment.user ?? null),
          url: comment.html_url,
          body: comment.body ?? '',
        })),
      },
    },
  };
}
