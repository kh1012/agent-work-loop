import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { installationRoot } from '../core/paths.js';
import {
  type PortLeaseIdentity,
  type PortLeaseRecord,
  inspectPortLease,
  runWithPortLease,
} from '../core/port-lease.js';
import { caps, signal } from '../core/tty.js';
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

/**
 * 서비스가 뜬 직후(one-shot, best-effort) `--url`을 GET해 앱이 실제로 응답하는지 본다
 * (review-verification-env-traps AC-02). lease/inspect는 프로세스·포트만 보고 "owned·listening"을
 * 주므로, 상대경로 root 오설정 등으로 서버는 떴지만 요청이 전부 404인 상태를 구분 못 한다.
 * dev 서버는 "started" 로그 직후에도 바로 요청을 받지 못할 수 있어 짧게 재시도한다.
 * 실패해도 안내만 하고 exitCode는 건드리지 않는다 — 이 wrapper의 실패 판정은 여전히 child의
 * exit code 몫이다(API 전용 서버처럼 `/`가 정상적으로 2xx가 아닐 수도 있어 이건 어디까지나 참고).
 */
async function healthCheck(url: string, json: boolean): Promise<void> {
  const delaysMs = [300, 600, 1200];
  let lastError: string | undefined;
  for (const delay of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (res.ok) {
        const line = `service healthcheck: GET ${url} -> ${res.status}\n`;
        process.stdout.write(
          json ? `${JSON.stringify({ healthcheck: 'ok', url, status: res.status })}\n` : line,
        );
        return;
      }
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error);
    }
  }
  const line = `${signal(caps(), 'warn')} service healthcheck: GET ${url} 이 정상 응답하지 않습니다(${lastError}) — lease/inspect는 owned·listening이어도 앱이 실제로 요청에 응답하지 않을 수 있습니다.\n`;
  process.stdout.write(
    json ? `${JSON.stringify({ healthcheck: 'failed', url, error: lastError })}\n` : line,
  );
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
  // 서비스 명령은 호출자가 실제로 있는 디렉토리(process.cwd())를 cwd로 받는다 — lease
  // identity(위)는 일관성을 위해 프로젝트 루트 기준으로 고정하지만, 그것과 자식 프로세스의
  // cwd는 별개 관심사다. 예전엔 둘 다 프로젝트 루트를 썼는데, 그러면 서비스 명령에 준 상대경로
  // 인자(실행파일 자신이 아니라 그 인자, 예: vite의 project root 인자)가 호출자의 실제 위치가
  // 아니라 프로젝트 루트 기준으로 조용히 풀려 서버가 뜬 것처럼 보여도(lease owned, listening)
  // 앱은 전부 404를 내는 사고가 났다(review-verification-env-traps F-01/F-02).
  const cwd = process.cwd();

  const result = await runWithPortLease({
    installationRoot: installationRoot(),
    port,
    url,
    identity,
    command,
    cwd,
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
      void healthCheck(url, options.json === true);
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
