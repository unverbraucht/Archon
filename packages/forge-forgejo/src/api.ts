/** The Forgejo/Gitea v1 REST boundary shared by this plugin's read and write operations. */

import { z } from 'zod';
import type { ForgeError } from '@archon/forge/operations';
import { parseRemoteUrl, type RepoRef } from '@archon/forge';

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The wait between repeated reads; tests replace it so they do not sleep. */
export type Sleep = (ms: number) => Promise<unknown>;

/** Forgejo/Gitea's default maximum page size on list endpoints. */
export const PAGE_LIMIT = 50;

export class ForgejoError extends Error {
  constructor(
    readonly detail: ForgeError,
    /**
     * Whether the forge decided against the request rather than losing it. A 4xx is
     * the forge's own answer, so nothing was written; anything else leaves a
     * submitted write's fate unknown.
     */
    readonly definitiveRefusal = false,
    options?: ErrorOptions
  ) {
    super(detail.message, options);
  }
}

export function repositoryPath(path: string): { owner: string; repo: string } | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const repo = parts[1].endsWith('.git') ? parts[1].slice(0, -4) : parts[1];
  if ([owner, repo].some(part => part === '' || part === '.' || part === '..')) return null;
  return { owner, repo };
}

export function forgejoRepository(repo: RepoRef): { owner: string; repo: string } {
  const parsed = repositoryPath(repo.path);
  if (!parsed) {
    throw new ForgejoError(
      { kind: 'invalid_request', message: `Invalid Forgejo repository path: ${repo.path}` },
      true
    );
  }
  return parsed;
}

