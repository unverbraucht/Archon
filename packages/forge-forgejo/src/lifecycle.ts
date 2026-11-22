/**
 * Forgejo/Gitea work-item and pull-request lifecycle mutations.
 *
 * Lifecycle mutations submit at most one write and read back before claiming success.
 * Nothing submitted is a refusal, a submitted request whose answer was lost is unknown,
 * and an acknowledged write whose read-back disagrees is a verification failure.
 */

import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { ForgejoError, forgejoErrorDetail, type Fetch, type Sleep } from './api';
import { putAttachment } from './attachments';
import { handleForgejoChecksRerun } from './checks';
import { upsertComment } from './comments';
import { mergePullRequest } from './merge';
import { refused, unknown, unverified, type Submit } from './mutation-outcome';
import { createPullRequest, editPullRequestBody, setDraftState } from './pull-requests';
import { submitReview } from './reviews';
import {
  addLabel,
  createWorkItem,
  editWorkItemBody,
  ensureLabel,
  removeLabel,
  setLabels,
} from './workitems';

export async function handleForgejoMutation(
  request: ForgeMutationRequest,
  fetchImpl: Fetch,
  token: string,
  sleep: Sleep
): Promise<ForgeResponse> {
  if (request.op === 'checks.rerun') {
    return handleForgejoChecksRerun(request, fetchImpl, token, sleep);
  }
  const progress: { phase: 'not_submitted' | 'submitted' | 'acknowledged' } = {
    phase: 'not_submitted',
  };
  const submit: Submit = next => {
    progress.phase = next;
  };
  try {
    switch (request.op) {
      case 'workitem.create':
        return await createWorkItem(request, fetchImpl, token, submit);
      case 'workitem.labels.set':
        return await setLabels(request, fetchImpl, token, submit);
      case 'workitem.label.add':
        return await addLabel(request, fetchImpl, token, submit);
      case 'workitem.label.remove':
        return await removeLabel(request, fetchImpl, token, submit);
      case 'repo.label.ensure':
        return await ensureLabel(request, fetchImpl, token, submit);
      case 'pr.merge':
        return await mergePullRequest(request, fetchImpl, token, submit);
      case 'pr.create':
        return await createPullRequest(request, fetchImpl, token, submit);
      case 'pr.edit-body':
        return await editPullRequestBody(request, fetchImpl, token, submit);
      case 'pr.ready':
      case 'pr.draft':
        return await setDraftState(request, fetchImpl, token, submit);
      case 'comment.upsert':
      case 'workitem.comment.upsert':
        return await upsertComment(request, fetchImpl, token, submit);
      case 'workitem.edit-body':
        return await editWorkItemBody(request, fetchImpl, token, submit);
      case 'pr.review.submit':
        return await submitReview(request, fetchImpl, token, submit);
      case 'attachment.put':
        return await putAttachment(request, fetchImpl, token, submit);
      case 'workitem.close':
      case 'pr.thread.reply':
      case 'pr.thread.resolve':
        return refused(request, {
          kind: 'unsupported_op',
          message: `Forgejo plugin does not support ${request.op}`,
        });
    }
  } catch (cause) {
    const error = forgejoErrorDetail(cause);
    if (progress.phase === 'acknowledged') {
      return unverified(request, error.message, 'the acknowledged write may remain');
    }
    if (
      progress.phase === 'submitted' &&
      !(cause instanceof ForgejoError && cause.definitiveRefusal)
    ) {
      return unknown(request, error);
    }
    return refused(request, error);
  }
}
