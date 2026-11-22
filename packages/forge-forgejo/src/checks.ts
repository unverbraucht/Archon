/**
 * Checks on Forgejo and Gitea: `checks.state`, `checks.commit`, `checks.logs`, and `checks.rerun`.
 *
 * Combines Actions runs/jobs (`kind: 'check'`) with commit statuses (`kind: 'commit_status'`).
 * Supports both Forgejo's native Actions payloads (`commit_sha`, `attempt`, bare job array,
 * `/actions/jobs/{id}/rerun`) and Gitea's GitHub-shaped payloads (`head_sha`, `run_attempt`,
 * `conclusion`, `{ jobs }` wrapper, `/actions/runs/{run}/jobs/{id}/rerun`).
 */

import { z } from 'zod';
import {
  CHECKS_LOGS_DEFAULT_BYTES,
  concludedCheckStates,
  summarizeChecks,
  type CheckObservation,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
  type SelectedCheck,
} from '@archon/forge/operations';
import type { CheckResult, RepoRef } from '@archon/forge';
import {
  ForgejoError,
  PAGE_LIMIT,
  forgejoErrorDetail,
  forgejoPages,
  forgejoRequest,
  forgejoResponseError,
  forgejoSend,
  location,
  type Fetch,
  type Sleep,
} from './api';
import { failure } from './mutation-outcome';

const READ_BACK_WAITS_MS = [1_000, 2_000, 3_000, 4_000, 5_000];
const RERUNNABLE_RESULTS = new Set<CheckResult>(['failure', 'cancelled', 'timed_out']);

const pullHeadSchema = z.object({ head: z.object({ sha: z.string().min(1) }) });
const repoDefaultBranchSchema = z.object({ default_branch: z.string().min(1).optional() });
const branchHeadSchema = z.object({
  name: z.string().min(1),
  commit: z.object({ id: z.string().min(1) }),
});

const statusSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  context: z.string().min(1),
  status: z.string().min(1),
  target_url: z.string().nullable().optional(),
});
type CommitStatus = z.infer<typeof statusSchema>;

const actionRunSchema = z.object({
  id: z.number().int(),
  index_in_repo: z.number().int().optional(),
  run_number: z.number().int().optional(),
  workflow_id: z.string().optional(),
  path: z.string().optional(),
  commit_sha: z.string().optional(),
  head_sha: z.string().optional(),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
  need_approval: z.boolean().optional(),
});
type ActionRun = z.infer<typeof actionRunSchema>;

const actionRunListSchema = z.object({
  total_count: z.number().int().nonnegative().optional(),
  workflow_runs: z.array(actionRunSchema).nullable().optional(),
});

const actionJobSchema = z.object({
  id: z.number().int(),
  run_id: z.number().int(),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable().optional(),
  attempt: z.number().int().nonnegative().optional(),
  run_attempt: z.number().int().nonnegative().optional(),
});
type ActionJob = z.infer<typeof actionJobSchema>;

const actionJobListSchema = z.union([
  z.array(actionJobSchema),
  z.object({ jobs: z.array(actionJobSchema).nullable() }).transform(value => value.jobs ?? []),
]);

const TERMINAL_RESULTS: Record<string, CheckResult> = {
  success: 'success',
  neutral: 'neutral',
  skipped: 'skipped',
  action_required: 'action_required',
  failure: 'failure',
  cancelled: 'cancelled',
  timed_out: 'timed_out',
  stale: 'stale',
  startup_failure: 'startup_failure',
};

const PENDING_STATUSES = new Set(['waiting', 'blocked', 'queued', 'pending']);
const RUNNING_STATUSES = new Set(['running', 'in_progress']);

function runCommitSha(run: ActionRun): string | undefined {
  return run.commit_sha || run.head_sha || undefined;
}

function runIndex(run: ActionRun): number | undefined {
  return run.index_in_repo ?? run.run_number;
}

function jobAttempt(job: ActionJob): number {
  return job.attempt ?? job.run_attempt ?? 0;
}

/** Gitea's job schema exposes `run_attempt` (and no `attempt`), routing reruns under `/runs/{run}`. */
function isGiteaJob(job: ActionJob): boolean {
  return job.run_attempt !== undefined && job.attempt === undefined;
}

