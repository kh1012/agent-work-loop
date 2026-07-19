import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/runner.js';
import {
  type Caps,
  type PipelineStatus,
  caps,
  card,
  makeColors,
  makeSymbols,
  makeTokens,
  padEndDisplay,
  signal,
  statusBadge,
  stringWidth,
} from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { WORKTREES_DIR } from './lane.js';
import { archiveAllLanes } from './pipeline-archive.js';
import { readRecords } from './record.js';
import { loadState } from './state.js';

/**
 * awl status — 지금 어디까지 왔는지 한눈에 보여준다.
 *
 * doctor 는 환경·설치 점검이고, status 는 진행 상황이다.
 * verify 는 느려서 실행하지 않는다(status 는 빠른 요약이어야 한다).
 * 마지막 검증 상태는 최근 attempt 기록의 result 로 대체 표시한다.
 * 기존 loadState/readRecords 를 조합할 뿐, 새 저장소를 만들지 않는다.
 */

/** dependsOn 이 아직 안 끝난(passed 아닌) 완료 조건. 순수 계산이지 판단이 아니다(WI-E). */
export interface BlockedByDeps {
  id: string;
  waitingOn: string[];
}

/** 게이트 1/2 의 기록 상태 (WI-Q AC-03). recorded:false 면 나머지 필드는 없다. */
export interface GateStatus {
  gate: 1 | 2;
  recorded: boolean;
  decision?: string;
  at?: string;
  presentedCriteriaCount?: number;
  presentedExclusionsCount?: number;
  auto?: boolean;
}

/**
 * 완료조건 커밋이 지금 HEAD 에 없다는 "사실"(wi8-F3). awl 은 어느 계보가 맞다고
 * 판단하지 않는다 — diverged(커밋은 있으나 HEAD 조상 아님, 다른 계보)와
 * not-found(커밋 객체가 이 클론에 없음)만 구분해 표시한다.
 */
export interface MissingAcCommit {
  id: string;
  commit: string;
  reason: 'diverged' | 'not-found';
}

export interface StatusReport {
  generation: number;
  phase: string | null;
  workitem: string | null;
  criteria: {
    total: number;
    passed: number;
    blocked: number;
    inProgress: number;
    pending: number;
    blockedByDeps: BlockedByDeps[];
  };
  records: { total: number; byType: Record<string, number> };
  lastAttempt: string | null;
  gates: GateStatus[];
  // 커밋 SHA 대조는 git 을 써야 해서 동기 buildStatus 밖(checkMissingAcCommits)에서
  // 채운다. 옵션 필드라 buildStatus 만 부르는 기존 경로/테스트는 영향 없다.
  missingAcCommits?: MissingAcCommit[];
}

/**
 * 현재 워크아이템의 게이트 1/2 기록을 찾는다. readRecords 는 최근순이라
 * 같은 게이트 번호가 여러 번 기록됐어도(재승인 등) 첫 번째로 만나는 게 최신이다.
 * gate 레코드가 없어도(대기중) 항상 두 항목(1, 2)을 돌려준다 — 계산만 한다.
 */
function buildGateStatus(records: Record<string, unknown>[]): GateStatus[] {
  const gateRecords = records.filter((r) => r.type === 'gate');
  return ([1, 2] as const).map((gate) => {
    const rec = gateRecords.find((r) => r.gate === gate);
    if (!rec) {
      return { gate, recorded: false };
    }
    const presentedCriteria = Array.isArray(rec.presentedCriteria) ? rec.presentedCriteria : [];
    const presentedExclusions = Array.isArray(rec.presentedExclusions)
      ? rec.presentedExclusions
      : [];
    return {
      gate,
      recorded: true,
      decision: typeof rec.decision === 'string' ? rec.decision : undefined,
      at: typeof rec.at === 'string' ? rec.at : undefined,
      presentedCriteriaCount: presentedCriteria.length,
      presentedExclusionsCount: presentedExclusions.length,
      auto: typeof rec.auto === 'boolean' ? rec.auto : undefined,
    };
  });
}

