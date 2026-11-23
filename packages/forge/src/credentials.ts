import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { GH_DOTCOM_TOKEN_KEYS, GH_ENTERPRISE_TOKEN_KEYS } from '@archon/paths/github-token-env';

const execFileAsync = promisify(execFile);

export type ForgeCliFallback = 'gh' | 'tea';

type ResolvedForgeCredential =
  | { kind: 'selected'; token: string; source: string }
  | { kind: 'none' }
  | { kind: 'missing' | 'failed'; message: string };

async function readCliCredential(
  cliFallback: ForgeCliFallback | undefined,
  names: readonly string[],
  host: string,
  credentialEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv,
  refreshApp: boolean
): Promise<ResolvedForgeCredential | undefined> {
  if (cliFallback === 'gh') return readGhCredential(host, credentialEnv, hostEnv, refreshApp);
  if (cliFallback === 'tea') return readTeaCredential(host, hostEnv, names);
  return undefined;
}

export async function selectCredential(
  names: readonly string[],
  cliFallback: ForgeCliFallback | undefined,
  host: string,
  credentialEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv
): Promise<ResolvedForgeCredential> {
  // The App-owned PATH shim refreshes installation tokens per operation. Preserve
  // its dispatch token so the shim recognizes App mode; personal tokens bypass it.
  const refreshApp =
    cliFallback === 'gh' &&
    host === 'github.com' &&
    Boolean(credentialEnv.ARCHON_GITHUB_APP_REPO && credentialEnv.ARCHON_PORT) &&
    credentialEnv.GH_TOKEN?.startsWith('ghs_') === true;
  for (const name of names) {
    const token = credentialEnv[name];
    if (token && !refreshApp) return { kind: 'selected', token, source: name };
  }
  // Empty values are also the engine's per-user credential scrub. Never borrow
  // the host login when a run was explicitly denied a credential.
  if (!refreshApp && names.some(name => credentialEnv[name] !== undefined)) {
    return { kind: 'missing', message: `credential environment ${names.join(' or ')} is empty` };
  }
  const credential = await readCliCredential(
    cliFallback,
    names,
    host,
    credentialEnv,
    hostEnv,
    refreshApp
  );
  if (credential) return credential;
  if (names.length === 0) {
    return cliFallback
      ? { kind: 'missing', message: `no credential is configured; ${cliFallback} is not installed` }
      : { kind: 'none' };
  }
  const suffix = cliFallback ? `; ${cliFallback} is not installed` : '';
  return {
    kind: 'missing',
    message: `credential environment ${names.join(' or ')} is not set${suffix}`,
  };
}

async function readGhCredential(
  host: string,
  credentialEnv: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv,
  refreshApp: boolean
): Promise<ResolvedForgeCredential | undefined> {
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', host], {
      env: {
        ...hostEnv,
        PATH: hostEnv.PATH ?? '',
        ...Object.fromEntries(GH_ENTERPRISE_TOKEN_KEYS.map(key => [key, ''])),
        ...Object.fromEntries(
          GH_DOTCOM_TOKEN_KEYS.map(key => [key, refreshApp ? credentialEnv[key] : ''])
        ),
      },
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    });
    const token = stdout.trim();
    return token
      ? { kind: 'selected', token, source: 'gh auth token' }
      : { kind: 'failed', message: `gh auth token --hostname ${host} returned an empty token` };
  } catch (error) {
    // gh's stdout, stderr and error message may contain credentials.
    if (refreshApp || !(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
      return {
        kind: 'failed',
        message: `gh auth token --hostname ${host} failed; repair the gh login`,
      };
    }
  }
  return undefined;
}

function parseGitCredentialPassword(stdout: string): string {
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('password=')) return line.slice('password='.length).trim();
  }
  return '';
}

/**
 * Resolve a stored Codeberg/Forgejo token via `tea logins helper get` (git credential
 * protocol). Stdout, stderr, and spawn errors are never echoed in error messages.
 */
async function readTeaCredential(
  host: string,
  hostEnv: NodeJS.ProcessEnv,
  names: readonly string[]
): Promise<ResolvedForgeCredential | undefined> {
  const result = await new Promise<
    { kind: 'enoent' } | { kind: 'failed' } | { kind: 'ok'; stdout: string }
  >(resolve => {
    let settled = false;
    const finish = (
      outcome: { kind: 'enoent' } | { kind: 'failed' } | { kind: 'ok'; stdout: string }
    ): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('tea', ['logins', 'helper', 'get'], {
        env: { ...hostEnv, PATH: hostEnv.PATH ?? '' },
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      finish(code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'failed' });
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'failed' });
    }, 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      const code = 'code' in error ? error.code : undefined;
      finish(code === 'ENOENT' ? { kind: 'enoent' } : { kind: 'failed' });
    });
    child.on('close', exitCode => {
      clearTimeout(timer);
      if (exitCode !== 0 || bytes > 1024 * 1024) {
        finish({ kind: 'failed' });
      } else {
        finish({ kind: 'ok', stdout: Buffer.concat(chunks).toString('utf8') });
      }
    });
    child.stdin?.on('error', () => {
      // Ignore EPIPE if tea exits before reading stdin.
    });
    child.stdin?.end(`protocol=https\nhost=${host}\n\n`);
  });
  if (result.kind === 'enoent') return undefined;
  if (result.kind === 'failed') {
    const alternative = names.length > 0 ? ` or set ${names.join(' or ')}` : '';
    return {
      kind: 'failed',
      message: `tea logins helper get for ${host} failed; repair the tea login${alternative}`,
    };
  }
  const token = parseGitCredentialPassword(result.stdout);
  return token
    ? { kind: 'selected', token, source: 'tea logins helper' }
    : { kind: 'failed', message: `tea logins helper get for ${host} returned an empty token` };
}
