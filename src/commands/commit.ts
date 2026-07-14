import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { getCriterion, loadState, setCriterion, writeState } from './state.js';

/**
 * awl commit — 격리 커밋.
 *
 * 드라이런에서 실증된 사고를 막는다: 같은 파일에 남의 미커밋 변경이 섞여 있을 때
 * `git add <파일>` 은 남의 변경까지 커밋한다. awl commit 은 내 변경 hunk 만
 * 스테이징한다.
 *
 * 안전 원칙:
 * - 남의 미커밋 변경을 절대 잃지 않는다. `git apply --cached` 는 인덱스에만 적용하고
 *   워킹트리를 건드리지 않으므로 어떤 경우에도 남의 작업이 날아가지 않는다.
 * - 확신할 수 없으면(hunk 겹쳐 apply 실패) 커밋하지 않고 사람에게 알린다.
 * - git add -A / commit -a 를 쓰지 않는다. push 하지 않는다.
 * 설계 근거는 docs/decisions.md D-17.
 */

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function git(args: string[], cwd: string): Promise<GitResult> {
  const r = await run({ cmd: 'git', args, cwd, timeoutMs: 30_000 });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode };
}

function lines(s: string): string[] {
  return s
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * 파일명을 내는 git 명령을 -z(NUL 구분)로 실행해 원본 파일명 목록을 얻는다.
 * core.quotePath 설정과 무관하게 한글 등 비ASCII 경로가 그대로 나온다.
 */
async function namesZ(args: string[], cwd: string): Promise<string[]> {
  const out = (await git([...args, '-z'], cwd)).stdout;
  return out.split('\0').filter((f) => f !== '');
}

/** 현재 워킹트리 상태를 스냅샷 커밋으로 만든다(워킹트리는 건드리지 않는다). */
export async function captureSnapshot(cwd: string): Promise<string> {
  const created = await git(['stash', 'create'], cwd);
  const sha = created.stdout.trim();
  if (sha) {
    return sha;
  }
  // 워킹트리가 깨끗하면 stash create 는 빈 출력을 준다. 그때는 HEAD.
  return (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
}

export interface Baseline {
  snapshot: string;
  head: string;
  /** 시작 시점에 이미 있던 untracked 파일들(남의 것으로 취급, 커밋에서 제외한다). */
  untracked: string[];
}

/**
 * untracked 파일 목록(gitignore 제외). -z(NUL 구분)로 읽어 core.quotePath 설정과
 * 무관하게 원본 파일명을 얻는다. 그렇지 않으면 한글 등 비ASCII 경로가 인용-인코딩되어
 * 이후 git add 에 리터럴 pathspec 으로 넘어가 매칭되지 않는다(리뷰어 지적 AC-05).
 */
async function listUntracked(cwd: string): Promise<string[]> {
  return namesZ(['ls-files', '--others', '--exclude-standard'], cwd);
}

/** git ref 이름에 안전한 문자만 남긴다(공백 등 잘못된 문자는 _ 로 치환). */
function sanitizeRefComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * baseline 스냅샷을 고정하는 git ref 경로. 현재 워크아이템으로 네임스페이스한다
 * (WI-D AC-06) — 서로 다른 워크아이템이 같은 AC-ID 를 재사용해도(관행상 흔하다)
 * 이 ref 가 서로 덮어쓰지 않는다. 그래야 보관(archive)된 워크아이템의 dangling
 * 커밋(git stash create 산물)이 참조를 잃어 git gc 대상이 되는 걸 막는다.
 * 현재 워크아이템이 없으면(레거시 state 등) 예전처럼 AC-ID 만 쓴다.
 * startBaseline/isolatedCommit 의 공개 시그니처는 바꾸지 않는다 — 여기서
 * loadState 로 직접 판단한다.
 */
function baselineRefPath(cwd: string, ac: string): string {
  const state = loadState(cwd);
  const workitem = typeof state.workitem === 'string' ? state.workitem : null;
  return workitem
    ? `refs/awl/baseline/${sanitizeRefComponent(workitem)}/${ac}`
    : `refs/awl/baseline/${ac}`;
}

/** 완료 조건 작업의 베이스라인을 잡는다. 시작 시점 스냅샷을 refs/awl 로 고정한다. */
export async function startBaseline(cwd: string, ac: string): Promise<Baseline> {
  const head = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  const snapshot = await captureSnapshot(cwd);
  const untracked = await listUntracked(cwd);
  await git(['update-ref', baselineRefPath(cwd, ac), snapshot], cwd);
  return { snapshot, head, untracked };
}

export interface CommitOutcome {
  committed: boolean;
  reason?: string;
  commit?: string;
  stagedFiles: string[];
  excludedFiles: string[];
  selfCheckOk: boolean;
  extraFiles: string[];
}

/**
 * baseline 스냅샷 이후 "내 변경"만 인덱스에 적용해 커밋한다.
 * apply 가 실패하면(hunk 겹침) 커밋하지 않고 이유를 돌려준다.
 */
export async function isolatedCommit(
  cwd: string,
  ac: string,
  message: string,
  snapshot: string,
  untrackedAtStart: string[] = [],
): Promise<CommitOutcome> {
  const empty = { stagedFiles: [], excludedFiles: [], extraFiles: [] };

  // 인덱스를 HEAD 로 되돌린다(남의 스테이징을 언스테이징; 워킹트리는 건드리지 않음).
  await git(['reset', '-q'], cwd);

  // 내 변경 = (스냅샷 이후 tracked 변경) + (시작 이후 새로 생긴 untracked 파일).
  // git diff 는 untracked 를 보지 않으므로 새 파일은 따로 식별한다.
  const diff = (await git(['diff', snapshot], cwd)).stdout;
  const nowUntracked = await listUntracked(cwd);
  const newUntracked = nowUntracked.filter((f) => !untrackedAtStart.includes(f));

  if (diff.trim() === '' && newUntracked.length === 0) {
    return { committed: false, reason: '커밋할 내 변경이 없습니다.', selfCheckOk: true, ...empty };
  }

  // tracked 변경은 patch 로 인덱스에만 적용한다(워킹트리 안 건드림).
  if (diff.trim() !== '') {
    const patchFile = path.join(os.tmpdir(), `awl-commit-${ac}-${process.pid}.patch`);
    fs.writeFileSync(patchFile, diff);
    const applied = await git(['apply', '--cached', '--whitespace=nowarn', patchFile], cwd);
    fs.rmSync(patchFile, { force: true });

    if (applied.exitCode !== 0) {
      await git(['reset', '-q'], cwd);
      return {
        committed: false,
        reason: `내 변경을 안전하게 분리할 수 없습니다(hunk 가 남의 변경과 겹칠 수 있습니다). 커밋하지 않았습니다. 사람이 확인하세요.\n${applied.stderr.trim()}`,
        selfCheckOk: false,
        ...empty,
      };
    }
  }

  // 내가 새로 만든 파일만 스테이징한다(새 파일이라 통째로 내 것; 남의 새 파일은 제외).
  // git add 실패를 삼키지 않는다. 자체 검증은 "빠진 파일"을 못 잡으므로 여기서 막는다.
  for (const f of newUntracked) {
    const added = await git(['add', '--', f], cwd);
    if (added.exitCode !== 0) {
      await git(['reset', '-q'], cwd);
      return {
        committed: false,
        reason: `새 파일을 스테이징하지 못했습니다: ${f}\n${added.stderr.trim()}`,
        selfCheckOk: false,
        ...empty,
      };
    }
  }

  const stagedFiles = await namesZ(['diff', '--cached', '--name-only'], cwd);
  // 제외: tracked 남의 변경(unstaged) + 시작 시점부터 있던 남의 untracked.
  const excludedFiles = [
    ...(await namesZ(['diff', '--name-only'], cwd)),
    ...nowUntracked.filter((f) => untrackedAtStart.includes(f)),
  ];

  const msg = message.includes(ac) ? message : `${message} [${ac}]`;
  const committed = await git(['commit', '-q', '-m', msg], cwd);
  if (committed.exitCode !== 0) {
    await git(['reset', '-q'], cwd);
    return {
      committed: false,
      reason: `커밋 실패: ${committed.stderr.trim()}`,
      selfCheckOk: false,
      stagedFiles,
      excludedFiles,
      extraFiles: [],
    };
  }

  const commit = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  // 자체 검증: 커밋된 파일이 내가 스테이징한 집합과 같은지(내가 안 쓴 파일이 없는지).
  const committedFiles = await namesZ(['show', '--name-only', '--format=', commit], cwd);
  const extraFiles = committedFiles.filter((f) => !stagedFiles.includes(f));

  return {
    committed: true,
    commit,
    stagedFiles,
    excludedFiles,
    selfCheckOk: extraFiles.length === 0,
    extraFiles,
  };
}

export interface DriftInfo {
  ahead: number;
  overlap: string[];
  base: string;
}

/** 원본 브랜치가 갈라진 뒤 얼마나 전진했고, 내 파일과 겹치는지 확인한다. */
export async function checkBaseDrift(
  cwd: string,
  base: string | undefined,
  myFiles: string[],
): Promise<DriftInfo | null> {
  let baseRef = base;
  if (!baseRef) {
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], cwd);
    if (up.exitCode !== 0 || up.stdout.trim() === '') {
      return null; // 기준 브랜치를 알 수 없으면 드리프트 확인을 건너뛴다.
    }
    baseRef = up.stdout.trim();
  }
  const mb = await git(['merge-base', 'HEAD', baseRef], cwd);
  if (mb.exitCode !== 0) {
    return null;
  }
  const mergeBase = mb.stdout.trim();
  const ahead = Number(
    (await git(['rev-list', '--count', `${mergeBase}..${baseRef}`], cwd)).stdout.trim() || '0',
  );
  if (ahead === 0) {
    return { ahead: 0, overlap: [], base: baseRef };
  }
  const changed = lines((await git(['diff', '--name-only', mergeBase, baseRef], cwd)).stdout);
  const overlap = changed.filter((f) => myFiles.includes(f));
  return { ahead, overlap, base: baseRef };
}