function mapJobStatus(
  status: string,
  conclusion?: string | null
): {
  phase: CheckObservation['phase'];
  nativeResult: string | null;
  result: CheckResult | null;
  state: CheckObservation['state'];
} {
  const normalized = status.toLowerCase();
  if (PENDING_STATUSES.has(normalized)) {
    return { phase: 'pending', nativeResult: null, result: null, state: 'pending' };
  }
  if (RUNNING_STATUSES.has(normalized)) {
    return { phase: 'running', nativeResult: null, result: null, state: 'pending' };
  }
  const outcome = normalized === 'completed' ? (conclusion ?? '') : status;
  const result = TERMINAL_RESULTS[outcome.toLowerCase()];
  if (result) {
    return {
      phase: 'completed',
      nativeResult: outcome,
      result,
      state: concludedCheckStates[result],
    };
  }
  return {
    phase: normalized === 'completed' ? 'completed' : 'unknown',
    nativeResult: outcome || null,
    result: 'unknown',
    state: 'unknown',
  };
}

function jobObservation(job: ActionJob): CheckObservation {
  const mapped = mapJobStatus(job.status, job.conclusion);
  const attempt = jobAttempt(job);
  return {
    unit: { kind: 'check', id: String(job.id), name: job.name },
    nativeState: job.status,
    phase: mapped.phase,
    nativeResult: mapped.nativeResult,
    result: mapped.result,
    state: mapped.state,
    rerun: attempt > 0 ? { id: String(job.id), attempt } : null,
  };
}

const COMMIT_STATUS_MAP: Record<
  string,
  { state: CheckObservation['state']; phase: CheckObservation['phase']; result: CheckResult | null }
> = {
  pending: { state: 'pending', phase: 'pending', result: null },
  success: { state: 'green', phase: 'completed', result: 'success' },
  skipped: { state: 'green', phase: 'completed', result: 'skipped' },
  failure: { state: 'red', phase: 'completed', result: 'failure' },
  error: { state: 'red', phase: 'completed', result: 'failure' },
};

function statusObservation(status: CommitStatus): CheckObservation {
  const mapped = COMMIT_STATUS_MAP[status.status.toLowerCase()] ?? {
    state: 'unknown' as const,
    phase: 'unknown' as const,
    result: 'unknown' as const,
  };
  return {
    unit: { kind: 'commit_status', id: String(status.id), name: status.context },
    nativeState: status.status,
    phase: mapped.phase,
    nativeResult: status.status,
    result: mapped.result,
    state: mapped.state,
    rerun: null,
  };
}

/** Read all Actions runs on `revision`, or `null` when Actions is disabled (404). */
async function readActionRuns(
  fetchImpl: Fetch,
  token: string,
  root: string,
  path: string,
  revision: string
): Promise<ActionRun[] | null> {
  const runs: ActionRun[] = [];
  for (let page = 1; ; page++) {
    const response = await forgejoSend(
      fetchImpl,
      token,
      `${root}/repos/${path}/actions/runs?head_sha=${encodeURIComponent(revision)}&limit=${String(PAGE_LIMIT)}&page=${String(page)}`
    );
    if (response.status === 404) return page === 1 ? null : runs;
    if (!response.ok) throw forgejoResponseError(response);
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (cause) {
      throw new ForgejoError(
        { kind: 'forge_error', message: 'Forgejo API returned invalid JSON' },
        false,
        { cause }
      );
    }
    const entries = actionRunListSchema.parse(raw).workflow_runs ?? [];
    runs.push(...entries.filter(run => runCommitSha(run) === revision));
    if (entries.length < PAGE_LIMIT) return runs;
  }
}

function latestRunsByWorkflow(runs: readonly ActionRun[]): ActionRun[] {
  const newest = new Map<string, ActionRun>();
  for (const run of runs) {
    const key = run.workflow_id || run.path || `run:${String(run.id)}`;
    const current = newest.get(key);
    if (!current || run.id > current.id) newest.set(key, run);
  }
  return [...newest.values()];
}

function isActionsDuplicateStatus(
  status: CommitStatus,
  repoPath: string,
  runIndices: ReadonlySet<number>
): boolean {
  if (!status.target_url || runIndices.size === 0) return false;
  const escaped = repoPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`/${escaped}/actions/runs/(\\d+)(?:/|$)`, 'i').exec(status.target_url);
  return match !== null && runIndices.has(Number(match[1]));
}

