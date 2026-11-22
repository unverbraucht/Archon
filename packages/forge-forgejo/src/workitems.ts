/** Forgejo work items: reads, listing, creation, labels, and body edits. */

import { z } from 'zod';
import {
  contentDigest,
  type ForgeWorkItemRecord,
  type ForgeSubjectRecord,
  type ForgeLabelRecord,
  type ForgeMutationRequest,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import type { ForgeSubjectRef, PrRef, RepoRef } from '@archon/forge';
import { ForgejoError, forgejoPages, forgejoRequest, location, type Fetch } from './api';
import { authorField, userSchema } from './actor';
import { applied, failure, refused, unverified, type Submit } from './mutation-outcome';

const labelSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  color: z.string(),
  description: z.string().nullable().optional(),
});
type Label = z.infer<typeof labelSchema>;

export const issueSchema = z.object({
  number: z.number().int().positive(),
  html_url: z.url(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(['open', 'closed']),
  labels: z.array(z.object({ id: z.number().int(), name: z.string().min(1) })).default([]),
  pull_request: z.unknown().nullable().optional(),
  repository: z
    .object({ full_name: z.string().min(1) })
    .nullable()
    .optional(),
  user: userSchema.optional(),
});
type Issue = z.infer<typeof issueSchema>;

/** Forgejo's issues endpoint serves pull requests too; non-null `pull_request` marks a PR. */
export function itemRecord(
  repo: RepoRef,
  item: Pick<Issue, 'number' | 'html_url' | 'state' | 'pull_request' | 'repository'>,
  number = item.number
): ForgeSubjectRecord {
  if (
    item.number !== number ||
    (item.repository && item.repository.full_name.toLowerCase() !== repo.path.toLowerCase())
  ) {
    throw new ForgejoError(
      {
        kind: 'invalid_response',
        message: 'Forgejo item read-back did not match the requested identity',
      },
      true
    );
  }
  return {
    ref: { repo, number: item.number },
    kind: item.pull_request == null ? 'issue' : 'pr',
    url: item.html_url,
    state: item.state,
  };
}

function issueRecord(repo: RepoRef, item: Issue, number = item.number): ForgeWorkItemRecord {
  const record = itemRecord(repo, item, number);
  if (record.kind !== 'issue') {
    throw new ForgejoError(
      { kind: 'invalid_response', message: `Forgejo item ${String(number)} is not an issue` },
      true
    );
  }
  return { ...record, kind: 'issue' };
}

export function subjectRecord(subject: ForgeSubjectRef, item: Issue): ForgeSubjectRecord {
  const record = itemRecord(subject.ref.repo, item, subject.ref.number);
  if (record.kind !== subject.kind) {
    throw new ForgejoError(
      {
        kind: 'invalid_request',
        message: `Forgejo item ${String(subject.ref.number)} is ${record.kind === 'pr' ? 'a pull request' : 'an issue'}, not ${subject.kind === 'pr' ? 'a pull request' : 'an issue'}`,
      },
      true
    );
  }
  return record;
}

function labelNames(item: Issue): string[] {
  return item.labels.map(label => label.name);
}

export async function readIssue(fetchImpl: Fetch, token: string, ref: PrRef): Promise<Issue> {
  const { root, path } = location(ref.repo);
  return issueSchema.parse(
    await forgejoRequest(fetchImpl, token, `${root}/repos/${path}/issues/${String(ref.number)}`)
  );
}

function firstLine(body: string | null): string {
  return (body ?? '').split(/\r?\n/, 1)[0];
}

async function markedCandidates(
  fetchImpl: Fetch,
  token: string,
  root: string,
  path: string,
  marker: string
): Promise<Issue[]> {
  const words = marker
    .replace(/<!--|-->|"/g, ' ')
    .split(/\s+/)
    .filter(word => word !== '')
    .join(' ');
  const [searched, newest] = await Promise.all([
    words
      ? forgejoPages(
          fetchImpl,
          token,
          `${root}/repos/${path}/issues?type=issues&state=all&q=${encodeURIComponent(words)}`,
          raw => z.array(issueSchema).parse(raw)
        )
      : Promise.resolve([]),
    forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues?type=issues&state=all&sort=latest&limit=50&page=1`
    ).then(raw => z.array(issueSchema).parse(raw)),
  ]);
  return [...searched, ...newest];
}

export async function createWorkItem(
  request: Extract<ForgeMutationRequest, { op: 'workitem.create' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { root, path } = location(request.repo);
  const issues = await markedCandidates(fetchImpl, token, root, path, request.marker);
  const matches = [
    ...new Map(
      issues
        .filter(item => item.pull_request == null && firstLine(item.body) === request.marker)
        .map(item => [item.number, item])
    ).values(),
  ];
  if (matches.length > 1) {
    return refused(request, {
      kind: 'conflict',
      message: 'Multiple issues carry the canonical marker',
    });
  }
  const changed = matches.length === 0;
  let number: number;
  if (changed) {
    submit('submitted');
    const raw = await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({ title: request.title, body: request.body }),
      },
      () => {
        submit('acknowledged');
      }
    );
    number = issueSchema.parse(raw).number;
  } else {
    number = matches[0].number;
  }
  const after = await readIssue(fetchImpl, token, { repo: request.repo, number });
  const workitem = issueRecord(request.repo, after, number);
  const matchesWritten =
    firstLine(after.body) === request.marker &&
    (!changed ||
      (after.title === request.title && after.body === request.body && after.state === 'open'));
  if (!matchesWritten) {
    return changed
      ? unverified(
          request,
          'Created issue read-back did not match',
          `issue ${String(number)} may exist`,
          { workitem }
        )
      : refused(request, {
          kind: 'conflict',
          message: 'Recovered issue no longer carries the marker',
        });
  }
  return applied(request, {
    changed,
    workitem,
    markerDigest: contentDigest(firstLine(after.body)),
    titleDigest: contentDigest(after.title),
    bodyDigest: contentDigest(after.body ?? ''),
  });
}

async function repositoryLabels(fetchImpl: Fetch, token: string, repo: RepoRef): Promise<Label[]> {
  const { root, path } = location(repo);
  return forgejoPages(fetchImpl, token, `${root}/repos/${path}/labels`, raw =>
    z.array(labelSchema).parse(raw)
  );
}

export async function handleForgejoRepoLabelsList(
  request: Extract<ForgeRequest, { op: 'repo.labels.list' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const labels = await repositoryLabels(fetchImpl, token, request.repo);
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: { repo: request.repo, labels: labels.map(({ name }) => ({ name })) },
    },
  };
}

function labelRecord(label: Label): ForgeLabelRecord {
  return {
    name: label.name,
    color: label.color.replace(/^#/, '').toLowerCase(),
    descriptionDigest: contentDigest(label.description ?? ''),
  };
}

export async function ensureLabel(
  request: Extract<ForgeMutationRequest, { op: 'repo.label.ensure' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const existing = (await repositoryLabels(fetchImpl, token, request.repo)).find(
    label => label.name === request.name
  );
  if (existing) return applied(request, { changed: false, label: labelRecord(existing) });
  const { root, path } = location(request.repo);
  submit('submitted');
  const created = labelSchema.parse(
    await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/labels`,
      {
        method: 'POST',
        body: JSON.stringify({
          name: request.name,
          color: `#${request.color}`,
          description: request.description,
        }),
      },
      () => {
        submit('acknowledged');
      }
    )
  );
  const label = labelRecord(
    labelSchema.parse(
      await forgejoRequest(fetchImpl, token, `${root}/repos/${path}/labels/${String(created.id)}`)
    )
  );
  const expectedColor = request.color.toLowerCase();
  if (
    label.name !== request.name ||
    label.color !== expectedColor ||
    label.descriptionDigest !== contentDigest(request.description)
  ) {
    return unverified(
      request,
      'Repository label read-back did not match',
      'a repository label may exist',
      { label }
    );
  }
  return applied(request, { changed: true, label });
}

export async function setLabels(
  request: Extract<ForgeMutationRequest, { op: 'workitem.labels.set' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const before = await readIssue(fetchImpl, token, request.ref);
  const workitem = issueRecord(request.ref.repo, before, request.ref.number);
  const present = await repositoryLabels(fetchImpl, token, request.ref.repo);
  const byName = new Map(present.map(label => [label.name, label]));
  const ids = request.labels.map(name => byName.get(name)?.id);
  if (ids.some(id => id === undefined)) {
    return refused(request, {
      kind: 'not_found',
      message: 'A requested repository label does not exist',
    });
  }
  const equal = (labels: string[]): boolean =>
    labels.length === request.labels.length && request.labels.every(name => labels.includes(name));
  if (equal(labelNames(before))) {
    return applied(request, { changed: false, workitem, labels: labelNames(before) });
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(request.ref.number)}/labels`,
    { method: 'PUT', body: JSON.stringify({ labels: ids }) },
    () => {
      submit('acknowledged');
    }
  );
  const after = await readIssue(fetchImpl, token, request.ref);
  const observed = issueRecord(request.ref.repo, after, request.ref.number);
  const labels = labelNames(after);
  return equal(labels)
    ? applied(request, { changed: true, workitem: observed, labels })
    : unverified(request, 'Issue label read-back did not match', 'issue labels may have changed', {
        workitem: observed,
      });
}

export async function addLabel(
  request: Extract<ForgeMutationRequest, { op: 'workitem.label.add' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { subject, name } = request;
  const before = await readIssue(fetchImpl, token, subject.ref);
  const workitem = subjectRecord(subject, before);
  if (labelNames(before).includes(name)) {
    return applied(request, { changed: false, workitem, labels: labelNames(before) });
  }
  const label = (await repositoryLabels(fetchImpl, token, subject.ref.repo)).find(
    candidate => candidate.name === name
  );
  if (!label) {
    return refused(request, {
      kind: 'not_found',
      message: 'The requested repository label does not exist',
    });
  }
  const { root, path } = location(subject.ref.repo);
  submit('submitted');
  await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(subject.ref.number)}/labels`,
    { method: 'POST', body: JSON.stringify({ labels: [label.id] }) },
    () => {
      submit('acknowledged');
    }
  );
  const after = await readIssue(fetchImpl, token, subject.ref);
  const observed = subjectRecord(subject, after);
  return labelNames(after).includes(name)
    ? applied(request, { changed: true, workitem: observed, labels: labelNames(after) })
    : unverified(
        request,
        'Label read-back did not include the added label',
        'the label may be on the item',
        { workitem: observed }
      );
}

export async function removeLabel(
  request: Extract<ForgeMutationRequest, { op: 'workitem.label.remove' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { subject, name } = request;
  const before = await readIssue(fetchImpl, token, subject.ref);
  const workitem = subjectRecord(subject, before);
  const existing = before.labels.find(label => label.name === name);
  if (!existing) {
    return applied(request, { changed: false, workitem, labels: labelNames(before) });
  }
  const { root, path } = location(subject.ref.repo);
  submit('submitted');
  let changed = true;
  try {
    await forgejoRequest(
      fetchImpl,
      token,
      `${root}/repos/${path}/issues/${String(subject.ref.number)}/labels/${String(existing.id)}`,
      { method: 'DELETE' },
      () => {
        submit('acknowledged');
      },
      'empty'
    );
  } catch (cause) {
    if (!(cause instanceof ForgejoError && cause.detail.status === 404)) throw cause;
    changed = false;
  }
  const after = await readIssue(fetchImpl, token, subject.ref);
  const observed = subjectRecord(subject, after);
  return labelNames(after).includes(name)
    ? unverified(
        request,
        'Label read-back still included the removed label',
        'the label may have been removed',
        { workitem: observed }
      )
    : applied(request, { changed, workitem: observed, labels: labelNames(after) });
}

export async function editWorkItemBody(
  request: Extract<ForgeMutationRequest, { op: 'workitem.edit-body' }>,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const issue = { kind: 'issue', ref: request.ref } as const;
  const before = await readIssue(fetchImpl, token, request.ref);
  const workitem = { ...subjectRecord(issue, before), kind: 'issue' as const };
  const bodyDigest = contentDigest(request.body);
  if ((before.body ?? '') === request.body) {
    return applied(request, { changed: false, workitem, bodyDigest });
  }
  const { root, path } = location(request.ref.repo);
  submit('submitted');
  await forgejoRequest(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues/${String(request.ref.number)}`,
    { method: 'PATCH', body: JSON.stringify({ body: request.body }) },
    () => {
      submit('acknowledged');
    }
  );
  const leaveBehind = 'the issue body may have changed';
  let after: Issue;
  try {
    after = await readIssue(fetchImpl, token, request.ref);
  } catch {
    return unverified(request, 'Edited issue could not be read back', leaveBehind);
  }
  const observed = issueRecord(request.ref.repo, after, request.ref.number);
  return (after.body ?? '') === request.body
    ? applied(request, { changed: true, workitem: observed, bodyDigest })
    : unverified(request, 'Issue body read-back did not match', leaveBehind, {
        workitem: observed,
      });
}

export async function handleForgejoWorkItemView(
  request: Extract<ForgeRequest, { op: 'workitem.view' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const item = await readIssue(fetchImpl, token, request.ref);
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: 'workitem.view',
      value: {
        ...itemRecord(request.ref.repo, item, request.ref.number),
        title: item.title,
        body: item.body ?? '',
        labels: labelNames(item),
        ...authorField(request.ref.repo.host, item.user),
      },
    },
  };
}

export async function handleForgejoWorkItemList(
  request: Extract<ForgeRequest, { op: 'workitem.list' }>,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  if (request.label.includes(',')) {
    return failure(request.operationId, {
      kind: 'invalid_request',
      message: 'Forgejo cannot list items by a label name that contains a comma',
    });
  }
  const { root, path } = location(request.repo);
  const items = await forgejoPages(
    fetchImpl,
    token,
    `${root}/repos/${path}/issues?state=open&labels=${encodeURIComponent(request.label)}`,
    raw => z.array(issueSchema).parse(raw)
  );
  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        repo: request.repo,
        label: request.label,
        items: items
          .filter(item => item.labels.some(label => label.name === request.label))
          .map(item => itemRecord(request.repo, item)),
      },
    },
  };
}