function validateHost(host: string): string {
  const normalized = host.trim().toLowerCase();
  if (!normalized || /[/\\?#@\s]/.test(normalized)) {
    throw new ForgejoError(
      { kind: 'invalid_request', message: `Invalid Forgejo host: ${host}` },
      true
    );
  }
  let url: URL;
  try {
    url = new URL(`https://${normalized}`);
  } catch {
    throw new ForgejoError(
      { kind: 'invalid_request', message: `Invalid Forgejo host: ${host}` },
      true
    );
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ForgejoError(
      { kind: 'invalid_request', message: `Invalid Forgejo host: ${host}` },
      true
    );
  }
  return normalized;
}

/** The REST v1 root, web root, and encoded `owner/repo` segment for one qualified repository. */
export function location(repo: RepoRef): {
  root: string;
  webRoot: string;
  path: string;
  owner: string;
  repo: string;
} {
  const parsed = forgejoRepository(repo);
  const host = validateHost(repo.host);
  return {
    root: `https://${host}/api/v1`,
    webRoot: `https://${host}`,
    path: `${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    owner: parsed.owner,
    repo: parsed.repo,
  };
}

/** One authenticated Forgejo/Gitea API call, answered with any status or lost in transit. */
export async function forgejoSend(
  fetchImpl: Fetch,
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const extraHeaders =
    init.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : Array.isArray(init.headers)
        ? Object.fromEntries(init.headers)
        : (init.headers ?? {});
  try {
    return await fetchImpl(url, {
      ...init,
      headers: {
        accept: 'application/json',
        authorization: `token ${token}`,
        'content-type': 'application/json',
        'user-agent': 'archon-forge-forgejo',
        ...extraHeaders,
      },
    });
  } catch (cause) {
    throw new ForgejoError({ kind: 'unavailable', message: 'Forgejo API request failed' }, false, {
      cause,
    });
  }
}

/**
 * One Forgejo/Gitea API call.
 *
 * `acknowledge` runs once the forge has answered with a success status, which is the
 * moment a write stops being merely submitted and becomes one whose effect must
 * be verified rather than guessed at.
 */
export async function forgejoRequest(
  fetchImpl: Fetch,
  token: string,
  url: string,
  init: RequestInit = {},
  acknowledge?: () => void,
  responseMode: 'json' | 'text' | 'empty' = 'json'
): Promise<unknown> {
  const response = await forgejoSend(fetchImpl, token, url, init);
  if (!response.ok) {
    throw forgejoResponseError(response);
  }
  acknowledge?.();
  if (responseMode === 'empty') return undefined;
  if (responseMode === 'text') return await response.text();
  try {
    return await response.json();
  } catch (cause) {
    throw new ForgejoError(
      { kind: 'forge_error', message: 'Forgejo API returned invalid JSON' },
      false,
      { cause }
    );
  }
}

function hasNextLink(header: string | null): boolean {
  return header !== null && /;\s*rel="next"/.test(header);
}

/** Paginate a Forgejo/Gitea list endpoint until the final page is reached. */
export async function forgejoPages<T>(
  fetchImpl: Fetch,
  token: string,
  baseUrl: string,
  readPage: (value: unknown) => readonly T[],
  limit = PAGE_LIMIT
): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; ; page++) {
    const separator = baseUrl.includes('?') ? '&' : '?';
    const response = await forgejoSend(
      fetchImpl,
      token,
      `${baseUrl}${separator}limit=${String(limit)}&page=${String(page)}`
    );
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
    const rows = readPage(raw);
    values.push(...rows);
    const link = response.headers.get('link');
    if (link !== null) {
      if (!hasNextLink(link) || rows.length === 0) return values;
    } else if (rows.length < limit) {
      return values;
    }
  }
}

function parseUrlRemote(value: string): RepoRef | null {
  let parsed: ReturnType<typeof parseRemoteUrl>;
  try {
    parsed = parseRemoteUrl(value);
  } catch (cause) {
    throw new ForgejoError(
      { kind: 'invalid_request', message: 'Forgejo remote is not a valid URL' },
      true,
      { cause }
    );
  }
  const { url, host, pathname } = parsed;
  if (!['http:', 'https:', 'ssh:'].includes(url.protocol)) return null;
  if (url.password !== '' || (url.protocol !== 'ssh:' && url.username !== '')) {
    throw new ForgejoError(
      { kind: 'invalid_request', message: 'Forgejo remote must not contain credentials' },
      true
    );
  }
  if (value.includes('?') || value.includes('#')) {
    throw new ForgejoError(
      {
        kind: 'invalid_request',
        message: 'Forgejo remote must not contain a query or fragment',
      },
      true
    );
  }
  const decodedPath = decodeURIComponent(pathname);
  const repository =
    (url.protocol === 'ssh:' || !decodedPath.includes('\\')) &&
    repositoryPath(decodedPath) &&
    repositoryPath(decodeURIComponent(url.pathname));
  if (!repository) return null;
  return { host, path: `${repository.owner}/${repository.repo}` };
}

export function parseRemote(remote: string | null): RepoRef | null {
  if (!remote?.trim()) return null;
  const value = remote.trim();
  if (value.includes('://')) return parseUrlRemote(value);

  // Git's SCP-like SSH form has no URL scheme. Its optional user is transport identity,
  // not an HTTP credential, and is deliberately discarded at this normalization boundary.
  const match = /^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/.exec(value);
  if (!match) return null;
  const repository = repositoryPath(match[2]);
  if (!repository) return null;
  return { host: match[1].toLowerCase(), path: `${repository.owner}/${repository.repo}` };
}

/**
 * Forgejo/Gitea web URL of an issue or pull request: `<repository>/issues/<n>` or
 * `<repository>/pulls/<n>`. A query or fragment, such as a link to one comment, is
 * ignored; any other URL is not a subject.
 */
export function parseSubjectUrl(
  value: string | null
): { repo: RepoRef; subject: { kind: 'issue' | 'pr'; number: number } } | null {
  const trimmed = value?.trim().replace(/[?#].*$/, '') ?? '';
  const match = /^(https?:\/\/.+)\/(issues|pulls)\/([1-9]\d*)\/?$/.exec(trimmed);
  if (!match) return null;
  const repo = parseUrlRemote(match[1]);
  if (!repo) return null;
  return {
    repo,
    subject: { kind: match[2] === 'pulls' ? 'pr' : 'issue', number: Number(match[3]) },
  };
}

/** Translate a thrown cause into the wire error a caller can act on. */
export function forgejoErrorDetail(cause: unknown): ForgeError {
  if (cause instanceof ForgejoError) return cause.detail;
  if (cause instanceof z.ZodError) {
    return {
      kind: 'forge_error',
      message: `Forgejo API response did not match its documented shape: ${cause.issues[0]?.message ?? 'invalid response'}`,
    };
  }
  return {
    kind: 'forge_error',
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * Forgejo/Gitea answers a rate limit with 429, or with 403 carrying `retry-after`,
 * `x-ratelimit-remaining: 0`, or an IETF `ratelimit` header with `r=0`.
 */
function rateLimited({ status, headers }: Response): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    headers.has('retry-after') ||
    headers.get('x-ratelimit-remaining') === '0' ||
    /(?:^|;)\s*r=0(?:;|$)/.test(headers.get('ratelimit') ?? '')
  );
}

function responseKind(response: Response): ForgeError['kind'] {
  const { status } = response;
  if (rateLimited(response)) return 'rate_limited';
  if (status >= 500) return 'unavailable';
  if (status === 404) return 'not_found';
  if (status === 401 || status === 403) return 'authorization';
  if (status === 405 || status === 409 || status === 422) return 'conflict';
  return 'forge_error';
}

export function forgejoResponseError(response: Response): ForgejoError {
  return new ForgejoError(
    {
      kind: responseKind(response),
      message: `Forgejo API request failed with HTTP ${String(response.status)}`,
      status: response.status,
    },
    response.status >= 400 && response.status < 500
  );
}
