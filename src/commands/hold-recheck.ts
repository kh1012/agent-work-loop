import fs from 'node:fs';
import path from 'node:path';
import { caps, card, makeColors, signal } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { pipelineLanes } from './status.js';

/**
 * awl hold-recheck — `.tasks/plan/*.hold.md` 중 "의존 워크아이템 대기형" hold 를
 * 재점검해, 의존이 이미 착지+합격했으면 자동 un-hold(`.hold.md` → `.md`, rename만)한다
 * (pipeline-hold-recheck). awl-pipeline-exec 스킬이 유휴 진입 직전(워처 재무장 전)
 * 호출한다 — 사람이 수동 rename 해야 풀리던 낭비를 없앤다.
 *
 * awl 은 판단하지 않는다 — hold 파일 자유서술에서 "un-hold 조건" 절을 찾아 의존
 * workitem id 를 뽑고(파싱), 그 의존이 착지+합격인지(pipelineLanes 재사용)만 계산한다.
 * 패턴이 없거나(전략문서) 의존이 미충족이면 손대지 않는다 — hold 포맷 표준화나
 * 자동 의존성 그래프는 범위 밖(이 일감의 완료조건 문서 참고).
 */

const HOLD_SUFFIX = '.hold.md';

/** "un-hold 조건" 서술 표지. 굵게(`**`)·헤딩(`##`)·콜론 유무와 무관하게 찾는다. */
const CONDITION_MARKER_RE = /un-hold\s*조건/i;

/** 의존 workitem id 후보 — 이 저장소의 workitem 이름 관례(kebab-case, 하이픈 1개 이상)와 일치. */
const DEP_ID_RE = /[a-z][a-z0-9]*(?:-[a-z0-9]+)+/g;

/**
 * hold 파일 본문에서 "un-hold 조건" 절을 찾아 참조하는 의존 workitem id 를 뽑는다(AC-01).
 * 마커 뒤 첫 비어있지 않은 절(같은 줄에 콜론+내용이 있으면 그 줄, 헤딩 스타일이면 다음 줄)만
 * 조건절로 본다 — 문서 뒷부분의 다른 kebab-case 언급(파일 경로, 다른 워크아이템 참조 등)이
 * 섞여 들어가지 않는다. 마커 자체가 없으면(전략문서·판별불가) 빈 배열 — AC-03 이 이 빈
 * 배열을 "un-hold 하지 않음" 신호로 쓴다.
 *
 * 알려진 한계(리뷰 지적, LOW): 조건절은 **한 줄**만 본다. 의존 목록이 줄바꿈으로
 * 두 줄 이상에 걸치면 뒤쪽 의존이 조용히 누락돼 조기 un-hold 위험이 있다 — 지금까지
 * 관측된 hold 포맷(F-01 실측)이 전부 한 줄이라 실사용 리스크는 낮지만, un-hold 조건을
 * 여러 줄로 쓰는 관례가 생기면 이 함수부터 다시 봐야 한다.
 */
export function parseHoldDependencies(content: string): string[] {
  const marker = CONDITION_MARKER_RE.exec(content);
  if (!marker) {
    return [];
  }
  const afterMarker = content.slice(marker.index + marker[0].length);
  let clause = '';
  for (const rawLine of afterMarker.split('\n')) {
    const line = rawLine.replace(/^[*#\s:：]+/, '').trim();
    if (line.length > 0) {
      clause = line;
      break;
    }
  }
  if (!clause) {
    return [];
  }
  const ids = clause.match(DEP_ID_RE) ?? [];
  return [...new Set(ids)];
}

/** un-hold 하지 않고 유지한 hold 하나의 사유(AC-03). */
export interface HoldKept {
  name: string;
  reason: 'no-condition' | 'unsatisfied';
  waitingOn?: string[];
}

export interface HoldRecheckResult {
  /** 이번 재점검으로 `.hold.md` → `.md` 된 workitem 이름(정렬됨). */
  unheld: string[];
  kept: HoldKept[];
}

function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * root/.tasks/plan 의 `*.hold.md` 를 전부 재점검한다(AC-01/02/03).
 *
 * 의존 착지+합격 판정은 status.ts 의 pipelineLanes 를 그대로 재사용한다 —
 * "exec/<dep>.taken.md 존재 & review/<dep>.md 부재" 는 이미 그 함수의 'complete'
 * 상태와 같은 정의라 중복 구현하지 않는다. 다건 의존은 전부 'complete' 여야
 * un-hold(AC-02) — 하나라도 미충족이면 그 hold 는 그대로 둔다(AC-03).
 *
 * rename 은 내용을 다시 쓰지 않는다(`fs.renameSync` 만 — 내용 불변, AC-02).
 * 동기 함수라 이 호출이 끝나면 plan 디렉토리는 이미 최신 상태다 — 호출부(스킬)가
 * 같은 턴에 바로 재스캔해도 un-hold 된 파일이 즉시 보인다(AC-04, 별도 지연 없음).
 */
export function recheckHolds(root: string): HoldRecheckResult {
  const planDir = path.join(root, '.tasks', 'plan');
  const execDir = path.join(root, '.tasks', 'exec');
  const reviewDir = path.join(root, '.tasks', 'review');

  const planFiles = readDirNames(planDir);
  const execFiles = readDirNames(execDir);
  const reviewFiles = readDirNames(reviewDir);
  const lanes = pipelineLanes(planFiles, execFiles, reviewFiles);
  const landed = (id: string): boolean => lanes.find((l) => l.name === id)?.status === 'complete';

  const unheld: string[] = [];
  const kept: HoldKept[] = [];

  for (const file of planFiles) {
    if (!file.endsWith(HOLD_SUFFIX)) {
      continue;
    }
    const name = file.slice(0, -HOLD_SUFFIX.length);
    const fullPath = path.join(planDir, file);
    const content = fs.readFileSync(fullPath, 'utf8');
    const deps = parseHoldDependencies(content);
    if (deps.length === 0) {
      kept.push({ name, reason: 'no-condition' });
      continue;
    }
    const waitingOn = deps.filter((d) => !landed(d));
    if (waitingOn.length > 0) {
      kept.push({ name, reason: 'unsatisfied', waitingOn });
      continue;
    }
    fs.renameSync(fullPath, path.join(planDir, `${name}.md`));
    unheld.push(name);
  }
  unheld.sort();
  return { unheld, kept };
}

export async function runHoldRecheck(opts: { json: boolean }): Promise<void> {
  const root = resolveProjectRoot();
  if (!root) {
    const cc = caps();
    process.stderr.write(
      `\n  ${signal(cc, 'error')} 프로젝트 루트를 찾을 수 없습니다.\n      awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const result = recheckHolds(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const c = caps();
  const color = makeColors(c.color);
  const lines: string[] = [];
  if (result.unheld.length === 0 && result.kept.length === 0) {
    lines.push('재점검할 hold 가 없습니다.');
  }
  for (const name of result.unheld) {
    lines.push(`${signal(c, 'ok')} ${color.bold(name)}  un-hold (의존 착지+합격)`);
  }
  for (const k of result.kept) {
    const why =
      k.reason === 'no-condition'
        ? '패턴 없음(전략문서 등)'
        : `대기: ${(k.waitingOn ?? []).join(', ')}`;
    lines.push(`${signal(c, 'warn')} ${color.dim(k.name)}  hold 유지  ${color.dim(`(${why})`)}`);
  }
  process.stdout.write(`${card('hold 재점검', lines, c)}\n`);
}
