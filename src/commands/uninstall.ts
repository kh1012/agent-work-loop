import fs from 'node:fs';
import path from 'node:path';
import {
  engineDir,
  globalRoot,
  gotchasDir,
  legacyDeltasDir,
  lockFile,
  npmVersionCachePath,
  projectsFile,
  recordsDir,
  rulesDir,
  templatesDir,
} from '../core/paths.js';
import { type Caps, caps, card, makeColors, signal } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { packageEngineDir } from './init.js';
import {
  type LaneInfo,
  branchOf,
  collectLanes,
  laneBranchMap,
  unmergedCommitCount,
  worktreeUntracked,
} from './lane.js';
import { removeGitWorktree, worktreeDirtyTracked } from './work.js';

/**
 * awl uninstall — awl 이 손댄 모든 흔적(전역 홈 + 프로젝트 로컬 + 알려진 레거시 경로)을
 * 지운다. 기본은 드라이런이다 — --yes 없이는 파일시스템을 절대 바꾸지 않는다(AC-01).
 *
 * 목적: "완전히 새로 설치한 사용자" 상태를 재현할 수 있게 한다. 다음 `awl init` 이
 * 진짜 최초 설치처럼 동작해야 한다(AC-07).
 */

export interface UninstallItem {
  /** 사람이 읽는 카테고리 라벨(목록/JSON 공통). */
  category: string;
  scope: 'project' | 'global';
  /** 현재 코드가 만들지 않는, 과거 버전이 남긴 경로인가(F-05). */
  legacy: boolean;
  kind: 'dir' | 'file' | 'partial' | 'worktree';
  path: string;
  /** 실제로 디스크에 있는가(스캔 시점). */
  present: boolean;
  /** --yes 실행 시 이 항목을 실제로 지울 수 있는가(예: pre-push 템플릿 불일치면 false). */
  removable: boolean;
  detail?: string;
}

