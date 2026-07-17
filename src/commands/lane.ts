import fs from 'node:fs';
import path from 'node:path';
import { run } from '../core/runner.js';
import { type Caps, caps, card, feedback, makeColors, signal } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { mergeIsolatedHome } from './learning-merge.js';
import { loadState, writeState } from './state.js';
import {
  removeGitWorktree,
  removeWorkitemFromState,
  runWorkNew,
  sanitizeForGit,
  worktreeDirtyTracked,
} from './work.js';

/**
 * awl lane — 격리 레인(worktree + 전용 AWL_HOME + 스킬 + 기동 안내)을 만들고
 * 조회·정리한다 (P1 멀티레인). 개념만 신규다 — 생성 자체는 work new --worktree
 * --isolated 원시경로를 그대로 재사용하고(runWorkNew), 정리는 removeGitWorktree 를
 * 재사용한다. lane 은 그 조립 + 레인 어휘의 기동 안내만 얹는다.
 */

/** 레인 진실원천 디렉토리(F-05). status --pipeline 교차 레인 롤업도 이 단일 출처를 쓴다. */
export const WORKTREES_DIR = '.awl-worktrees';

// 레인의 각 역할 세션이 실행할 파이프라인 스킬 트리거(engine/skills/claude/ 에 대응).
const PIPELINE_TRIGGERS = ['/awl-pipeline-plan', '/awl-pipeline-exec', '/awl-pipeline-review'];

function requireRoot(): string {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  return root;
}