function deriveApprovalPending(
  allRuns: readonly ActionRun[] | null,
  units: readonly CheckObservation[]
): boolean | null {
  if (allRuns === null) return null;
  if (
    allRuns.some(run => run.need_approval === true || run.conclusion === 'action_required') ||
    units.some(unit => unit.result === 'action_required')
  ) {
    return true;
  }
  if (allRuns.length === 0 || allRuns.some(run => run.need_approval !== undefined)) return false;
  return null;
}

async function readCommitChecks(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef,
  revision: string
): Promise<{
  units: CheckObservation[];
  summary: ReturnType<typeof summarizeChecks>;
  approvalPending: boolean | null;
}> {
  const { root, path } = location(repo);
  const ref = encodeURIComponent(revision);
  const [allStatuses, allRuns] = await Promise.all([
    forgejoPages(fetchImpl, token, `${root}/repos/${path}/commits/${ref}/statuses`, value =>
      z.array(statusSchema).parse(value)
    ),
    readActionRuns(fetchImpl, token, root, path, revision),
  ]);

  const latestRuns = allRuns ? latestRunsByWorkflow(allRuns) : [];
  const jobBatches = await Promise.all(
    latestRuns.map(run =>
      forgejoRequest(
        fetchImpl,
        token,
        `${root}/repos/${path}/actions/runs/${String(run.id)}/jobs`
      ).then(raw => actionJobListSchema.parse(raw))
    )
  );
  const jobs = jobBatches.flat();
  const enumeratedIndices = new Set(
    (allRuns ?? []).map(runIndex).filter((index): index is number => index !== undefined)
  );

  const seenContexts = new Set<string>();
  const externalStatuses = allStatuses.filter(status => {
    const key = status.context.toLowerCase();
    if (seenContexts.has(key)) return false;
    seenContexts.add(key);
    return !isActionsDuplicateStatus(status, repo.path, enumeratedIndices);
  });

  const units = [...jobs.map(jobObservation), ...externalStatuses.map(statusObservation)];
  return {
    units,
    summary: summarizeChecks(units),
    approvalPending: deriveApprovalPending(allRuns, units),
  };
}

export async function handleForgejoChecksState(
  request: Extract<ForgeRequest, { op: 'checks.state' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.ref.repo);
  const pull = pullHeadSchema.parse(
    await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/pulls/${String(request.ref.number)}`
    )
  );
  const revision = pull.head.sha;
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'checks.state',
      value: {
        ref: request.ref,
        revision,
        ...(await readCommitChecks(fetchImpl, token, request.ref.repo, revision)),
        required: null,
      },
    },
  };
}

async function defaultBranchHead(
  fetchImpl: Fetch,
  token: string,
  repo: RepoRef
): Promise<{ branch: string; revision: string } | null> {
  const { root, path } = location(repo);
  const repository = repoDefaultBranchSchema.parse(
    await forgejoRequest(fetchImpl, token, `${root}/repos/${path}`)
  );
  if (!repository.default_branch) return null;
  const branch = branchHeadSchema.parse(
    await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/branches/${encodeURIComponent(repository.default_branch)}`
    )
  );
  return { branch: branch.name, revision: branch.commit.id };
}

export async function handleForgejoChecksCommit(
  request: Extract<ForgeRequest, { op: 'checks.commit' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const at =
    request.at.kind === 'revision'
      ? { branch: null, revision: request.at.revision }
      : await defaultBranchHead(fetchImpl, token, request.repo);
  if (!at) {
    return failure(request.operationId, {
      kind: 'not_found',
      message: `${request.repo.path} reports no default branch`,
    });
  }
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'checks.commit',
      value: {
        repo: request.repo,
        ...at,
        ...(await readCommitChecks(fetchImpl, token, request.repo, at.revision)),
      },
    },
  };
}

function utf8Tail(bytes: Buffer, cap: number, cut = false): Buffer {
  let start = Math.max(0, bytes.length - cap);
  if (start === 0 && !cut) return bytes;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start);
}

