import { describe, expect, test as bunTest } from 'bun:test';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { trackTempRoots } from '@archon/paths/test-utils';
import { selectCredential } from './credentials';

const trackTempRoot = trackTempRoots();
const CODEBERG_KEYS = ['CODEBERG_TOKEN', 'FORGEJO_TOKEN', 'GITEA_TOKEN'] as const;
const test = bunTest.skipIf(process.platform === 'win32');

function makeTeaStub(script: string): string {
  const dir = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-tea-cred-')));
  const bin = join(dir, 'tea');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

describe('tea CLI credential fallback', () => {
  test('prefers explicit environment variables in order over tea login', async () => {
    const dir = makeTeaStub('exit 99');
    const first = await selectCredential(
      CODEBERG_KEYS,
      'tea',
      'codeberg.org',
      { CODEBERG_TOKEN: 'cb-tok', FORGEJO_TOKEN: 'fj-tok' },
      { PATH: dir }
    );
    expect(first).toEqual({ kind: 'selected', token: 'cb-tok', source: 'CODEBERG_TOKEN' });

    const second = await selectCredential(
      CODEBERG_KEYS,
      'tea',
      'codeberg.org',
      { FORGEJO_TOKEN: 'fj-tok', GITEA_TOKEN: 'gt-tok' },
      { PATH: dir }
    );
    expect(second).toEqual({ kind: 'selected', token: 'fj-tok', source: 'FORGEJO_TOKEN' });
  });

  test('refuses an explicitly empty credential without consulting tea', async () => {
    const dir = makeTeaStub('printf "password=should-not-use\\n"');
    const result = await selectCredential(
      CODEBERG_KEYS,
      'tea',
      'codeberg.org',
      { CODEBERG_TOKEN: '' },
      { PATH: dir }
    );
    expect(result).toMatchObject({ kind: 'missing' });
  });

  test('reads password from tea logins helper get via git credential protocol', async () => {
    const dir = makeTeaStub(
      'host=""; while IFS= read -r line; do case "$line" in host=*) host="${line#host=}";; esac; done; if [ "$host" = "codeberg.org" ]; then printf "protocol=https\\nhost=codeberg.org\\nusername=alice\\npassword=tea-secret-tok\\n"; else exit 1; fi'
    );
    const selected = await selectCredential(
      CODEBERG_KEYS,
      'tea',
      'codeberg.org',
      {},
      { PATH: dir }
    );
    expect(selected).toEqual({
      kind: 'selected',
      token: 'tea-secret-tok',
      source: 'tea logins helper',
    });

    const missingLogin = await selectCredential(
      CODEBERG_KEYS,
      'tea',
      'other.example',
      {},
      { PATH: dir }
    );
    expect(missingLogin).toMatchObject({ kind: 'failed' });
    expect(JSON.stringify(missingLogin)).not.toContain('tea-secret-tok');
  });

  test('reports missing when tea is not installed', async () => {
    const emptyDir = trackTempRoot(mkdtempSync(join(tmpdir(), 'forge-tea-missing-')));
    const result = await selectCredential(
      CODEBERG_KEYS,
      'tea',
      'codeberg.org',
      {},
      { PATH: emptyDir }
    );
    expect(result).toEqual({
      kind: 'missing',
      message:
        'credential environment CODEBERG_TOKEN or FORGEJO_TOKEN or GITEA_TOKEN is not set; tea is not installed',
    });
  });
});