// ---------------------------------------------------------------------------
// 명령 진입점
// ---------------------------------------------------------------------------

function requireRoot(): string {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  return root;
}

export async function runCommit(
  ac: string,
  opts: { start?: boolean; message?: string; base?: string },
): Promise<void> {
  const root = requireRoot();
  const c = caps();
  const color = makeColors(c.color);
  const now = new Date().toISOString();

  if (opts.start) {
    const { snapshot, head, untracked } = await startBaseline(root, ac);
    const state = setCriterion(loadState(root), ac, {
      status: 'in_progress',
      baseline: head,
      snapshot,
      untrackedAtStart: untracked,
      startedAt: now,
    });
    writeState(root, state);
    process.stdout.write(`\n  ${ac} 베이스라인을 잡았습니다: ${head.slice(0, 10)}\n`);
    process.stdout.write(
      `  ${color.dim(`이제 작업한 뒤 awl commit ${ac} -m "..." 로 격리 커밋하세요.`)}\n`,
    );
    return;
  }

  if (!opts.message) {
    process.stderr.write(`\n  커밋 메시지가 필요합니다: awl commit ${ac} -m "..."\n`);
    process.exit(1);
  }

  const state = loadState(root);
  const crit = getCriterion(state, ac);
  const snapshot = crit && typeof crit.snapshot === 'string' ? crit.snapshot : undefined;
  if (!snapshot) {
    process.stderr.write(
      `\n  ${ac} 의 베이스라인이 없습니다. 내 변경을 남의 변경과 구분할 수 없습니다.\n  먼저 실행하세요: awl commit ${ac} --start\n`,
    );
    process.exit(1);
  }

  const untrackedAtStart = Array.isArray(crit?.untrackedAtStart)
    ? (crit.untrackedAtStart as string[])
    : [];
  const outcome = await isolatedCommit(root, ac, opts.message, snapshot, untrackedAtStart);

  // 무엇이 커밋될지/제외됐는지 보여준다.
  process.stdout.write('\n');
  if (outcome.stagedFiles.length > 0) {
    process.stdout.write('  커밋할 내 변경:\n');
    for (const f of outcome.stagedFiles) {
      process.stdout.write(`    ${color.green('+')} ${f}\n`);
    }
  }
  if (outcome.excludedFiles.length > 0) {
    process.stdout.write(
      `  ${color.yellow('제외')}(남의 미커밋 변경, 워킹트리에 그대로 둡니다):\n`,
    );
    for (const f of outcome.excludedFiles) {
      process.stdout.write(`    ${color.dim('-')} ${f}\n`);
    }
  }

  if (!outcome.committed) {
    process.stderr.write(`\n  ${color.red('커밋하지 않았습니다.')} ${outcome.reason}\n`);
    process.exit(1);
  }

  process.stdout.write(`\n  커밋됨: ${outcome.commit?.slice(0, 10)}  ${opts.message}\n`);
  if (!outcome.selfCheckOk) {
    process.stderr.write(
      `  ${color.red('자체 검증 경고')}: 내가 스테이징하지 않은 파일이 커밋에 있습니다: ${outcome.extraFiles.join(', ')}\n`,
    );
  } else {
    process.stdout.write(`  ${color.dim('자체 검증: 내가 쓴 파일만 커밋됨.')}\n`);
  }

  // 베이스 드리프트 경고.
  const drift = await checkBaseDrift(root, opts.base, outcome.stagedFiles);
  if (drift && drift.ahead > 0) {
    process.stdout.write(
      `\n  ${color.yellow('경고')}: 이 브랜치가 갈라진 뒤 ${drift.base} 에 ${drift.ahead}개 커밋이 쌓였습니다.\n`,
    );
    if (drift.overlap.length > 0) {
      process.stdout.write(`        겹치는 파일: ${drift.overlap.join(', ')}\n`);
      process.stdout.write('        병합 전에 확인하세요.\n');
    }
  }

  // 다음 격리 커밋을 위해 베이스라인을 이번 커밋 시점으로 갱신한다.
  const newSnap = await captureSnapshot(root);
  const newUntracked = await listUntracked(root);
  await git(['update-ref', baselineRefPath(root, ac), newSnap], root);
  writeState(
    root,
    setCriterion(loadState(root), ac, {
      snapshot: newSnap,
      baseline: outcome.commit,
      untrackedAtStart: newUntracked,
    }),
  );
}
