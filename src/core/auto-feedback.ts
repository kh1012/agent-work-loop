import os from 'node:os';
import { loadConfig, resolveProjectRoot } from '../commands/config.js';
import { appendRecord, buildRecord, newRecordId, syncFeedback } from '../commands/record.js';

/**
 * awl CLI 자신의 미처리 예외를 최소 맥락으로 자동 기록한다(ADK stage 6, "도구 피드백이
 * 자동으로 모인다"). awl 은 에이전트 루프를 실행하지 않으므로(오케스트레이터가 아니다)
 * 관측 가능한 "도구 오류"는 awl 명령 자신이 던지는 미처리 예외뿐이다 — 이미
 * process.exit(1)로 처리된 알려진 에러(대부분의 명령이 이렇게 한다)는 여기 안 온다.
 *
 * 코드 내용·스펙 본문·토큰·절대 경로는 안 보낸다(prototype.md) — 절대경로만
 * 상대화하고, 스택트레이스는 아예 담지 않는다(경로 노출이 스택 자체에 집중돼 있다).
 *
 * config.json 의 `feedback`(0.6.x, awl-loop 세션 피드백 모드)와는 다른 스위치다 — 이
 * 자동수집은 `autoFeedback`(별도 최상위 키, 기본 true)로 끈다. 이름을 겹치지 않게
 * 분리한 이유: `feedback`은 이미 { enabled, path } shape 의 전혀 다른 기능에 쓰이고
 * 있어(config.ts), 여기서 재사용하면 그 기능의 검증/오버레이 로직과 충돌한다.
 */

/** 절대경로를 상대화한다(홈 디렉토리·프로젝트 루트 → 플레이스홀더). 순수 함수. */
export function redactAbsolutePaths(text: string, home: string, projectRoot: string | null): string {
  let out = text;
  if (projectRoot && projectRoot.trim() !== '') {
    out = out.split(projectRoot).join('<project>');
  }
  if (home.trim() !== '') {
    out = out.split(home).join('<home>');
  }
  return out;
}

export function buildAutoFeedbackWhat(commandName: string): string {
  return `CLI 미처리 예외: awl ${commandName}`;
}

/** argv(process.argv)에서 옵션이 아닌 첫 인자를 명령 이름으로 본다. 순수 함수. */
export function commandNameFromArgv(argv: string[]): string {
  return argv.slice(2).find((a) => !a.startsWith('-')) ?? '(알 수 없음)';
}

/**
 * 미처리 예외를 awl-feedback 레코드로 남긴다. 이 함수 자체가 실패해도(프로젝트를
 * 못 찾음, 쓰기 실패 등) 조용히 무시한다 — 피드백 수집이 원래 에러를 가리면 안 된다.
 */
export async function recordAutoFeedback(err: unknown, argv: string[]): Promise<void> {
  try {
    const projectRoot = resolveProjectRoot();
    if (!projectRoot) {
      return; // project 를 못 정하면 조용히 생략 — 억지로 태그하지 않는다.
    }
    const { config } = loadConfig(projectRoot);
    if (config?.autoFeedback === false) {
      return; // 기본 켜짐. 명시적 false 만 끈다.
    }

    const message = err instanceof Error ? err.message : String(err);
    const impact = redactAbsolutePaths(message, os.homedir(), projectRoot);
    const commandName = commandNameFromArgv(argv);

    const { record } = buildRecord(
      'awl-feedback',
      { area: 'cli', what: buildAutoFeedbackWhat(commandName), impact, severity: 'low' },
      { project: config?.project, id: newRecordId(), at: new Date().toISOString() },
    );
    if (!record) {
      return;
    }
    appendRecord(record);
    await syncFeedback(projectRoot, record);
  } catch {
    // 피드백 수집 자체가 실패해도 원래 에러를 가리지 않는다.
  }
}