/** cwd 가 실제 git 워크트리 안인지 확인한다. findProjectRoot 는 .awl 만으로도 루트를 인정하므로 별도 확인이 필요하다(AC-04). */
async function isGitWorkTree(root: string): Promise<boolean> {
  const r = await run({
    cmd: 'git',
    args: ['rev-parse', '--is-inside-work-tree'],
    cwd: root,
    timeoutMs: 10_000,
  });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/**
 * awl lane new <name> — 격리 레인을 만든다(AC-01).
 *  (a) work new --worktree --isolated 재사용: .awl-worktrees/<name> + <wt>/.awl-home
 *  (b) 워크트리에 스킬 재설치(runWorkNew 안에서 installClaudeSkill)
 *  (c) 기동 안내: runWorkNew 가 export AWL_HOME 을 찍고, 여기서 역할별 스킬 트리거를 얹는다.
 * 이름 충돌·비-git cwd 는 명확한 에러로 거른다(AC-04). 생성 실패 시 orphan 워크트리
 * 롤백은 runWorkNew 가 이미 처리한다(work.ts createWorkitem 레이스 정리).
 */
export async function runLaneNew(name: string, description?: string): Promise<void> {
  const root = requireRoot();
  const c = caps();
  const color = makeColors(c.color);

  // 비-git cwd 거부(AC-04).
  if (!(await isGitWorkTree(root))) {
    process.stderr.write(
      `\n${feedback(c, 'error', '레인을 만들 수 없습니다', '현재 위치가 git 저장소가 아닙니다 — awl lane 은 git worktree 를 씁니다')}\n`,
    );
    process.exit(1);
  }

  const laneName = sanitizeForGit(name);
  if (!laneName) {
    process.stderr.write(`\n${feedback(c, 'error', '레인 이름을 입력하세요')}\n`);
    process.exit(1);
  }

  // 이름 충돌 거부(AC-04) — 레인의 진실원천은 .awl-worktrees/<name> 디렉토리(F-05).
  const lanePath = path.join(root, WORKTREES_DIR, laneName);
  if (fs.existsSync(lanePath)) {
    process.stderr.write(
      `\n${feedback(c, 'error', `이미 존재하는 레인입니다: ${laneName}`, `awl lane rm ${laneName} 로 먼저 정리하세요`)}\n`,
    );
    process.exit(1);
  }

  // 원시경로 재사용(AC-01) — worktree + isolated home + 스킬 재설치 + export AWL_HOME
  // 안내 + orphan 롤백을 runWorkNew 가 전부 처리한다. lane 은 이 위에 얇게 얹는다.
  await runWorkNew(name, description, { worktree: true, isolated: true });

  // 레인 기동 안내(AC-01 c) — export AWL_HOME 은 runWorkNew 가 이미 찍었다(단일 출처,
  // 표면 중복 금지). 여기선 역할 세션이 실행할 파이프라인 스킬 트리거만 얹는다.
  process.stdout.write(`\n${feedback(c, 'ok', `레인 준비  ${color.bold(laneName)}`)}\n`);
  process.stdout.write(`    ${color.dim('이 레인의 역할 세션에서 스킬 트리거를 실행하세요:')}\n`);
  for (const t of PIPELINE_TRIGGERS) {
    process.stdout.write(`      ${color.dim(t)}\n`);
  }
}

export interface LaneInfo {
  name: string;
  path: string;
  branch: string;
}

/**
 * git worktree list --porcelain 을 파싱해 워크트리 경로→브랜치 맵을 만든다(순수).
 * branch 라인이 있는 워크트리만 담는다 — detached 는 담지 않아, 호출부가 부재를
 * 스스로 해석한다(ls 는 '(detached)' 표시, rm 은 work/<name> 폴백).
 */
export function parseWorktreeBranches(porcelain: string): Map<string, string> {
  const map = new Map<string, string>();
  let current: string | null = null;
  for (const raw of porcelain.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      current = line.slice('worktree '.length);
    } else if (line.startsWith('branch ') && current) {
      map.set(current, line.slice('branch '.length).replace(/^refs\/heads\//, ''));
    } else if (line === '') {
      current = null;
    }
  }
  return map;
}

async function laneBranchMap(root: string): Promise<Map<string, string>> {
  const r = await run({
    cmd: 'git',
    args: ['worktree', 'list', '--porcelain'],
    cwd: root,
    timeoutMs: 10_000,
  });
  if (r.exitCode !== 0) {
    return new Map();
  }
  return parseWorktreeBranches(r.stdout);
}

/**
 * lane 브랜치가 root HEAD(메인라인)에 없는 커밋을 몇 개 갖는지 센다. removeGitWorktree
 * 가 branch -D 로 그 커밋을 파기하면 손실이라, --force 없는 rm 이 이걸로 막는다(AC-05).
 * git rev-list 가 실패하면(없는/detached 브랜치 등) null 을 돌린다 — "미머지 0개"와
 * "판정 불가"를 뭉뚱그리지 않는다(fail-open 금지, AC-04). 판정 불가는 removeGitWorktree
 * 가 워크트리 제거 후 branch -D 실패로 부분파괴하는 창이므로, 호출부가 위험으로 보고
 * --force 없이는 차단한다(미확인=위험).
 */
async function unmergedCommitCount(root: string, branch: string): Promise<number | null> {
  const r = await run({
    cmd: 'git',
    args: ['rev-list', '--count', `HEAD..${branch}`],
    cwd: root,
    timeoutMs: 10_000,
  });
  if (r.exitCode !== 0) {
    return null;
  }
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/** awl/도구가 워크트리에 만드는 산출물 경로(진짜 WIP 아님, worktreeUntracked 에서 제외). */
const AWL_INTERNAL_DIRS = new Set(['.awl', '.awl-home', '.awl-worktrees', '.claude']);

/**
 * 레인 워크트리의 genuine untracked 파일(미add 신규)을 조사한다(AC-01, F-01). work done
 * 과 공유하는 worktreeDirtyTracked 는 --untracked-files=no 라 이걸 못 본다 — lane rm 은
 * 워크트리를 통째로 파기하므로 미커밋 신규 파일도 손실이다. awl 자신의 산출물
 * (.awl/·.awl-home/ state·verify-baseline·isolated records, .awl-worktrees/, lane new 가
 * 재설치하는 .claude/)은 WIP 가 아니므로 제외한다(G-034: 도구 산출물은 도구 필터로 무시).
 */
async function worktreeUntracked(
  root: string,
  targetPath: string,
): Promise<{ untracked: boolean; count: number; first?: string }> {
  const r = await run({
    cmd: 'git',
    args: ['-C', targetPath, 'ls-files', '--others', '--exclude-standard'],
    cwd: root,
    timeoutMs: 10_000,
  });
  const files = r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((f) => !AWL_INTERNAL_DIRS.has(f.split('/')[0] ?? ''));
  return { untracked: files.length > 0, count: files.length, first: files[0] };
}

/** 워크트리 경로의 브랜치를 맵에서 찾는다. git 은 realpath 를 돌려주므로 심링크 루트에서도 맞도록 realpath 도 시도한다. */
function branchOf(branches: Map<string, string>, lanePath: string): string | undefined {
  const direct = branches.get(lanePath);
  if (direct) {
    return direct;
  }
  try {
    return branches.get(fs.realpathSync(lanePath));
  } catch {
    return undefined;
  }
}

/** .awl-worktrees/ 하위 디렉토리(진실원천, F-05)를 브랜치와 함께 모은다(AC-02). */
export async function collectLanes(root: string): Promise<LaneInfo[]> {
  const base = path.join(root, WORKTREES_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return []; // .awl-worktrees/ 자체가 없으면 레인 없음.
  }
  const branches = await laneBranchMap(root);
  const lanes: LaneInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    const p = path.join(base, e.name);
    lanes.push({ name: e.name, path: p, branch: branchOf(branches, p) ?? '(detached)' });
  }
  lanes.sort((a, b) => a.name.localeCompare(b.name));
  return lanes;
}

/** 레인 목록을 사람이 읽는 카드로 렌더한다(순수, 테스트 가능). */
export function renderLaneList(lanes: LaneInfo[], c: Caps): string {
  const color = makeColors(c.color);
  if (lanes.length === 0) {
    return card(
      '레인',
      [
        `${signal(c, 'info')} 레인이 없습니다.`,
        '',
        color.dim('awl lane new <name> 로 격리 레인을 만드세요.'),
      ],
      c,
    );
  }
  const nameWidth = Math.max(...lanes.map((l) => l.name.length), 4) + 2;
  const out: string[] = [];
  for (const l of lanes) {
    out.push(`${color.bold(l.name.padEnd(nameWidth, ' '))}${color.dim(l.branch)}`);
    out.push(`  ${color.dim(l.path)}`);
  }
  return card('레인', out, c);
}

export async function runLaneList(opts: { json: boolean }): Promise<void> {
  const root = requireRoot();
  const lanes = await collectLanes(root);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(lanes, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderLaneList(lanes, caps())}\n`);
  }
}

/**
 * awl lane rm <name> — 레인의 워크트리를 removeGitWorktree 로 회수하고
 * .awl-worktrees/<name> 을 제거한다(AC-03). tracked 미커밋 변경이 있으면 --force
 * 없이는 거부한다(안전) — 판정 기준은 work done 과 공유(worktreeDirtyTracked).
 */
export async function runLaneRemove(name: string, opts: { force?: boolean } = {}): Promise<void> {
  const root = requireRoot();
  const c = caps();
  const color = makeColors(c.color);
  const laneName = sanitizeForGit(name);
  if (!laneName) {
    process.stderr.write(`\n${feedback(c, 'error', '레인 이름을 입력하세요')}\n`);
    process.exit(1);
  }
  const lanePath = path.join(root, WORKTREES_DIR, laneName);

  if (!fs.existsSync(lanePath)) {
    process.stderr.write(
      `\n${feedback(c, 'error', `레인을 찾을 수 없습니다: ${laneName}`, 'awl lane ls 로 현존 레인을 확인하세요')}\n`,
    );
    process.exit(1);
  }

  // 회수할 브랜치: git worktree list 에서 이 경로의 브랜치를 찾는다(폴백 work/<name>).
  const branches = await laneBranchMap(root);
  const branch = branchOf(branches, lanePath) ?? `work/${laneName}`;

  // 안전(AC-03, AC-05): --force 없이는 잃을 게 있으면 거부한다. 두 가지를 본다 —
  //  (1) tracked 미커밋 변경(uncommitted), (2) 브랜치의 미머지 커밋(committed 이지만
  //  removeGitWorktree 의 branch -D 로 파기될 것). work done 은 브랜치를 보존하지만
  //  lane 은 브랜치까지 회수하므로 이 커밋 손실을 명시적으로 막아야 한다(리뷰 지적).
  if (!opts.force) {
    const d = await worktreeDirtyTracked(root, lanePath);
    if (d.dirty) {
      process.stderr.write(
        `\n${feedback(c, 'error', `레인에 커밋되지 않은 변경 ${d.count}건 (예: ${d.first})`, '--force 로 강제 제거할 수 있습니다')}\n`,
      );
      process.exit(1);
    }
    // untracked 신규 파일(미add WIP)도 파기 대상이라 별도로 본다(F-01) — worktreeDirtyTracked
    // 는 work done 과 공유라 --untracked-files=no 를 유지하고, 여기서만 untracked 를 막는다.
    const u = await worktreeUntracked(root, lanePath);
    if (u.untracked) {
      process.stderr.write(
        `\n${feedback(c, 'error', `레인에 커밋되지 않은 새 파일 ${u.count}건 (예: ${u.first})`, 'git add·커밋하거나 --force 로 강제 제거하세요')}\n`,
      );
      process.exit(1);
    }
    const unmerged = await unmergedCommitCount(root, branch);
    if (unmerged === null) {
      process.stderr.write(
        `\n${feedback(c, 'error', `레인 브랜치 ${branch} 의 미머지 커밋 수를 확인할 수 없습니다 (rm 하면 커밋이 파기될 수 있습니다)`, '먼저 브랜치를 확인하거나 --force 로 강제 제거하세요')}\n`,
      );
      process.exit(1);
    }
    if (unmerged > 0) {
      process.stderr.write(
        `\n${feedback(c, 'error', `레인 브랜치 ${branch} 에 병합되지 않은 커밋 ${unmerged}개 (rm 하면 파기됩니다)`, '먼저 병합·푸시하거나 --force 로 강제 제거하세요')}\n`,
      );
      process.exit(1);
    }
  }

  // 격리(.awl-home) 학습을 전역으로 병합한다 — 워크트리(=.awl-home) 삭제 전에. 안전
  // 검사를 모두 통과해 제거가 확정된 지점이다. gotchas/rules/generations 만 전역으로
  // 이으며 records/state 는 안 건드린다(격리 유지). 없거나 자기 자신이면 no-op.
  const merged = mergeIsolatedHome(path.join(lanePath, '.awl-home'));

  const removed = await removeGitWorktree(root, lanePath, branch);
  if (!removed.ok) {
    process.stderr.write(`\n${feedback(c, 'error', '레인 제거 실패', removed.error ?? '')}\n`);
    process.exit(1);
  }
  // git worktree remove 가 디렉토리를 지우지만, 메타 유실 등으로 잔재가 남으면 정리한다.
  if (fs.existsSync(lanePath)) {
    fs.rmSync(lanePath, { recursive: true, force: true });
  }
  // root state 에 이 레인을 가리키는 유령 workitem 이 있으면 정리한다(F-02). 구버전(또는
  // 비격리 경로)의 lane new 가 root 에 남긴 항목이 삭제된 워크트리를 계속 가리키면 work
  // list/switch 가 없는 디렉토리를 가리키는 유령이 된다. 레인명은 sanitize 전/후가 다를
  // 수 있어 둘 다 후보로 넘긴다.
  const cleaned = removeWorkitemFromState(loadState(root), [name.trim(), laneName]);
  if (cleaned.removed) {
    writeState(root, cleaned.state);
  }
  process.stdout.write(`\n${feedback(c, 'ok', `레인 제거  ${color.bold(laneName)}`, branch)}\n`);
  if (merged && (merged.gotchasAdded > 0 || merged.rulesAdded > 0 || merged.generationsAdded > 0)) {
    process.stdout.write(
      `    ${color.dim(`학습 전역 병합  gotcha ${merged.gotchasAdded} · rule ${merged.rulesAdded} · generation ${merged.generationsAdded}`)}\n`,
    );
  }
}
