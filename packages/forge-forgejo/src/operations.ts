/** Operation metadata and top-level dispatch for the Forgejo / Codeberg / Gitea forge plugin. */

import {
  PR_VIEW_ANY_STATE,
  RESOLVE_SUBJECT,
  type ForgeError,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type PluginMetadata,
  isMutationRequest,
  mutationTarget,
  mutationAttempt,
} from '@archon/forge/operations';
import { forgejoErrorDetail, parseRemote, parseSubjectUrl, type Fetch, type Sleep } from './api';
import {
  handleForgejoChecksCommit,
  handleForgejoChecksLogs,
  handleForgejoChecksState,
} from './checks';
import { handleForgejoWorkItemComments } from './comments';
import { handleForgejoPrFiles, handleForgejoRepoFile } from './files';
import { handleForgejoMutation } from './lifecycle';
import { handleForgejoPrMergeState } from './merge-state';
import { handleForgejoPrView } from './pull-requests';
import { handleForgejoPrReviews, handleForgejoPrThreads } from './reviews';
import { handleForgejoWorkItemSearch } from './search';
import {
  handleForgejoRepoLabelsList,
  handleForgejoWorkItemList,
  handleForgejoWorkItemView,
} from './workitems';

export const forgejoPluginMetadata = {
  protocol: 1,
  name: 'forgejo',
  version: '1',
  forge: 'forgejo',
  hosts: ['codeberg.org', 'gitea.com'],
  capabilities: [
    'resolve',
    RESOLVE_SUBJECT,
    'checks.state',
    'checks.commit',
    'checks.logs',
    'checks.rerun',
    'workitem.view',
    'workitem.comments',
    'workitem.create',
    'workitem.labels.set',
    'workitem.label.add',
    'workitem.label.remove',
    'workitem.comment.upsert',
    'workitem.edit-body',
    'workitem.list',
    'workitem.search',
    'repo.labels.list',
    'repo.label.ensure',
    'repo.file',
    'pr.view',
    PR_VIEW_ANY_STATE,
    'pr.create',
    'pr.edit-body',
    'pr.ready',
    'pr.draft',
    'pr.merge',
    'pr.reviews',
    'pr.threads',
    'pr.merge-state',
    'pr.files',
    'pr.review.submit',
    'comment.upsert',
    'attachment.put',
  ],
  mutationConditions: { 'pr.merge': ['head'] },
  token_env: ['FORGEJO_TOKEN', 'CODEBERG_TOKEN', 'GITEA_TOKEN'],
  remedies: {
    unsupported_op:
      'Update the Forgejo plugin (`archon plugin update coleam00/Archon/plugins/forge-forgejo`) ' +
      'or check whether the Forgejo/Gitea REST API supports this operation.',
    no_credential:
      "Set `FORGEJO_TOKEN` (or `CODEBERG_TOKEN` / `GITEA_TOKEN`) in Archon's env file " +
      '(`~/.archon/.env`, `ARCHON_HOME/.env` when configured, or `/.archon/.env` in Docker), ' +
      'log in with `tea login add`, or configure `token_env` under `forge.hosts` in ' +
      '`~/.archon/config.yaml`.',
  },
} satisfies PluginMetadata;

export interface ForgejoOperationOptions {
  readonly token: string | undefined;
  readonly fetch?: Fetch;
  /** The wait inside a write's read-back; tests replace it so they do not sleep. */
  readonly sleep?: Sleep;
}

function failure(operationId: string, error: ForgeError): ForgeResponse {
  return { operationId, ok: false, error };
}

type ReadOp = Exclude<ForgeRequest['op'], 'resolve' | ForgeMutationRequest['op']>;
type ReadHandler<Op extends ReadOp> = (
  request: Extract<ForgeRequest, { op: Op }>,
  fetchImpl: Fetch,
  token: string
) => Promise<ForgeResponse>;

const readHandlers: { [Op in ReadOp]: ReadHandler<Op> } = {
  'workitem.view': handleForgejoWorkItemView,
  'workitem.list': handleForgejoWorkItemList,
  'workitem.search': handleForgejoWorkItemSearch,
  'workitem.comments': handleForgejoWorkItemComments,
  'repo.labels.list': handleForgejoRepoLabelsList,
  'pr.view': handleForgejoPrView,
  'pr.reviews': handleForgejoPrReviews,
  'pr.threads': handleForgejoPrThreads,
  'pr.merge-state': handleForgejoPrMergeState,
  'pr.files': handleForgejoPrFiles,
  'repo.file': handleForgejoRepoFile,
  'checks.state': handleForgejoChecksState,
  'checks.commit': handleForgejoChecksCommit,
  'checks.logs': handleForgejoChecksLogs,
};

type ResolveValue = Extract<
  Extract<ForgeResponse, { ok: true }>['result'],
  { op: 'resolve' }
>['value'];

function resolveForgejo(remote: string | null, web: boolean): ResolveValue {
  const subject = web ? parseSubjectUrl(remote) : null;
  const repo = web ? subject?.repo : parseRemote(remote);
  if (!repo) return { kind: 'none', forge: 'none' };
  const resolved = {
    kind: 'resolved' as const,
    forge: 'forgejo',
    repo,
    plugin: forgejoPluginMetadata,
  };
  return subject ? { ...resolved, subject: subject.subject } : resolved;
}

export async function handleForgejoOperation(
  request: ForgeRequest,
  options: ForgejoOperationOptions
): Promise<ForgeResponse> {
  try {
    if (request.op === 'resolve') {
      return {
        operationId: request.operationId,
        ok: true,
        result: { op: 'resolve', value: resolveForgejo(request.remote, request.web === true) },
      };
    }

    if (!options.token) {
      const error = {
        kind: 'no_credential' as const,
        message: 'ARCHON_FORGE_TOKEN is required for Forgejo/Gitea operations',
      };
      return isMutationRequest(request)
        ? {
            operationId: request.operationId,
            ok: false,
            error,
            mutation: {
              op: request.op,
              target: mutationTarget(request),
              outcome: 'refused',
              ...mutationAttempt(request),
            },
          }
        : failure(request.operationId, error);
    }

    const fetchImpl = options.fetch ?? globalThis.fetch;
    const token = options.token;
    const sleep = options.sleep ?? Bun.sleep;
    if (isMutationRequest(request)) {
      return await handleForgejoMutation(request, fetchImpl, token, sleep);
    }
    const read = readHandlers[request.op] as ReadHandler<ReadOp>;
    return await read(request, fetchImpl, token);
  } catch (cause) {
    return failure(request.operationId, forgejoErrorDetail(cause));
  }
}
