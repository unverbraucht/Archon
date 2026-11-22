/**
 * `attachment.put` on Codeberg: stores an image on the `archon-attachments` branch
 * via Forgejo's contents API so a comment or review can embed a commit-pinned URL.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ForgeMutationRequest, ForgeResponse } from '@archon/forge/operations';
import { forgejoRequest, forgejoResponseError, forgejoSend, location, type Fetch } from './api';
import { applied, refused, unverified, type Submit } from './mutation-outcome';

type PutRequest = Extract<ForgeMutationRequest, { op: 'attachment.put' }>;

const BRANCH = 'archon-attachments';

const extensions = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} satisfies Record<PutRequest['contentType'], string>;

const repositorySchema = z.object({
  html_url: z.url(),
  default_branch: z.string().min(1),
  permissions: z.object({ push: z.boolean() }).optional(),
});

const branchSchema = z.object({
  commit: z.object({ id: z.string().min(1) }),
});

const existingFileSchema = z.object({
  type: z.literal('file'),
  last_commit_sha: z.string().min(1).optional(),
});

const createdFileResponseSchema = z.object({
  commit: z.object({ sha: z.string().min(1) }),
  content: z.object({ path: z.string().min(1) }).optional(),
});

interface Stored {
  name: string;
  digest: string;
  bytes: number;
  htmlUrl: string;
  defaultBranch: string;
}

function storedResult(
  request: PutRequest,
  stored: Stored,
  changed: boolean,
  commit: string
): ForgeResponse {
  return applied(request, {
    changed,
    attachment: {
      url: `${stored.htmlUrl}/raw/commit/${commit}/${stored.name}`,
      digest: stored.digest,
      bytes: stored.bytes,
      contentType: request.contentType,
    },
  });
}

async function readExistingAttachment(
  fetchImpl: Fetch,
  token: string,
  api: string,
  name: string
): Promise<{ branchExists: boolean; existingCommit: string | null }> {
  const branchResponse = await forgejoSend(fetchImpl, token, `${api}/branches/${BRANCH}`);
  if (branchResponse.status === 404) return { branchExists: false, existingCommit: null };
  if (!branchResponse.ok) throw forgejoResponseError(branchResponse);
  const branch = branchSchema.parse(await branchResponse.json());

  const fileResponse = await forgejoSend(
    fetchImpl,
    token,
    `${api}/contents/${encodeURIComponent(name)}?ref=${BRANCH}`
  );
  if (fileResponse.status === 404) return { branchExists: true, existingCommit: null };
  if (!fileResponse.ok) throw forgejoResponseError(fileResponse);
  const file = existingFileSchema.parse(await fileResponse.json());
  return { branchExists: true, existingCommit: file.last_commit_sha ?? branch.commit.id };
}

export async function putAttachment(
  request: PutRequest,
  fetchImpl: Fetch,
  token: string,
  submit: Submit
): Promise<ForgeResponse> {
  const { root, path } = location(request.repo);
  const api = `${root}/repos/${path}`;
  const repository = repositorySchema.parse(await forgejoRequest(fetchImpl, token, api));
  if (repository.permissions?.push === false) {
    return refused(request, {
      kind: 'authorization',
      message: `the token cannot push to ${request.repo.path}; an attachment is stored in the repository the change is proposed to`,
    });
  }
  const bytes = Buffer.from(request.content, 'base64');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const stored: Stored = {
    name: `${digest}.${extensions[request.contentType]}`,
    digest,
    bytes: bytes.byteLength,
    htmlUrl: repository.html_url.replace(/\/+$/, ''),
    defaultBranch: repository.default_branch,
  };
  const { branchExists, existingCommit } = await readExistingAttachment(
    fetchImpl,
    token,
    api,
    stored.name
  );
  if (existingCommit !== null) return storedResult(request, stored, false, existingCommit);

  submit('submitted');
  const raw = await forgejoRequest(
    fetchImpl,
    token,
    `${api}/contents/${encodeURIComponent(stored.name)}`,
    {
      method: 'POST',
      body: JSON.stringify({
        content: request.content,
        message: `Add attachment ${stored.name}`,
        ...(branchExists
          ? { branch: BRANCH }
          : { branch: stored.defaultBranch, new_branch: BRANCH }),
      }),
    },
    () => {
      submit('acknowledged');
    }
  );
  const parsed = createdFileResponseSchema.safeParse(raw);
  if (!parsed.success || (parsed.data.content && parsed.data.content.path !== stored.name)) {
    return unverified(
      request,
      'Attachment upload response did not confirm the stored commit',
      `branch ${BRANCH} may contain ${stored.name}`
    );
  }
  return storedResult(request, stored, true, parsed.data.commit.sha);
}