/**
 * dependsOn 그래프를 순회해 아직 안 끝난 선행 완료조건이 있는 것만 뽑는다.
 * 이미 passed 인 완료조건은(dependsOn 이 나중에 붙었더라도) 블록으로 안 본다 —
 * 이미 끝난 일을 다시 막을 이유가 없다. 어느 걸 먼저 할지 정하는 건 여전히
 * 스킬(에이전트) 몫이다 — 여기선 계산만 한다.
 *
 * 순환/오타 감지는 하지 않는다(리뷰 지적 AC-04 — 의도적 단순화). dependsOn 이
 * 자기 자신을 가리키거나(A → A) 존재하지 않는 ID 를 가리키면 그 완료조건은
 * 영구적으로 블록됨으로 표시된다 — 크래시나 무한루프는 없지만, 이게 진짜
 * 순환/의존 대기인지 오타인지는 표시만으로 구분 못 한다. 이 표시 자체가
 * "뭔가 이상하다"는 신호이므로 스킬(에이전트)이 보고 판단한다.
 */
function computeBlockedByDeps(criteria: Record<string, unknown>[]): BlockedByDeps[] {
  const passedIds = new Set(criteria.filter((c) => c.status === 'passed').map((c) => String(c.id)));
  const blocked: BlockedByDeps[] = [];
  for (const c of criteria) {
    if (c.status === 'passed') {
      continue;
    }
    const dependsOn = Array.isArray(c.dependsOn) ? (c.dependsOn as unknown[]) : [];
    const waitingOn = dependsOn.map(String).filter((d) => !passedIds.has(d));
    if (waitingOn.length > 0) {
      blocked.push({ id: String(c.id), waitingOn });
    }
  }
  return blocked;
}

export function buildStatus(projectRoot: string): StatusReport {
  const state = loadState(projectRoot);
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  const count = (s: string): number => criteria.filter((c) => c.status === s).length;

  const records = readRecords();
  const byType: Record<string, number> = {};
  for (const r of records) {
    const t = String(r.type);
    byType[t] = (byType[t] ?? 0) + 1;
  }
  // readRecords 는 at 기준 내림차순이므로 첫 번째 attempt 가 가장 최근이다.
  const latestAttempt = records.find((r) => r.type === 'attempt');
  const lastAttempt =
    latestAttempt && typeof latestAttempt.result === 'string' ? latestAttempt.result : null;

  // 게이트 이력은 현재 워크아이템 것만 본다(다른 워크아이템 게이트가 섞이면 안 됨).
  const workitem = typeof state.workitem === 'string' ? state.workitem : null;
  const gates = buildGateStatus(records.filter((r) => r.workitem === workitem));

  return {
    generation: typeof state.generation === 'number' ? state.generation : 1,
    phase: typeof state.phase === 'string' ? state.phase : null,
    workitem,
    gates,
    criteria: {
      total: criteria.length,
      passed: count('passed'),
      blocked: count('blocked'),
      inProgress: count('in_progress'),
      pending: count('pending'),
      blockedByDeps: computeBlockedByDeps(criteria),
    },
    records: { total: records.length, byType },
    lastAttempt,
  };
}

/**
 * git merge-base --is-ancestor <commit> HEAD 의 exit code 를 사실로 분류한다.
 *   0   = HEAD 조상(포함됨)                   → present
 *   1   = 조상 아님(커밋은 있으나 다른 계보)   → diverged
 *   128 = 커밋 객체가 이 클론에 없음           → not-found
 *   그 외(null=타임아웃/시그널, 기타 에러)     → unknown (판정 불가)
 * unknown 을 not-found 로 뭉뚱그리면 git 이 판정도 못 했는데 "커밋 없음"이라는
 * 거짓 사실을 표시하게 된다 — awl 은 확실한 사실만 표시한다(리뷰 지적).
 */
export function classifyAncestorExit(
  exitCode: number | null,
): 'present' | 'diverged' | 'not-found' | 'unknown' {
  if (exitCode === 0) {
    return 'present';
  }
  if (exitCode === 1) {
    return 'diverged';
  }
  if (exitCode === 128) {
    return 'not-found';
  }
  return 'unknown';
}

