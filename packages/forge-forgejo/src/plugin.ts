#!/usr/bin/env bun
import { forgeRequestSchema, type ForgeResponse } from '@archon/forge/operations';
import { forgejoPluginMetadata, handleForgejoOperation } from './operations';

/**
 * Write one JSON document to stdout and wait until it is handed to the pipe so
 * multi-megabyte responses are never truncated when the process exits.
 */
export async function respond(value: unknown): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(value)}\n`, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function invalidRequest(operationId: string, message: string): ForgeResponse {
  return { operationId, ok: false, error: { kind: 'invalid_request', message } };
}

export async function runForgejoPlugin(args: readonly string[]): Promise<number> {
  if (args.length === 1 && args[0] === 'metadata') {
    await respond(forgejoPluginMetadata);
    return 0;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await Bun.stdin.text()) as unknown;
  } catch {
    await respond(invalidRequest('invalid', 'stdin must contain one UTF-8 JSON request'));
    return 1;
  }
  const operationId =
    typeof raw === 'object' &&
    raw !== null &&
    'operationId' in raw &&
    typeof raw.operationId === 'string' &&
    raw.operationId !== ''
      ? raw.operationId
      : 'invalid';
  const request = forgeRequestSchema.safeParse(raw);
  if (!request.success) {
    await respond(invalidRequest(operationId, 'stdin does not match the forge request schema'));
    return 1;
  }
  if (args.length !== 2 || args[0] !== 'op' || args[1] !== request.data.op) {
    await respond(
      invalidRequest(operationId, `expected executable arguments: op ${request.data.op}`)
    );
    return 1;
  }

  const response = await handleForgejoOperation(request.data, {
    token: process.env.ARCHON_FORGE_TOKEN,
  });
  await respond(response);
  return response.ok ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runForgejoPlugin(process.argv.slice(2));