function requireRoot(): string {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  return root;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

const AGENTS_MARKER_START = '<!-- awl-loop:start -->';
const AGENTS_MARKER_END = '<!-- awl-loop:end -->';

/**
 * AGENTS.md 에서 awl 마커 구간(`<!-- awl-loop:start -->`~`<!-- awl-loop:end -->`, 포함)만
 * 잘라낸다(AC-04, 파일 전체 삭제 금지). init.ts installCodexSkill 이 붙일 때 남기는
 * 구분용 빈 줄도 함께 정리해 앞뒤 내용 사이에 어색한 빈 줄이 남지 않게 한다. 마커가
 * 없으면 원본을 그대로 돌려준다(removed:false).
 */
export function stripAwlAgentsBlock(content: string): { content: string; removed: boolean } {
  const start = content.indexOf(AGENTS_MARKER_START);
  if (start === -1) {
    return { content, removed: false };
  }
  const endIdx = content.indexOf(AGENTS_MARKER_END, start);
  if (endIdx === -1) {
    return { content, removed: false }; // 마커가 깨졌으면(짝 없음) 손대지 않는다.
  }
  const blockEnd = endIdx + AGENTS_MARKER_END.length;

  let removeStart = start;
  while (removeStart > 0 && content[removeStart - 1] === '\n') {
    removeStart--;
  }
  let removeEnd = blockEnd;
  while (removeEnd < content.length && content[removeEnd] === '\n') {
    removeEnd++;
  }

  const before = content.slice(0, removeStart);
  const after = content.slice(removeEnd);
  const next =
    before.length > 0 && after.length > 0 ? `${before}\n\n${after}` : `${before}${after}`;
  return { content: next, removed: true };
}

/** pre-push 훅 내용이 awl 설치 템플릿과 정확히 일치하는가(AC-04, 앞뒤 공백만 무시). */
function prePushMatchesTemplate(prePushPath: string): boolean {
  try {
    const actual = fs.readFileSync(prePushPath, 'utf8').trim();
    const template = fs
      .readFileSync(path.join(packageEngineDir(), 'templates', 'pre-push.sample'), 'utf8')
      .trim();
    return actual === template;
  } catch {
    return false;
  }
}

/**
 * `.tasks/watch-inputs.sh`(awl-pipeline 워처)가 쓰는 락 프로토콜의 stale 임계값(초).
 * 워처 자신의 STALE=60 과 반드시 같은 값을 써야 한다 — 이 값이 어긋나면 워처가
 * 살아있다고 보는 락을 uninstall 이 죽었다고 오판(또는 그 반대)할 수 있다.
 */
const LOCK_STALE_SECS = 60;

export interface LockStatus {
  role: 'exec' | 'review';
  path: string;
  live: boolean;
  pid?: number;
  ageSec?: number;
  reason?: string;
}

/** PID 가 살아있는가(`kill -0`). ESRCH=죽음, EPERM=존재(권한만 없음)로 POSIX 관례를 따른다. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `.tasks/.locks/{exec,review}` 의 라이브 프로세스 여부를 확인한다(AC-06, 최우선
 * 안전장치). watch-inputs.sh 의 락 프로토콜(mkdir 로 획득한 디렉토리 안에 pid/beat
 * 파일)을 그대로 읽는다 — 쓰지 않는다(읽기 전용, 드라이런에서도 안전하게 호출 가능).
 * pid 가 없거나 죽었으면, 또는 heartbeat 가 STALE_SECS 이상 지났으면 live:false다.
 */
export function checkLiveLocks(tasksDir: string, nowMs: number = Date.now()): LockStatus[] {
  const roles: Array<'exec' | 'review'> = ['exec', 'review'];
  const results: LockStatus[] = [];
  for (const role of roles) {
    const lockDir = path.join(tasksDir, '.locks', role);
    if (!exists(lockDir)) {
      continue;
    }
    let pid: number | undefined;
    try {
      pid = Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8').trim(), 10);
    } catch {
      pid = undefined;
    }
    if (pid === undefined || Number.isNaN(pid) || !isProcessAlive(pid)) {
      results.push({
        role,
        path: lockDir,
        live: false,
        pid,
        reason: 'pid 없음 또는 죽은 프로세스',
      });
      continue;
    }
    let beatSec: number | undefined;
    try {
      beatSec = Number.parseInt(fs.readFileSync(path.join(lockDir, 'beat'), 'utf8').trim(), 10);
    } catch {
      beatSec = undefined;
    }
    const ageSec =
      beatSec === undefined || Number.isNaN(beatSec)
        ? Number.POSITIVE_INFINITY
        : Math.floor(nowMs / 1000) - beatSec;
    const live = ageSec < LOCK_STALE_SECS;
    results.push({
      role,
      path: lockDir,
      live,
      pid,
      ageSec,
      reason: live ? undefined : `heartbeat stale(${LOCK_STALE_SECS}초 이상)`,
    });
  }
  return results;
}

/** .claude/skills/ 아래 awl 소유 스킬만 고른다 — 다른 스킬(프로젝트가 따로 설치한 것)은 절대 건드리지 않는다. */
function awlSkillDirNames(root: string): string[] {
  const dir = path.join(root, '.claude', 'skills');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && (e.name === 'awl-loop' || e.name.startsWith('awl-pipeline')),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * F-05 레거시 마커 잔재: `.tasks/**\/*ㅍ*.md` (pipeline-marker-finalization 0.6.15 이전).
 * 코드가 더는 만들지 않는 패턴이라 파일명 자체로만 찾는다.
 */
export function findMarkerLegacyFiles(root: string): string[] {
  const base = path.join(root, '.tasks');
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name.includes('ㅍ')) {
        out.push(p);
      }
    }
  };
  walk(base);
  return out;
}

/**
 * F-04 프로젝트 로컬 구성요소를 스캔한다(읽기 전용 — fs 를 쓰지 않는다). 실제로
 * 존재하는 항목만 `present:true` 로 표시한다(AC-01, "실제 발견된 것만").
 */
