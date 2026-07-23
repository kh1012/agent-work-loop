import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { installationRoot } from '../core/paths.js';
import {
  type PortLeaseIdentity,
  type PortLeaseRecord,
  inspectPortLease,
  runWithPortLease,
} from '../core/port-lease.js';
import { resolveProjectRoot } from './config.js';

export interface PortLeaseRunCommandOptions {
  port: string;
  workitem: string;
  url?: string;
  json?: boolean;
}

export interface PortLeaseInspectCommandOptions {
  port: string;
  workitem: string;
  json?: boolean;
}

function gitValue(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `git ${args.join(' ')} failed`).trim());
  }
  return result.stdout.trim();
}

export function currentPortLeaseIdentity(root: string, workitem: string): PortLeaseIdentity {
  return {
    lane: path.resolve(root),
    branch: gitValue(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    head: gitValue(root, ['rev-parse', 'HEAD']),
    workitem,
  };
}

export function parseServicePort(input: string): number {
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`--port must be an integer between 1 and 65535: ${input}`);
  }
  return port;
}

export function resolveServiceUrl(input: string | undefined, port: number): string {
  const resolved = (input ?? `http://127.0.0.1:${port}`).replaceAll('{port}', String(port));
  const url = new URL(resolved);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`--url must use http or https: ${resolved}`);
  }
  const resolvedPort = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (resolvedPort !== port) {
    throw new Error(`--url port ${resolvedPort} does not match --port ${port}`);
  }
  return url.toString();
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function leaseOutput(
  status: string,
  port: number,
  url: string,
  lease: PortLeaseRecord | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { status, port, url, lease, ...extra };
}

export async function runPortLeaseCommand(
  command: string[],
  options: PortLeaseRunCommandOptions,
): Promise<void> {
  const root = resolveProjectRoot();
  if (!root) {
    throw new Error('AWL project root was not found');
  }
  const port = parseServicePort(options.port);
  const url = resolveServiceUrl(options.url, port);
  const identity = currentPortLeaseIdentity(root, options.workitem);

  const result = await runWithPortLease({
    installationRoot: installationRoot(),
    port,
    url,
    identity,
    command,
    cwd: root,
    onAcquired: (lease) => {
      const output = leaseOutput('acquired', port, url, lease, { command });
      if (options.json) {
        printJson(output);
      } else {
        process.stdout.write(
          `service lease acquired before start: ${url} (port ${port}, child pending)\n`,
        );
      }
    },
    onStarted: (lease) => {
      const output = leaseOutput('started', port, url, lease, { command });
      if (options.json) {
        printJson(output);
      } else {
        process.stdout.write(
          `service child started: ${url} (port ${port}, child ${lease.childPid})\n`,
        );
      }
    },
  });

  if (result.status === 'busy' || result.status === 'unmanaged-listener') {
    printJson(leaseOutput(result.status, port, url, result.lease, { command }));
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    printJson(
      leaseOutput('completed', port, url, result.lease, {
        command,
        exitCode: result.exitCode,
        cleanup: result.cleanup,
      }),
    );
  }
  process.exitCode = result.exitCode;
}

export async function runPortLeaseInspectCommand(
  options: PortLeaseInspectCommandOptions,
): Promise<void> {
  const root = resolveProjectRoot();
  if (!root) {
    throw new Error('AWL project root was not found');
  }
  const port = parseServicePort(options.port);
  const requested = currentPortLeaseIdentity(root, options.workitem);
  const inspection = await inspectPortLease(installationRoot(), port, requested);
  if (options.json) {
    printJson(inspection);
  } else {
    process.stdout.write(
      `${inspection.status}: port ${port} (${inspection.reusable ? 'reusable' : 'do not reuse'})\n`,
    );
  }
}
