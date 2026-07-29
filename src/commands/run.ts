import fs from 'node:fs';
import path from 'node:path';
import { WORKTREES_DIR } from '../core/paths.js';
import { type Caps, caps, feedback, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { runLaneNew } from './lane.js';
import { type LoopMode, loadState, writeState } from './state.js';

/**
 * `awl run` — 요청을 연다(ADK 0.8.0, adk-reference.md:1357-1360 · 2164-2165).
 *
 * **에이전트를 띄우지 않는다.** 설계가 오케스트레이터를 없앤 자리라
 * (reference.md:2252 "awl 이 에이전트를 안 띄우게 된다. 판단도 안 하고 스폰도 안 하는
 * 것이 원칙과 더 맞는다"), 이 명령이 하는 일은 셋뿐이다 — 요청 원문과 모드를 상태에
 * 쓰고, 필요하면 레인을 만들고, 사람이 다음에 뭘 할지 안내한다.
 *
 * 진입점이 둘로 보이는 건 층이 달라서다:
 *   CLI    awl run     요청·모드·레인을 파일과 상태로 연다 (여기, 스폰 안 함)
 *   사람   /awl        에이전트 안에서 도는 스킬. awl next 를 따른다
 *   세션   리뷰어 스폰  --review 면 그 세션이 하나 띄운다 (reference.md:2179)
 *
 * 모드를 여기서 받는 이유(reference.md:1337 "프로파일 값이 아니다. 실행할 때 고른다"):
 * 지금까지는 스킬이 목표 서술문에서 `--strict` 토큰을 문자열로 긁어냈다. CLI 가 파싱할
 * 일을 프롬프트 파싱으로 때운 것이라, 목표에 그 낱말이 들어가면 오작동한다.
 */

export interface RunFlags {
  strict?: boolean;
  auto?: boolean;
  review?: boolean;
  lanes?: boolean;
}

/** 상호배타 플래그 위반. 호출부가 메시지를 고른다(순수 함수는 판정만). */
export class ConflictingModeFlags extends Error {}

/**
 * 플래그에서 loopMode 를 정한다(순수).
 *
 * 아무 플래그도 없으면 `undefined` 를 돌려주고 호출부는 필드를 안 만든다 — 기본값
 * semi-auto 는 `effectiveLoopMode` 가 "필드 없음"으로 읽으므로 굳이 박아둘 이유가
 * 없다(D-21, 안 쓰는 필드를 만들지 않는다).
 */
export function resolveLoopMode(flags: RunFlags): LoopMode | undefined {
  if (flags.strict === true && flags.auto === true) {
    throw new ConflictingModeFlags();
  }
  if (flags.strict === true) {
    return 'strict';
  }
  if (flags.auto === true) {
    return 'auto';
  }
  return undefined;
}

/**
 * `--lanes` 로 넘어온 목표 N개에 붙일 레인 이름(순수).
 *
 * 목표 서술에서 이름을 뽑지 않는다 — 한국어 목표에서 `keyboard` 같은 이름을 만들어내는
 * 건 판단이고, awl 은 판단하지 않는다(sanitizeForGit 은 비ASCII 를 `_` 로 바꿔서 쓸모도
 * 없다). 이름을 직접 정하고 싶으면 `awl lane new <이름>` 을 쓴다.
 *
 * 이미 있는 레인 이름을 건너뛰고 빈 번호를 채운다 — 같은 저장소에서 두 번째로 실행할 때
 * `lane-1` 충돌로 멈추면, 사람이 먼저 지워야 해서 "요청을 연다"는 목적이 무색해진다.
 */
export function laneNamesFor(goals: readonly string[], existing: readonly string[] = []): string[] {
  const taken = new Set(existing);
  const names: string[] = [];
  let n = 1;
  for (let i = 0; i < goals.length; i++) {
    while (taken.has(`lane-${n}`)) {
      n += 1;
    }
    names.push(`lane-${n}`);
    taken.add(`lane-${n}`);
    n += 1;
  }
  return names;
}

/** `.awl-worktrees/` 아래 현존 레인 디렉토리 이름들. 없으면 빈 배열. */
export function existingLaneNames(projectRoot: string): string[] {
  const dir = path.join(projectRoot, WORKTREES_DIR);
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** 요청 원문과 모드를 그 프로젝트(또는 레인)의 state 에 쓴다. */
export function openRequest(
  projectRoot: string,
  goal: string,
  mode: LoopMode | undefined,
  review: boolean,
): void {
  const state = loadState(projectRoot);
  state.request = goal;
  if (mode !== undefined) {
    state.loopMode = mode;
  }
  if (review) {
    state.review = true;
  }
  writeState(projectRoot, state);
}

/** 한 레인(또는 단일 요청)에 대한 다음 단계 안내 줄. */
function guidanceLines(
  entries: readonly { lane?: string; goal: string }[],
  mode: LoopMode | undefined,
  review: boolean,
  c: Caps,
): string[] {
  const color = makeColors(c.color);
  const out: string[] = [];
  if (entries.length === 1 && entries[0]?.lane === undefined) {
    out.push('에이전트를 열고 이렇게 말하세요.');
    out.push('');
    out.push(`  ${color.bold('/awl')}  ${entries[0]?.goal ?? ''}`);
  } else {
    out.push(`터미널 ${entries.length}개를 열고 각각 아래를 실행하세요.`);
    out.push(color.dim('(awl 은 세션을 대신 띄우지 않습니다 — 레인마다 사람이 하나씩 엽니다.)'));
    out.push('');
    for (const e of entries) {
      out.push(`  ${color.dim(`cd ${path.join(WORKTREES_DIR, e.lane ?? '')}`)}`);
      out.push(`  ${color.bold('/awl')}  ${e.goal}`);
      out.push('');
    }
    out.pop();
  }
  out.push('');
  out.push(color.dim(`모드: ${mode ?? 'semi-auto'}${review ? ' · 교차 검증 켜짐(--review)' : ''}`));
  return out;
}

export async function runRun(goals: string[], flags: RunFlags = {}): Promise<void> {
  const c = caps();
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
    return;
  }

  const cleaned = goals.map((g) => g.trim()).filter((g) => g !== '');
  if (cleaned.length === 0) {
    process.stderr.write(
      `\n${feedback(c, 'error', '목표를 입력하세요', 'awl run "레이어 패널을 키보드로 조작하고 싶다"')}\n`,
    );
    process.exit(1);
    return;
  }

  let mode: LoopMode | undefined;
  try {
    mode = resolveLoopMode(flags);
  } catch {
    process.stderr.write(
      `\n${feedback(c, 'error', '--strict 와 --auto 는 함께 쓸 수 없습니다', '둘 다 빼면 기본값 semi-auto 입니다')}\n`,
    );
    process.exit(1);
    return;
  }
  const review = flags.review === true;

  if (flags.lanes !== true) {
    if (cleaned.length > 1) {
      process.stderr.write(
        `\n${feedback(c, 'error', '목표가 여럿이면 --lanes 를 붙이세요', 'awl run --lanes "A" "B" "C"')}\n`,
      );
      process.exit(1);
      return;
    }
    const goal = cleaned[0] as string;
    openRequest(root, goal, mode, review);
    process.stdout.write(`\n${feedback(c, 'ok', '요청을 열었습니다')}\n`);
    for (const line of guidanceLines([{ goal }], mode, review, c)) {
      process.stdout.write(`  ${line}\n`);
    }
    return;
  }

  // --lanes: 목표마다 격리 레인을 만들고 각 레인 state 에 요청을 쓴다. 세션은 안 띄운다.
  const names = laneNamesFor(cleaned, existingLaneNames(root));
  const entries: { lane: string; goal: string }[] = [];
  for (const [i, goal] of cleaned.entries()) {
    const name = names[i] as string;
    await runLaneNew(name, goal, { suppressGuidance: true });
    openRequest(path.join(root, WORKTREES_DIR, name), goal, mode, review);
    entries.push({ lane: name, goal });
  }
  process.stdout.write(`\n${feedback(c, 'ok', `레인 ${entries.length}개에 요청을 열었습니다`)}\n`);
  for (const line of guidanceLines(entries, mode, review, c)) {
    process.stdout.write(`  ${line}\n`);
  }
}