export function scanProjectLocal(root: string): UninstallItem[] {
  const items: UninstallItem[] = [];
  const push = (
    partial: Omit<UninstallItem, 'scope' | 'legacy' | 'removable'> &
      Partial<Pick<UninstallItem, 'legacy' | 'removable'>>,
  ): void => {
    items.push({ scope: 'project', legacy: false, removable: true, ...partial });
  };

  const dotAwl = path.join(root, '.awl');
  push({
    category: '.awl/ (config·state·skills-version·verify-baseline·state.lock·home)',
    kind: 'dir',
    path: dotAwl,
    present: exists(dotAwl),
  });

  for (const name of awlSkillDirNames(root)) {
    const p = path.join(root, '.claude', 'skills', name);
    push({ category: `.claude/skills/${name}`, kind: 'dir', path: p, present: true });
  }

  const agentsMd = path.join(root, 'AGENTS.md');
  const hasMarker =
    exists(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes('awl-loop:start');
  push({
    category: 'AGENTS.md (awl 마커 구간만 — 나머지 내용 보존)',
    kind: 'partial',
    path: agentsMd,
    present: hasMarker,
  });

  for (const sub of ['plan', 'exec', 'review', 'archive']) {
    const p = path.join(root, '.tasks', sub);
    push({ category: `.tasks/${sub}`, kind: 'dir', path: p, present: exists(p) });
  }
  const locksPath = path.join(root, '.tasks', '.locks');
  push({ category: '.tasks/.locks', kind: 'dir', path: locksPath, present: exists(locksPath) });

  const prePush = path.join(root, '.git', 'hooks', 'pre-push');
  const prePushPresent = exists(prePush);
  const prePushMatches = !prePushPresent || prePushMatchesTemplate(prePush);
  push({
    category: '.git/hooks/pre-push (awl 템플릿과 일치할 때만)',
    kind: 'partial',
    path: prePush,
    present: prePushPresent,
    removable: prePushMatches,
    detail:
      prePushPresent && !prePushMatches
        ? '내용이 awl 템플릿과 일치하지 않습니다(병합됨) — 보존'
        : undefined,
  });

  const legacyAwlHome = path.join(root, '.awl-home');
  push({
    category: '.awl-home (0.6.17 이전 레거시 경로)',
    kind: 'dir',
    path: legacyAwlHome,
    present: exists(legacyAwlHome),
    legacy: true,
  });

  for (const f of findMarkerLegacyFiles(root)) {
    push({ category: 'ㅍ 마커 잔재', kind: 'file', path: f, present: true, legacy: true });
  }

  return items;
}

function findDeltasBackups(gRoot: string): string[] {
  try {
    return fs
      .readdirSync(gRoot)
      .filter((n) => n.startsWith('deltas.backup-'))
      .map((n) => path.join(gRoot, n));
  } catch {
    return [];
  }
}

/**
 * F-02 전역 구성요소를 스캔한다(읽기 전용). globalRoot() 를 호출 시점에 읽으므로
 * AWL_HOME 재정의(테스트 격리)를 그대로 존중한다.
 */
export function scanGlobal(): UninstallItem[] {
  const items: UninstallItem[] = [];
  const push = (
    category: string,
    p: string,
    kind: UninstallItem['kind'] = 'dir',
    legacy = false,
  ): void => {
    items.push({
      scope: 'global',
      legacy,
      kind,
      path: p,
      present: exists(p),
      removable: true,
      category,
    });
  };
  push('engine/', engineDir());
  push('records/', recordsDir());
  push('gotchas/', gotchasDir());
  push('rules/', rulesDir());
  push('generations/', path.join(globalRoot(), 'generations'));
  push('templates/', templatesDir());
  push('projects.json', projectsFile(), 'file');
  push('.lock', lockFile(), 'file');
  push('npm-latest-cache.json', npmVersionCachePath(), 'file');
  push('deltas/ (레거시, gotchas 개명 이전)', legacyDeltasDir(), 'dir', true);
  for (const b of findDeltasBackups(globalRoot())) {
    items.push({
      scope: 'global',
      legacy: true,
      kind: 'file',
      path: b,
      present: true,
      removable: true,
      category: 'deltas.backup-* (레거시)',
    });
  }
  return items;
}

export interface LaneRemoveResult {
  name: string;
  removed: boolean;
  reason?: string;
}

/**
 * `.awl-worktrees/<lane>/` 를 `git worktree remove` 로 안전하게 정리한다(AC-03).
 * `rm -rf` 를 쓰지 않는다 — 그러면 `.git/worktrees/<name>` 메타가 고아로 남는다.
 * lane rm(lane.ts runLaneRemove)과 완전히 같은 3단 안전망을 재사용한다: tracked
 * 미커밋 변경, untracked 신규 파일, 병합되지 않은 커밋 중 하나라도 있으면 거부하고
 * 워크트리를 그대로 보존한다(범위 밖: 실제 작업 성과물을 강제로 날리지 않는다).
 *
 * **의도적 비대칭(리뷰 지적)**: lane rm 은 삭제 전 `mergeIsolatedHome` 으로 레인의
 * 격리 학습(gotchas/rules/generations)을 전역(`~/.awl`)에 병합한다. 여기서는 **일부러
 * 그 병합을 하지 않는다** — `--project` 스코프(기본값)로 실행됐을 수 있는데, 그 경우
 * 전역에 쓰는 순간 AC-02("--project 만으론 전역 미변경")가 깨진다. uninstall 은 애초에
 * "전부 지워 최초 설치처럼" 만드는 명령이라, 병합 없이 폐기하는 쪽이 스코프 계약과
 * 일치한다(사용자가 학습을 보존하고 싶으면 uninstall 전에 `awl lane rm` 으로 먼저
 * 병합·정리해야 한다).
 */
export async function removeLaneSafely(root: string, lane: LaneInfo): Promise<LaneRemoveResult> {
  const branches = await laneBranchMap(root);
  const branch = branchOf(branches, lane.path) ?? `work/${lane.name}`;

  const dirty = await worktreeDirtyTracked(root, lane.path);
  if (dirty.dirty) {
    return {
      name: lane.name,
      removed: false,
      reason: `커밋되지 않은 변경 ${dirty.count}건 (예: ${dirty.first})`,
    };
  }

  const untracked = await worktreeUntracked(root, lane.path);
  if (untracked.untracked) {
    return {
      name: lane.name,
      removed: false,
      reason: `커밋되지 않은 새 파일 ${untracked.count}건 (예: ${untracked.first})`,
    };
  }

  const unmerged = await unmergedCommitCount(root, branch);
  if (unmerged === null) {
    return {
      name: lane.name,
      removed: false,
      reason: `레인 브랜치 ${branch} 의 미머지 커밋 수를 확인할 수 없습니다`,
    };
  }
  if (unmerged > 0) {
    return {
      name: lane.name,
      removed: false,
      reason: `레인 브랜치 ${branch} 에 병합되지 않은 커밋 ${unmerged}개`,
    };
  }

  const removed = await removeGitWorktree(root, lane.path, branch);
  if (!removed.ok) {
    return { name: lane.name, removed: false, reason: removed.error };
  }
  if (fs.existsSync(lane.path)) {
    fs.rmSync(lane.path, { recursive: true, force: true });
  }
  return { name: lane.name, removed: true };
}

export interface UninstallScope {
  project: boolean;
  global: boolean;
}

/**
 * 스코프 플래그를 해석한다(AC-02). 기본은 `--project`(로컬만) — 전역(`~/.awl`)은
 * 다른 프로젝트와 공유하는 자원이라(F-07) 명시적으로 요구해야만(`--global`/`--all`)
 * 포함한다. `--project --global` 을 같이 주면 `--all` 과 동등하게 둘 다 포함한다.
 */
export function resolveScope(opts: {
  project?: boolean;
  global?: boolean;
  all?: boolean;
}): UninstallScope {
  if (opts.all) {
    return { project: true, global: true };
  }
  if (opts.global) {
    return { project: opts.project === true, global: true };
  }
  return { project: true, global: false };
}

interface OtherProject {
  name?: string;
  path: string;
}

/**
 * ~/.awl/projects.json 에서 현재 프로젝트를 뺀 나머지 등록 프로젝트를 읽는다(F-07,
 * AC-02) — `--global`/`--all` 실행 전 "이 프로젝트들의 학습도 같이 사라진다"를
 * 알리기 위한 근거 데이터다. 파일이 없거나 깨졌으면 빈 배열(크래시하지 않는다).
 */
export function readOtherProjects(currentRoot: string): OtherProject[] {
  try {
    const raw = JSON.parse(fs.readFileSync(projectsFile(), 'utf8'));
    if (!Array.isArray(raw)) {
      return [];
    }
    const currentResolved = path.resolve(currentRoot);
    return raw
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .filter((p) => typeof p.path === 'string' && path.resolve(p.path) !== currentResolved)
      .map((p) => ({
        name: typeof p.name === 'string' ? p.name : undefined,
        path: p.path as string,
      }));
  } catch {
    return [];
  }
}

function renderPlan(
  scope: UninstallScope,
  project: UninstallItem[],
  lanes: LaneInfo[],
  global: UninstallItem[],
  otherProjects: OtherProject[],
  lockStatuses: LockStatus[],
  c: Caps,
): string {
  const color = makeColors(c.color);
  const lines: string[] = [];

  if (scope.project) {
    lines.push(color.bold('프로젝트 로컬'));
    const pFound = project.filter((i) => i.present);
    if (pFound.length === 0 && lanes.length === 0) {
      lines.push('  (발견된 것 없음)');
    }
    for (const it of pFound) {
      const mark = it.removable ? signal(c, 'ok') : signal(c, 'warn');
      const suffix = it.detail ? ` — ${it.detail}` : '';
      lines.push(`  ${mark} ${it.legacy ? '[레거시] ' : ''}${it.category}${suffix}`);
    }
    for (const lane of lanes) {
      lines.push(
        `  ${signal(c, 'ok')} .awl-worktrees/${lane.name} (git worktree remove — 격리 학습은 병합 없이 폐기됩니다)`,
      );
    }
    const liveLocks = lockStatuses.filter((l) => l.live);
    if (liveLocks.length > 0) {
      lines.push('');
      lines.push(`  ${signal(c, 'error')} 라이브 프로세스 감지 — --yes 실행 시 중단됩니다(AC-06):`);
      for (const l of liveLocks) {
        lines.push(`      .tasks/.locks/${l.role}  PID ${l.pid} · ${l.ageSec}초 전 heartbeat`);
      }
    }
    lines.push('');
  }

  if (scope.global) {
    lines.push(color.bold('전역 (~/.awl, 다른 프로젝트와 공유)'));
    if (otherProjects.length > 0) {
      lines.push(
        `  ${signal(c, 'warn')} 다른 등록 프로젝트 ${otherProjects.length}개의 학습(gotchas/rules/records)도 함께 사라집니다:`,
      );
      for (const p of otherProjects) {
        lines.push(`      - ${p.name ?? '(이름 없음)'}  (${p.path})`);
      }
    }
    const gFound = global.filter((i) => i.present);
    if (gFound.length === 0) {
      lines.push('  (발견된 것 없음)');
    }
    for (const it of gFound) {
      lines.push(`  ${signal(c, 'ok')} ${it.legacy ? '[레거시] ' : ''}${it.category}`);
    }
    lines.push('');
  } else {
    lines.push(color.dim('전역(~/.awl) — --global 또는 --all 로만 포함됩니다 (생략)'));
    lines.push('');
  }

  lines.push(
    color.dim(
      'npm 패키지 자체는 이 명령으로 지우지 않습니다. 필요하면 npm uninstall -g agent-work-loop 를 직접 실행하세요.',
    ),
  );
  return card('awl uninstall — 드라이런(dry run)', lines, c, 40);
}

export interface UninstallOpts {
  yes?: boolean;
  json?: boolean;
  project?: boolean;
  global?: boolean;
  all?: boolean;
}

/**
 * awl uninstall 오케스트레이터. `--yes` 가 없으면 스캔·출력만 하고 반환한다
 * (fs 쓰기 0건, AC-01). `--yes` 가 있으면 스캔된 항목을 실제로 지운다. 스코프
 * (AC-02)는 project/global 을 독립적으로 켜고 끈다 — `--project` 만이면 전역은
 * 스캔조차 결과에 포함하지 않는다(전역 쓰기 0을 보장하는 가장 단순한 방법).
 */
export async function runUninstall(opts: UninstallOpts): Promise<void> {
  const root = requireRoot();
  const c = caps();
  const scope = resolveScope(opts);

  const project = scope.project ? scanProjectLocal(root) : [];
  const lanes = scope.project ? await collectLanes(root) : [];
  const global = scope.global ? scanGlobal() : [];
  const otherProjects = scope.global ? readOtherProjects(root) : [];
  // 읽기 전용(AC-06) — 드라이런에서도 안전하게 미리 보여준다.
  const lockStatuses = scope.project ? checkLiveLocks(path.join(root, '.tasks')) : [];

  // 사람용 카드는 --yes 유무와 무관하게(진행 상황 미리보기로) 항상 보여준다.
  // --json 은 "한 번에 유효한 JSON 객체 하나"가 계약이라 실행 여부에 따라
  // 마지막에 한 번만 낸다(리뷰 지적 — 예전엔 여기서 미리 찍고 실행 후 평문을
  // 추가로 더 찍어 --json 계약이 깨졌다).
  if (!opts.json) {
    process.stdout.write(
      `\n${renderPlan(scope, project, lanes, global, otherProjects, lockStatuses, c)}\n`,
    );
  }

  if (!opts.yes) {
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            dryRun: true,
            scope,
            project: project.filter((i) => i.present),
            lanes: lanes.map((l) => l.name),
            global: global.filter((i) => i.present),
            otherProjects,
            liveLocks: lockStatuses,
          },
          null,
          2,
        )}\n`,
      );
    }
    return;
  }

  // AC-06(최우선) — 워처가 도는 중이면 그 아래 디렉토리를 지우지 않는다. 프로젝트
  // 스코프가 켜져 있을 때만 확인한다(.tasks 를 안 건드리는 --global 전용은 무관).
  // 강제 플래그 없이 전체를 중단한다 — 부분 삭제로 애매한 상태를 남기지 않는다.
  if (scope.project) {
    const liveLocks = lockStatuses.filter((l) => l.live);
    if (liveLocks.length > 0) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ dryRun: false, aborted: true, reason: 'live-lock', liveLocks }, null, 2)}\n`,
        );
      } else {
        const detail = liveLocks
          .map((l) => `.tasks/.locks/${l.role} PID ${l.pid} (${l.ageSec}초 전 heartbeat)`)
          .join(', ');
        process.stderr.write(
          `\n  ${signal(c, 'error')} 라이브 프로세스가 감지돼 중단합니다 — ${detail}\n`,
        );
      }
      process.exit(1);
    }
  }

  const laneResults: LaneRemoveResult[] = [];
  for (const lane of lanes) {
    laneResults.push(await removeLaneSafely(root, lane));
  }

  const skippedItems: { category: string; reason: string }[] = [];
  for (const item of [...project, ...global]) {
    if (!item.present) {
      continue;
    }
    if (!item.removable) {
      // 예: pre-push 가 awl 템플릿과 다르면(병합됨) 보존한다(AC-04, 파일 전체 삭제 금지).
      skippedItems.push({ category: item.category, reason: item.detail ?? '보존' });
      continue;
    }
    if (path.basename(item.path) === 'AGENTS.md') {
      // AGENTS.md 는 awl 마커 구간만 잘라낸다 — 다른 내용이 있으면 파일을 남긴다(AC-04).
      const current = fs.readFileSync(item.path, 'utf8');
      const stripped = stripAwlAgentsBlock(current);
      if (stripped.removed) {
        if (stripped.content.trim() === '') {
          fs.rmSync(item.path, { force: true });
        } else {
          fs.writeFileSync(
            item.path,
            stripped.content.endsWith('\n') ? stripped.content : `${stripped.content}\n`,
          );
        }
      }
      continue;
    }
    fs.rmSync(item.path, { recursive: true, force: true });
  }

  const skippedLanes = laneResults.filter((r) => !r.removed);

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: false,
          done: true,
          scope,
          removedLanes: laneResults.filter((r) => r.removed).map((r) => r.name),
          skippedLanes,
          skippedItems,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const color = makeColors(c.color);
  if (skippedLanes.length > 0) {
    process.stdout.write(`\n  ${signal(c, 'warn')} 보존된 레인(강제 제거 안 함):\n`);
    for (const r of skippedLanes) {
      process.stdout.write(`      .awl-worktrees/${r.name} — ${r.reason}\n`);
    }
  }
  if (skippedItems.length > 0) {
    process.stdout.write(`\n  ${signal(c, 'warn')} 보존된 항목(그대로 둠):\n`);
    for (const s of skippedItems) {
      process.stdout.write(`      ${s.category} — ${s.reason}\n`);
    }
  }
  process.stdout.write(`\n  ${signal(c, 'ok')} ${color.bold('삭제 완료')}\n`);
}
