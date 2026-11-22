/** `workitem.search`: issues and pull requests in one Forgejo repository that match free text. */

import { z } from 'zod';
import {
  WORKITEM_SEARCH_DEFAULT_LIMIT,
  type ForgeRequest,
  type ForgeResponse,
} from '@archon/forge/operations';
import {
  ForgejoError,
  PAGE_LIMIT,
  forgejoResponseError,
  forgejoSend,
  location,
  type Fetch,
} from './api';
import { issueSchema, itemRecord } from './workitems';

type SearchRequest = Extract<ForgeRequest, { op: 'workitem.search' }>;

const searchItemSchema = issueSchema
  .pick({
    number: true,
    html_url: true,
    title: true,
    state: true,
    pull_request: true,
    repository: true,
  })
  .extend({ updated_at: z.iso.datetime({ offset: true }) });

type SearchItem = z.infer<typeof searchItemSchema>;

async function fetchSearchPage(
  fetchImpl: Fetch,
  token: string,
  baseUrl: string,
  page: number,
  limit: number
): Promise<{ items: SearchItem[]; totalCount: number | null; hasNext: boolean }> {
  const response = await forgejoSend(
    fetchImpl,
    token,
    `${baseUrl}&limit=${String(limit)}&page=${String(page)}`
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
  const items = z.array(searchItemSchema).parse(raw);
  const countHeader = response.headers.get('x-total-count');
  const parsedCount = countHeader !== null ? Number(countHeader) : Number.NaN;
  const totalCount = Number.isInteger(parsedCount) && parsedCount >= 0 ? parsedCount : null;
  const link = response.headers.get('link');
  const hasNext = link !== null ? /;\s*rel="next"/.test(link) : items.length >= limit;
  return { items, totalCount, hasNext };
}

export async function handleForgejoWorkItemSearch(
  request: SearchRequest,
  fetchImpl: Fetch,
  token: string
): Promise<ForgeResponse> {
  const limit = request.limit ?? WORKITEM_SEARCH_DEFAULT_LIMIT;
  const state = request.state ?? 'open';
  const { root, path } = location(request.repo);
  const typeParam =
    request.kind === 'issue' ? '&type=issues' : request.kind === 'pr' ? '&type=pulls' : '';
  const baseUrl = `${root}/repos/${path}/issues?q=${encodeURIComponent(request.text)}&state=${
    state === 'any' ? 'all' : state
  }&sort=recentupdate${typeParam}`;

  const collected: SearchItem[] = [];
  let totalCount: number | null = null;
  let hasMore = false;
  const pageSize = Math.min(limit, PAGE_LIMIT);

  for (let page = 1; collected.length < limit; page++) {
    const result = await fetchSearchPage(fetchImpl, token, baseUrl, page, pageSize);
    if (result.totalCount !== null) totalCount = result.totalCount;
    collected.push(...result.items);
    hasMore = result.hasNext;
    if (!result.hasNext || result.items.length === 0) break;
  }

  const found = collected
    .map(item => ({
      ...itemRecord(request.repo, item),
      title: item.title,
      updatedAt: item.updated_at,
    }))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  return {
    operationId: request.operationId,
    ok: true,
    result: {
      op: request.op,
      value: {
        repo: request.repo,
        text: request.text,
        items: found.slice(0, limit),
        truncated:
          found.length > limit ||
          (totalCount !== null ? totalCount > Math.min(found.length, limit) : hasMore),
      },
    },
  };
}