async function readTail(response: Response, cap: number): Promise<{ tail: Buffer; total: number }> {
  const kept: Uint8Array[] = [];
  let size = 0;
  let total = 0;
  const reader = response.body?.getReader();
  try {
    for (let read = await reader?.read(); read && !read.done; read = await reader?.read()) {
      kept.push(read.value);
      size += read.value.length;
      total += read.value.length;
      while (kept.length > 1 && size - kept[0].length >= cap) size -= kept.shift()?.length ?? 0;
    }
  } catch (cause) {
    throw new ForgejoError(
      { kind: 'unavailable', message: 'Forgejo log download was cut off' },
      false,
      { cause }
    );
  }
  return { tail: utf8Tail(Buffer.concat(kept), cap, total > size), total };
}

export async function handleForgejoChecksLogs(
  request: Extract<ForgeRequest, { op: 'checks.logs' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const answer = (
    log: Extract<
      Extract<ForgeResponse, { ok: true }>['result'],
      { op: 'checks.logs' }
    >['value']['log']
  ): ForgeResponse => ({
    operationId: request.operationId,
    ok: true,
    result: { op: request.op, value: { repo: request.repo, unit: request.unit, log } },
  });
  if (request.unit.kind !== 'check') return answer({ kind: 'none', reason: 'unit_has_no_log' });
  const { root, path } = location(request.repo);
  const id = encodeURIComponent(request.unit.id);
  actionJobSchema.parse(
    await forgejoRequest(fetchImpl, token, `${root}/repos/${path}/actions/jobs/${id}`)
  );
  const response = await forgejoSend(
    fetchImpl,
    token,
    `${root}/repos/${path}/actions/jobs/${id}/logs`,
    { headers: { accept: 'text/plain' } }
  );
  if (response.status === 404 || response.status === 410) {
    return answer({ kind: 'none', reason: 'log_unavailable' });
  }
  if (!response.ok) throw forgejoResponseError(response);
  const cap = request.maxBytes ?? CHECKS_LOGS_DEFAULT_BYTES;
  const { tail, total } = await readTail(response, cap);
  const decoded = Buffer.from(tail.toString('utf8'));
  const text = utf8Tail(decoded, cap);
  return answer({
    kind: 'text',
    text: text.toString('utf8'),
    truncated: total > tail.length || text.length < decoded.length,
    totalBytes: total,
  });
}

type RerunRequest = Extract<ForgeMutationRequest, { op: 'checks.rerun' }>;

interface RerunContext {
  fetchImpl: Fetch;
  token: string;
  base: string;
  revision: string;
  sleep: Sleep;
  readBackWaits: Iterator<number>;
}

interface RerunProgress {
  observed: SelectedCheck[];
  acknowledged: boolean;
  submitted: boolean;
  currentAcknowledged: boolean;
}

function refuseRerun(message: string, kind: 'conflict' | 'unsupported_op' = 'conflict'): never {
  throw new ForgejoError({ kind, message }, true);
}

function isEligibleRerunJob(job: ActionJob, selected: SelectedCheck): boolean {
  const mapped = mapJobStatus(job.status, job.conclusion);
  return (
    selected.rerun !== null &&
    String(job.id) === selected.unit.id &&
    String(job.id) === selected.rerun.id &&
    job.name === selected.unit.name &&
    jobAttempt(job) === selected.rerun.attempt &&
    mapped.phase === 'completed' &&
    mapped.result !== null &&
    RERUNNABLE_RESULTS.has(mapped.result)
  );
}

async function validateRerunUnit(
  ctx: RerunContext,
  selected: SelectedCheck
): Promise<{ jobId: string; attempt: number; runId: number; giteaRoute: boolean }> {
  if (selected.unit.kind !== 'check' || !selected.rerun) {
    refuseRerun('Selected unit does not support reruns', 'unsupported_op');
  }
  const job = actionJobSchema.parse(
    await forgejoRequest(
      ctx.fetchImpl,
      ctx.token,
      `${ctx.base}/actions/jobs/${encodeURIComponent(selected.unit.id)}`
    )
  );
  if (!isEligibleRerunJob(job, selected)) {
    refuseRerun('Selected check is not an eligible failed check at the requested attempt');
  }
  const run = actionRunSchema.parse(
    await forgejoRequest(ctx.fetchImpl, ctx.token, `${ctx.base}/actions/runs/${String(job.run_id)}`)
  );
  if (runCommitSha(run) !== ctx.revision) {
    refuseRerun('Workflow run does not belong to the requested revision');
  }
  return {
    jobId: String(job.id),
    attempt: selected.rerun.attempt,
    runId: job.run_id,
    giteaRoute: isGiteaJob(job),
  };
}

async function waitForNewerAttempt(
  ctx: RerunContext,
  jobId: string,
  runId: number,
  previousAttempt: number
): Promise<number> {
  for (;;) {
    const job = actionJobSchema.parse(
      await forgejoRequest(
        ctx.fetchImpl,
        ctx.token,
        `${ctx.base}/actions/jobs/${encodeURIComponent(jobId)}`
      )
    );
    if (String(job.id) !== jobId || job.run_id !== runId) {
      throw new ForgejoError({
        kind: 'invalid_response',
        message: 'Job rerun read-back returned a different job than the one rerun',
      });
    }
    const observedAttempt = jobAttempt(job);
    if (observedAttempt > previousAttempt) return observedAttempt;
    const wait = ctx.readBackWaits.next();
    if (wait.done) {
      throw new ForgejoError({
        kind: 'invalid_response',
        message:
          'Forgejo accepted the job rerun, but the job showed no newer attempt in the time waited',
      });
    }
    await ctx.sleep(wait.value);
  }
}

function rerunFailureOutcome(
  progress: RerunProgress,
  cause: unknown
): 'refused' | 'verification_failed' | 'outcome_unknown' {
  const definitive = cause instanceof ForgejoError && cause.definitiveRefusal;
  if (
    progress.currentAcknowledged ||
    (progress.acknowledged && (!progress.submitted || definitive))
  ) {
    return 'verification_failed';
  }
  return progress.submitted && !definitive ? 'outcome_unknown' : 'refused';
}

export async function handleForgejoChecksRerun(
  request: RerunRequest,
  fetchImpl: Fetch,
  token: string,
  sleep: Sleep
): Promise<ForgeResponse> {
  const progress: RerunProgress = {
    observed: [],
    acknowledged: false,
    submitted: false,
    currentAcknowledged: false,
  };
  try {
    const { root, path } = location(request.ref.repo);
    const ctx: RerunContext = {
      fetchImpl,
      token,
      base: `${root}/repos/${path}`,
      revision: request.revision,
      sleep,
      readBackWaits: READ_BACK_WAITS_MS.values(),
    };
    const pull = pullHeadSchema.parse(
      await forgejoRequest(fetchImpl, token, `${ctx.base}/pulls/${String(request.ref.number)}`)
    );
    if (pull.head.sha !== ctx.revision) {
      refuseRerun('Pull request head differs from rerun revision');
    }
    const eligible = [];
    for (const selected of request.units) {
      eligible.push({ selected, info: await validateRerunUnit(ctx, selected) });
    }
    for (const { selected, info } of eligible) {
      progress.submitted = true;
      progress.currentAcknowledged = false;
      const rerunUrl = info.giteaRoute
        ? `${ctx.base}/actions/runs/${String(info.runId)}/jobs/${encodeURIComponent(info.jobId)}/rerun`
        : `${ctx.base}/actions/jobs/${encodeURIComponent(info.jobId)}/rerun`;
      await forgejoRequest(
        fetchImpl,
        token,
        rerunUrl,
        { method: 'POST' },
        () => {
          progress.acknowledged = true;
          progress.currentAcknowledged = true;
        },
        'empty'
      );
      const attempt = await waitForNewerAttempt(ctx, info.jobId, info.runId, info.attempt);
      progress.observed.push({ unit: selected.unit, rerun: { id: info.jobId, attempt } });
      progress.submitted = false;
    }
    return {
      operationId: request.operationId,
      ok: true,
      result: {
        op: request.op,
        value: {
          target: request.ref,
          outcome: 'applied',
          changed: true,
          ref: request.ref,
          revision: request.revision,
          units: progress.observed,
        },
      },
    };
  } catch (cause) {
    const outcome = rerunFailureOutcome(progress, cause);
    return {
      operationId: request.operationId,
      ok: false,
      error: forgejoErrorDetail(cause),
      mutation: {
        op: request.op,
        target: request.ref,
        ...(outcome === 'verification_failed'
          ? { outcome, leaveBehind: 'acknowledged workflow reruns may remain' }
          : { outcome }),
        rerun: {
          revision: request.revision,
          requested: request.units,
          observed: progress.observed,
        },
      },
    };
  }
}
