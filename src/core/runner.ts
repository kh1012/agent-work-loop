import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

/**
 * 명령어 실행 모듈.
 *
 * 핵심 제약:
 * - 환경변수를 명령어 문자열에 넣지 않는다. "NODE_ENV=test vitest" 는 POSIX
 *   셸에서만 동작하고 PowerShell에서는 깨진다. 그래서 env는 spawn의 env 옵션으로
 *   주입한다.
 * - shell: false 로 실행한다. 크로스 셸 차이(bash/zsh vs PowerShell vs cmd)와
 *   셸 인젝션을 피하기 위해서다. 근거는 docs/decisions.md D-8 참조.
 * - 명령을 찾지 못하면(ENOENT) 일반 실패와 구분되는 별도 에러를 던진다.
 */

export interface RunSpec {
  /** 실행할 명령. args가 없으면 공백으로 토큰화한다. 예: "vitest run" */
  cmd: string;
  /** 주어지면 cmd는 실행 파일로만 취급하고 이 배열을 인자로 쓴다. */
  args?: string[];
  /** 주입할 환경변수. process.env 위에 덮어쓴다. */
  env?: Record<string, string>;
  /** 작업 디렉토리 */
  cwd?: string;
  /** 타임아웃(ms). 넘기면 프로세스를 죽이고 timedOut=true 로 반환한다. */
  timeoutMs?: number;
  /** 외부 취소 신호. abort 되면 프로세스를 죽이고 예외를 던진다. */
  signal?: AbortSignal;
}

export interface RunResult {
  /** 종료 코드. 신호로 죽으면 null 일 수 있다. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 타임아웃으로 죽었는가 */
  timedOut: boolean;
}

/** 명령을 찾을 수 없을 때(ENOENT) 던지는 에러. 일반 실패와 구분된다. */
export class CommandNotFoundError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`명령을 찾을 수 없습니다: ${command}`);
    this.name = 'CommandNotFoundError';
    this.command = command;
  }
}

/**
 * 명령 문자열을 토큰으로 나눈다. 따옴표(작은/큰)를 존중한다.
 * shell을 쓰지 않으므로 program과 args를 직접 분리해야 한다.
 */
export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = re.exec(cmd);
  while (match !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    match = re.exec(cmd);
  }
  return tokens;
}

/**
 * 명령을 실행하고 결과를 반환한다.
 *
 * 성공/실패(exitCode != 0)는 모두 정상 반환한다. 예외는 두 경우다:
 * - 명령을 찾을 수 없음: CommandNotFoundError
 * - 외부 취소(AbortSignal): AbortError (spawn이 던지는 code 'ABORT_ERR')
 */
export function run(spec: RunSpec): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const tokens = spec.args ? [spec.cmd, ...spec.args] : tokenize(spec.cmd);
    const program = tokens[0];
    const args = tokens.slice(1);

    if (!program) {
      reject(new Error('빈 명령입니다.'));
      return;
    }

    const start = performance.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const child = spawn(program, args, {
      cwd: spec.cwd,
      // process.env 를 상속하고 spec.env 로 덮어쓴다. PATH 등은 유지된다.
      env: { ...process.env, ...spec.env },
      shell: false,
      signal: spec.signal,
      windowsHide: true,
    });

    const clearTimer = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    if (spec.timeoutMs !== undefined && spec.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, spec.timeoutMs);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      if (err.code === 'ENOENT') {
        reject(new CommandNotFoundError(program));
        return;
      }
      // AbortSignal 취소(code 'ABORT_ERR') 및 기타 오류는 그대로 던진다.
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      resolve({
        exitCode: code,
        stdout,
        stderr,
        durationMs: Math.round(performance.now() - start),
        timedOut,
      });
    });
  });
}
