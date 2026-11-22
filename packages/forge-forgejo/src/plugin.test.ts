import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { discoverPlugins } from '@archon/forge/discovery';
import { dispatchForge } from '@archon/forge/dispatch';

const pluginEntry = join(import.meta.dir, 'plugin.ts');

test('discovers the Forgejo plugin for codeberg.org and gitea.com and dispatches operations', async () => {
  const discovery = await discoverPlugins({
    config: { scanPath: false },
    sourcePlugins: [
      {
        name: 'forgejo',
        command: process.execPath,
        args: ['--no-env-file', pluginEntry],
      },
    ],
  });
  expect(discovery.byHost.get('codeberg.org')?.metadata.name).toBe('forgejo');
  expect(discovery.byHost.get('gitea.com')?.metadata.name).toBe('forgejo');

  const codebergResolve = await dispatchForge(
    { operationId: 'p-1', op: 'resolve', remote: 'git@codeberg.org:alice/project.git' },
    { discovery }
  );
  expect(codebergResolve.response).toMatchObject({
    ok: true,
    result: {
      op: 'resolve',
      value: {
        kind: 'resolved',
        forge: 'forgejo',
        repo: { host: 'codeberg.org', path: 'alice/project' },
      },
    },
  });

  const giteaResolve = await dispatchForge(
    {
      operationId: 'p-2',
      op: 'resolve',
      remote: 'https://gitea.com/org/repo/pulls/42',
      web: true,
    },
    { discovery }
  );
  expect(giteaResolve.response).toMatchObject({
    ok: true,
    result: {
      op: 'resolve',
      value: {
        kind: 'resolved',
        forge: 'forgejo',
        repo: { host: 'gitea.com', path: 'org/repo' },
        subject: { kind: 'pr', number: 42 },
      },
    },
  });

  const unsupported = await dispatchForge(
    {
      operationId: 'p-3',
      op: 'pr.thread.resolve',
      ref: { repo: { host: 'codeberg.org', path: 'alice/project' }, number: 42 },
      thread: 't-1',
    },
    { discovery, credentialEnv: { FORGEJO_TOKEN: 'tok' } }
  );
  expect(unsupported.response).toMatchObject({
    ok: false,
    error: { kind: 'unsupported_op' },
    mutation: { op: 'pr.thread.resolve', outcome: 'refused' },
  });
});

test('a multi-megabyte response reaches the host whole', async () => {
  const script = [
    `import { respond } from ${JSON.stringify(pluginEntry)};`,
    'void process.stdout.isTTY;',
    "await respond({ payload: 'x'.repeat(3_000_000) });",
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], { cwd: import.meta.dir });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  const code = await new Promise<number | null>(resolve => child.on('close', resolve));
  expect(code).toBe(0);
  const out = Buffer.concat(chunks).toString('utf8');
  expect((JSON.parse(out) as { payload: string }).payload).toHaveLength(3_000_000);
});
