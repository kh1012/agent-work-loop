import {
  type InteractiveSelectPresentation,
  type InteractiveSelectResult,
  runInteractiveSelect,
} from './select.js';
import {
  type Caps,
  flowClose,
  flowConnector,
  flowOpen,
  flowSelectLine,
  flowStepLine,
} from './tty.js';

/**
 * clack 스타일 스파인 세션의 I/O 계층 (tty.ts = 순수 문자열 / select.ts = raw-mode
 * 선택 I/O 와 같은 분리를 따른다). 세션 하나가 시작(┌)부터 끝(└)까지 좌측 세로선(│)
 * 으로 이어지는 트랜스크립트를 process.stdout 에 직접 그린다.
 *
 * 규칙: step()/selectStep() 은 호출될 때마다 항상 자기 연결줄(│)을 스스로 먼저
 * 찍는다 — 예외를 두지 않는다. activeSelect() 도 연결줄을 찍고 위임하되, 완료 후
 * 그 연결줄까지 마저 지워 다음 호출이 이 규칙을 그대로 지킬 수 있게 한다.
 */

export interface FlowSession {
  c: Caps;
}

/** 스파인 세션을 연다(┌) — 세션당 정확히 한 번, 맨 위. */
export function openFlow(title: string, c: Caps): FlowSession {
  process.stdout.write(`${flowOpen(title, c)}\n`);
  return { c };
}

/** 완료된 정보 스텝(◇) — 연결줄을 먼저 찍은 뒤 한 줄 요약을 커밋한다. */
export function step(session: FlowSession, title: string): void {
  process.stdout.write(`${flowConnector(session.c)}\n${flowStepLine(title, session.c)}\n`);
}

/** 완료된 "사용자가 고름" 스텝(●) — 정보(◇)와 시각적으로 구분한다. */
export function selectStep(session: FlowSession, title: string): void {
  process.stdout.write(`${flowConnector(session.c)}\n${flowSelectLine(title, session.c)}\n`);
}

/**
 * raw-mode 선택기를 ◆ 활성 노드로 그린다 — 연결줄을 먼저 찍고 runInteractiveSelect
 * 에 위임한다. runInteractiveSelect 는 자기 헤더+본문(마지막 프레임)을 스스로
 * 지우고 끝나므로, 여기서는 우리가 찍은 연결줄 한 줄만 마저 지워 커서를 완전히
 * 원위치로 돌린다. 접힌 요약(◇/●)은 호출부가 결과를 보고 step()/selectStep() 으로
 * 직접 커밋한다.
 */
export async function activeSelect(
  session: FlowSession,
  options: string[],
  defaultIndex: number,
  multi: boolean,
  defaultChecked: number[] = [],
  presentation: InteractiveSelectPresentation = {},
): Promise<InteractiveSelectResult | null> {
  process.stdout.write(`${flowConnector(session.c)}\n`);
  const result = await runInteractiveSelect(
    options,
    defaultIndex,
    multi,
    session.c,
    defaultChecked,
    presentation,
  );
  process.stdout.write('\x1b[1A\x1b[0J');
  return result;
}

/** 스파인 세션을 닫는다(└) — 세션당 정확히 한 번, 맨 아래. */
export function closeFlow(session: FlowSession): void {
  process.stdout.write(`${flowClose(session.c)}\n`);
}
