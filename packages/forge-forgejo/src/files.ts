/** Forgejo reads of a pull request's changed files and of one file's text at a commit. */

import { z } from 'zod';
import { prFileSchema, type ForgeRequest, type ForgeResponse } from '@archon/forge/operations';
import type { PrRef } from '@archon/forge';
import { ForgejoError, forgejoPagesWithTotal, forgejoRequest, location, type Fetch } from './api';

const pullSchema = z.object({
  head: z.object({ sha: z.string().min(1) }),
});

const pullFileSchema = z.object({
  filename: z.string().min(1),
  previous_filename: z.string().min(1).optional(),
  status: z.string().min(1),
});

type PrFile = z.infer<typeof prFileSchema>;
type PrFileStatus = PrFile['status'];

const STATUS_MAP: Record<string, PrFileStatus> = {
  added: 'added',
  removed: 'removed',
  deleted: 'removed',
  modified: 'modified',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
  unchanged: 'unchanged',
};

const nonFileSchema = z.union([
  z.array(z.unknown()),
  z.object({ type: z.string().refine(type => type !== 'file') }),
]);

const contentsSchema = z.object({
  type: z.literal('file'),
  encoding: z.string(),
  content: z.string(),
});

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

function diffBlockPath(block: string): string | null {
  const lines = block.split('\n');
  const plus = lines.find(line => line.startsWith('+++ '));
  if (plus && plus !== '+++ /dev/null') {
    const path = unquoteGitPath(plus.slice(4));
    return path.startsWith('b/') ? path.slice(2) : path;
  }
  const minus = lines.find(line => line.startsWith('--- '));
  if (minus && minus !== '--- /dev/null') {
    const path = unquoteGitPath(minus.slice(4));
    return path.startsWith('a/') ? path.slice(2) : path;
  }
  const header = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/.exec(lines[0] ?? '');
  return header ? header[2] : null;
}

/**
 * Split a unified `git diff` document into per-file patch hunks (starting at the first `@@`).
 * Binary or empty diffs yield no entry, so callers report `patch: null`.
 */
export function parseDiffPatches(diffText: string): Map<string, string> {
  const patches = new Map<string, string>();
  const normalized = diffText.replaceAll('\r\n', '\n');
  const blocks = normalized
    .split(/(?=^diff --git )/m)
    .filter(block => block.startsWith('diff --git '));
  for (const block of blocks) {
    const path = diffBlockPath(block);
    const hunkStart = block.indexOf('\n@@ ');
    if (path === null || hunkStart === -1) continue;
    patches.set(path, block.slice(hunkStart + 1).replace(/\n$/, ''));
  }
  return patches;
}

function normalizeStatus(status: string): PrFileStatus {
  const mapped = STATUS_MAP[status.toLowerCase()];
  if (!mapped) {
    throw new ForgejoError({
      kind: 'forge_error',
      message: `Forgejo reported unsupported pull request file status: ${status}`,
    });
  }
  return mapped;
}

/**
 * Every file a pull request changes, with the head the list belongs to.
 *
 * The files endpoint's own `X-Total-Count` is the completeness check. The pull
 * request's `changed_files` is not: Forgejo reports `0` once the head branch is
 * deleted and can stay stale after a force-push, so comparing against it refuses
 * a complete list. A list shorter than the endpoint's total, or one read while the
 * head moved, throws instead of answering.
 */
export async function readPullFiles(
  fetchImpl: Fetch,
  token: string,
  ref: PrRef
): Promise<{ head: string; files: PrFile[] }> {
  const { root, path } = location(ref.repo);
  const base = `${root}/repos/${path}/pulls/${String(ref.number)}`;
  const pull = pullSchema.parse(await forgejoRequest(fetchImpl, token, base));
  const [listed, diffText] = await Promise.all([
    forgejoPagesWithTotal(fetchImpl, token, `${base}/files`, value =>
      z.array(pullFileSchema).parse(value)
    ),
    forgejoRequest(
      fetchImpl,
      token,
      `${base}.diff`,
      { headers: { accept: 'text/plain' } },
      undefined,
      'text'
    ) as Promise<string>,
  ]);
  if (listed.totalCount !== null && listed.values.length !== listed.totalCount) {
    throw new ForgejoError({
      kind: 'forge_error',
      message: `Forgejo listed ${String(listed.values.length)} of the ${String(listed.totalCount)} files pull request ${String(ref.number)} changes`,
    });
  }
  const after = pullSchema.parse(await forgejoRequest(fetchImpl, token, base));
  if (after.head.sha !== pull.head.sha) {
    throw new ForgejoError({
      kind: 'forge_error',
      message: `Pull request ${String(ref.number)}'s head moved from ${pull.head.sha} to ${after.head.sha} while its files were read`,
    });
  }
  const patches = parseDiffPatches(diffText);
  return {
    head: pull.head.sha,
    files: listed.values.map(row => ({
      path: row.filename,
      previous_path: row.previous_filename ?? null,
      status: normalizeStatus(row.status),
      patch: patches.get(row.filename) ?? null,
    })),
  };
}

export async function handleForgejoPrFiles(
  request: Extract<ForgeRequest, { op: 'pr.files' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { head, files } = await readPullFiles(fetchImpl, token, request.ref);
  return {
    operationId: request.operationId,
    ok: true,
    result: { op: request.op, value: { ref: request.ref, head_revision: head, files } },
  };
}

export async function handleForgejoRepoFile(
  request: Extract<ForgeRequest, { op: 'repo.file' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const { root, path } = location(request.repo);
  const file = request.path.split('/').map(encodeURIComponent).join('/');
  const raw = await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/contents/${file}?ref=${encodeURIComponent(request.revision)}`
  );
  const at = `${request.path} at ${request.revision}`;
  if (nonFileSchema.safeParse(raw).success) {
    throw new ForgejoError({ kind: 'not_found', message: `${at} is not a file` }, true);
  }
  const contents = contentsSchema.parse(raw);
  if (contents.encoding !== 'base64') {
    throw new ForgejoError({
      kind: 'forge_error',
      message: `${at} is not returned with base64 encoding by Codeberg`,
    });
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(contents.content, 'base64')
    );
  } catch {
    throw new ForgejoError({ kind: 'forge_error', message: `${at} is not UTF-8 text` });
  }
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { repo: request.repo, path: request.path, revision: request.revision, text },
    },
  };
}