/**
 * 완료조건 커밋(criterion.commit) 중 지금 HEAD 조상이 아닌 것을 사실로 수집한다(wi8-F3).
 * commit 필드가 있는 완료조건만 본다. git 저장소가 아님/HEAD 없음/git 미설치면 빈 배열
 * (status 는 절대 크래시하지 않는다 — gitBranch 와 같은 원칙). 확실히 판정된 것
 * (diverged/not-found)만 보고하고 unknown(판정 불가)은 지어내지 않고 건너뛴다.
 */
export async function checkMissingAcCommits(projectRoot: string): Promise<MissingAcCommit[]> {
  const state = loadState(projectRoot);
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  const withCommit = criteria.filter(
    (c): c is Record<string, unknown> & { commit: string } =>
      typeof c.commit === 'string' && c.commit.length > 0,
  );
  if (withCommit.length === 0) {
    return [];
  }
  try {
    const head = await run({
      cmd: 'git',
      args: ['rev-parse', '--verify', '--quiet', 'HEAD'],
      cwd: projectRoot,
      timeoutMs: 10_000,
    });
    if (head.exitCode !== 0) {
      return [];
    }
    const out: MissingAcCommit[] = [];
    for (const c of withCommit) {
      const r = await run({
        cmd: 'git',
        args: ['merge-base', '--is-ancestor', c.commit, 'HEAD'],
        cwd: projectRoot,
        timeoutMs: 10_000,
      });
      const kind = classifyAncestorExit(r.exitCode);
      // present(포함) 또는 unknown(판정 불가)이면 사실을 표시하지 않는다.
      if (kind === 'diverged' || kind === 'not-found') {
        out.push({ id: String(c.id), commit: c.commit, reason: kind });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 게이트 decision 상태값 색코딩(F-05): 승인=green, 거부/중단=danger, 수정/추가작업=warning. */
function decisionColored(t: ReturnType<typeof makeTokens>, decision: string): string {
  if (decision === 'approved') {
    return t.success(decision);
  }
  if (decision === 'rejected' || decision === 'abandoned') {
    return t.danger(decision);
  }
  if (decision === 'modified' || decision === 'more-work' || decision === 'split') {
    return t.warning(decision);
  }
  return decision;
}

export function renderStatus(report: StatusReport, c: Caps): string {
  const color = makeColors(c.color);
  const t = makeTokens(c);
  const s = makeSymbols(c);

  // 아직 시작 전: 상태도 기록도 없다.
  if (report.phase === null && report.criteria.total === 0 && report.records.total === 0) {
    return card(
      '진행 상황',
      [
        `${signal(c, 'info')} 아직 시작 전입니다.`,
        `${s.lastBranch} 목표를 주고 awl-loop 를 실행하세요.`,
      ],
      c,
    );
  }

  const cr = report.criteria;
  const typeSummary = Object.entries(report.records.byType)
    .map(([t, n]) => `${t} ${n}`)
    .join(' · ');

  const out: string[] = [];
  out.push(
    `단계  ${report.phase ?? '(없음)'}${report.workitem ? `  ${color.dim(report.workitem)}` : ''}`,
  );
  out.push(
    `${s.branch} 완료 조건  ${color.bold(`${cr.passed}/${cr.total}`)} 통과  ${color.dim(`(막힘 ${cr.blocked}, 진행 ${cr.inProgress}, 대기 ${cr.pending})`)}`,
  );
  for (const b of cr.blockedByDeps) {
    out.push(
      `${s.vGuide}   ${s.lastBranch} ${signal(c, 'warn')} ${color.yellow(b.id)} 블록됨  ${color.dim(`(대기: ${b.waitingOn.join(', ')})`)}`,
    );
  }
  // 캐노니컬 HEAD 검증(wi8-F3): 완료조건 커밋이 지금 HEAD 에 없다는 사실만 표시한다.
  for (const m of report.missingAcCommits ?? []) {
    const why = m.reason === 'diverged' ? '다른 계보' : '커밋 없음';
    out.push(
      `${s.vGuide}   ${s.lastBranch} ${signal(c, 'warn')} ${color.yellow(m.id)} 커밋이 HEAD에 없음  ${color.dim(`(${m.commit.slice(0, 10)}, ${why})`)}`,
    );
  }
  out.push(
    `${s.branch} 기록       ${report.records.total}개  ${color.dim(typeSummary ? `(${typeSummary})` : '')}`,
  );
  out.push(`${s.lastBranch} 최근 검증  ${report.lastAttempt ?? color.dim('(없음)')}`);
  for (const g of report.gates) {
    if (!g.recorded) {
      out.push(`    ${s.lastBranch} ${signal(c, 'info')} 게이트 ${g.gate}  ${color.dim('대기중')}`);
      continue;
    }
    const when = g.at ? g.at.slice(0, 16).replace('T', ' ') : '';
    const summary = `완료조건 ${g.presentedCriteriaCount ?? 0}개, 제외 ${g.presentedExclusionsCount ?? 0}건`;
    const autoTag = g.auto ? color.dim(' (자동)') : '';
    out.push(
      `    ${s.lastBranch} 게이트 ${g.gate}  ${decisionColored(t, g.decision ?? '')}${autoTag}   ${when}   ${color.dim(summary)}`,
    );
  }
  return card(`진행 상황 · ${report.generation}세대`, out, c);
}

/** 한 파이프라인 레인의 workitem 상태(pipeline-status-tracking AC-02). */
export interface PipelineLane {
  name: string;
  status: PipelineStatus;
}

/**
 * 마커 잔재(.taken/.hold/.pass)와 .md 를 벗겨 workitem 이름으로 정규화한다. pipelineLanes 의
 * 상태판정(base 계산)과 pipeline-archive.ts 의 물리 파일목록화(ownedFiles)가 같은 마커 접미사
 * 집합을 봐야 하므로 export 해 공유한다 — 복제하면 마커 접미사가 늘 때 한쪽만 갱신돼 일부
 * 파일만 이동하는 desync 가 재발한다(리뷰 지적, pipeline-archive-cleanup).
 */
export function markerBaseName(f: string): string {
  return f.replace(/\.md$/, '').replace(/\.(taken|hold|pass)$/, '');
}

/**
 * .tasks/{plan,exec,review} 의 파일명만으로 레인별 workitem 상태를 판정한다(순수, 파일 내용 안 엶).
 * 마커 규약은 awl-pipeline-* 스킬 계약과 단일 진실(`.taken`)로 통일한다(pipeline-marker-finalization):
 * claim=plan/<name>.taken.md, 합격=exec/<name>.taken.md 이고 review 수정요구 없음(무파일 합격 계약).
 *
 * 우선순위: review/<name>.md(미반영 수정요구)=blocked → plan/<name>.hold.md(에스컬레이션)=blocked →
 * exec/<name>.taken.md(검증함·수정요구 없음)=complete → exec/<name>.md(미검증 핸드오프)=reviewing →
 * plan/<name>.taken.md(착수)=executing → plan/<name>.md(신규)=pending.
 */
export function pipelineLanes(
  planFiles: string[],
  execFiles: string[],
  reviewFiles: string[],
): PipelineLane[] {
  const isMd = (f: string): boolean => f.endsWith('.md');
  const names = new Set<string>();
  for (const f of [...planFiles, ...execFiles, ...reviewFiles]) {
    if (isMd(f)) {
      names.add(markerBaseName(f));
    }
  }
  const lanes: PipelineLane[] = [];
  for (const name of names) {
    let status: PipelineStatus;
    if (reviewFiles.includes(`${name}.md`)) {
      status = 'blocked'; // review/<name>.md = 미반영 수정요구(review/<name>.taken.md 반영본은 complete/reviewing 으로)
    } else if (planFiles.includes(`${name}.hold.md`)) {
      status = 'blocked'; // hold = 사람 에스컬레이션(멈춤)
    } else if (execFiles.includes(`${name}.taken.md`)) {
      status = 'complete'; // exec 검증함 표식 + review 수정요구 없음 = 무파일 합격 계약
    } else if (execFiles.includes(`${name}.md`)) {
      status = 'reviewing'; // exec/<name>.md 미검증 핸드오프 = review 대기
    } else if (planFiles.includes(`${name}.taken.md`)) {
      status = 'executing'; // plan claim 표식(착수, 핸드오프 전)
    } else {
      status = 'pending'; // plan/<name>.md 신규
    }
    lanes.push({ name, status });
  }
  lanes.sort((a, b) => a.name.localeCompare(b.name));
  return lanes;
}

/**
 * workitem/레인 이름 열 폭 — 표시폭(stringWidth) 기준이라 한글(표시폭 2)도 정렬된다(F-03).
 * .length(UTF-16)로 재면 padEndDisplay(표시폭 기준)와 어긋나 한글 이름의 status 열이 밀린다.
 */
function nameColWidth(names: string[]): number {
  return Math.max(...names.map(stringWidth), 4) + 2;
}

/**
 * 디렉토리 파일명을 읽는다(없으면 빈 배열 — awl 은 파이프라인 유무를 판단하지 않는다).
 * pipeline-archive-cleanup AC-01 이 이 함수와 pipelineLanes 를 그대로 재사용한다(export) —
 * 보관 모듈이 별도 파일목록 읽기·마커 판정을 새로 구현하지 않는다.
 */
export function readDirNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 한 레인(워크트리)의 workitem 롤업(pipeline-status-view AC-01). name 은 레인
 * (`.awl-worktrees/<name>`) 디렉토리명, workitems 는 그 레인의 .tasks/ 를
 * pipelineLanes 로 판정한 결과다. 기존 PipelineLane({name,status})은 workitem 하나다.
 */
export interface PipelineLaneGroup {
  name: string;
  workitems: PipelineLane[];
}

/**
 * `.awl-worktrees/*`(레인 진실원천, F-05)를 순회해 레인마다 pipelineLanes 를 재적용한다
 * (AC-01). 순수 판정(pipelineLanes)은 재사용하고 레인 그룹핑 계층만 얹는다 — 파일명만
 * 보고 내용은 안 엶(기존 방식 유지). `.awl-worktrees/` 자체가 없으면 빈 배열이라
 * 호출부가 단일 .tasks/ 폴백을 스스로 정한다(AC-02). git 을 쓰지 않아 status 는
 * 절대 크래시하지 않는다(readDirNames 원칙과 동일).
 */
export function collectPipelineLaneGroups(root: string): PipelineLaneGroup[] {
  const base = path.join(root, WORKTREES_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // .awl-worktrees/ 부재 = 레인 없음 → 폴백.
  }
  const groups: PipelineLaneGroup[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const tasks = path.join(base, e.name, '.tasks');
    const workitems = pipelineLanes(
      readDirNames(path.join(tasks, 'plan')),
      readDirNames(path.join(tasks, 'exec')),
      readDirNames(path.join(tasks, 'review')),
    );
    groups.push({ name: e.name, workitems });
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  return groups;
}

/**
 * 메인 트리 .tasks/ 를 하나의 레인 그룹('main')으로 롤업한다(F-01). 레인 워크트리의 .tasks/
 * 는 gitignore 라 빈 껍데기이므로, 레인이 하나라도 있으면 collectPipelineLaneGroups 만으론
 * 메인의 실작업이 통째 숨는다 — 이 그룹을 앞에 붙여 메인을 항상 포함한다. 파일명만 보고
 * 내용은 안 엶(pipelineLanes 재사용).
 */
function mainTreeGroup(root: string): PipelineLaneGroup {
  const tasks = path.join(root, '.tasks');
  return {
    name: 'main',
    workitems: pipelineLanes(
      readDirNames(path.join(tasks, 'plan')),
      readDirNames(path.join(tasks, 'exec')),
      readDirNames(path.join(tasks, 'review')),
    ),
  };
}

/**
 * 교차 레인 롤업을 레인 헤더로 그룹핑해 렌더한다(AC-01). statusBadge·padEndDisplay 로
 * 배지·열 맞춤을 하되, 레인마다 헤더를 얹고 그 아래 workitem 을 들여쓴다. 열 폭은 전
 * 레인의 workitem 이름 기준으로 통일한다.
 */
export function renderPipelineGroups(groups: PipelineLaneGroup[], c: Caps): string {
  const color = makeColors(c.color);
  const allNames = groups.flatMap((g) => g.workitems.map((w) => w.name));
  const nameWidth = nameColWidth(allNames);
  const out: string[] = [];
  groups.forEach((g, i) => {
    if (i > 0) {
      out.push('');
    }
    out.push(color.bold(g.name));
    if (g.workitems.length === 0) {
      out.push(`  ${color.dim('(workitem 없음)')}`);
      return;
    }
    for (const w of g.workitems) {
      out.push(`  ${statusBadge(c, w.status)}  ${padEndDisplay(w.name, nameWidth)}${w.status}`);
    }
  });
  return card(`파이프라인 ${groups.length}개 레인`, out, c);
}

export async function runStatus(opts: {
  json: boolean;
  pipeline?: boolean;
  archive?: boolean;
}): Promise<void> {
  const root = resolveProjectRoot();
  if (!root) {
    const cc = caps();
    process.stderr.write(
      `\n  ${signal(cc, 'error')} 프로젝트 루트를 찾을 수 없습니다.\n      ${makeSymbols(cc).lastBranch} awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  // --pipeline: temp-loop 하네스의 .tasks/{plan,exec,review} 레인 상태를 배지로 낸다(opt-in).
  // awl 코어의 일반 status 와 분리 — .tasks 가 없으면 빈 뷰다(awl 은 하네스 유무를 판단 안 함).
  if (opts.pipeline === true) {
    // --archive(pipeline-archive-cleanup AC-05): 유예(3일) 지난 complete workitem을
    // archive/<name>/ 로 옮긴 뒤(기계적·게이트 불요) 그 결과를 반영해 렌더한다. F-03 판정
    // 함수(pipelineLanes)를 archiveAllLanes 가 그대로 소비하므로 여기서 새 판정을 하지 않는다.
    let archived: Record<string, string[]> | undefined;
    if (opts.archive === true) {
      archived = archiveAllLanes(root);
    }
    // 교차 레인 롤업: 메인 트리 .tasks/ 를 항상 'main' 그룹으로 앞에 두고(F-01: 레인이 생겨도
    // 메인 안 숨김), .awl-worktrees/* 레인 그룹을 잇는다. 폴백(레인 없음)·다중(레인 있음)이
    // 같은 {name,workitems[]} 스키마라 --json 소비자가 런타임 상태로 갈리지 않는다(F-02).
    // archiveAllLanes 가 먼저 파일을 옮겼다면 이 재계산에는 보관된 workitem이 빠져 있다
    // (archive/ 는 readDirNames 가 plan/exec/review 서브디렉토리만 읽어 구조적으로 제외).
    const groups = [mainTreeGroup(root), ...collectPipelineLaneGroups(root)];
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ lanes: groups, ...(archived ? { archived } : {}) }, null, 2)}\n`,
      );
    } else {
      if (archived) {
        const total = Object.values(archived).reduce((n, names) => n + names.length, 0);
        const color = makeColors(caps().color);
        process.stdout.write(`  보관 ${color.bold(String(total))}건\n`);
      }
      process.stdout.write(`${renderPipelineGroups(groups, caps())}\n`);
    }
    return;
  }
  // buildStatus 는 동기 유지(기존 호출/테스트 보존). 커밋 SHA 대조는 git 이 필요해
  // 여기서 async 로 덧붙인다 — 없으면 빈 배열이라 렌더/JSON 모두 영향 없다.
  const report: StatusReport = {
    ...buildStatus(root),
    missingAcCommits: await checkMissingAcCommits(root),
  };
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderStatus(report, caps())}\n`);
  }
}
