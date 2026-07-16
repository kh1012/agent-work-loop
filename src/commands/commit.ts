import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { gate1BlockReason, getCriterion, loadState, setCriterion, writeState } from './state.js';
import { protectedFilesMessage } from '../core/protected-files.js';
import { loadConfig } from './config.js';

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
 * 설계 근거는 docs/decisions.md D-17. HEAD 드리프트 감지는 D-36.
 */

/**
 * 이보다 많은 파일이 한 격리 커밋에 담기면 눈에 띄게 알린다(경고만, 차단 아님).
 * awl 은 완료조건의 의도된 범위를 모르니 "맞다"고 판단하지 않는다 — 그저
 * 스스로 대조하도록 개수를 계산해 보여준다. 대부분의 완료조건이 소수 파일만
 * 건드리는 이 저장소의 실제 관행에서 고른 값이다.
 */
const STAGED_FILES_NOTICE_THRESHOLD = 5;

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

/**
 * git ref 이름에 안전한 문자만 남긴다. 금지 문자(공백 등)는 `_` 로 치환하고,
 * 연속된 마침표(`..`, git 의 상위 경로 표기와 충돌해 ref 이름으로 거부됨)도
 * `_` 로 뭉갠다(리뷰 지적 AC-12 — 원래는 공백류만 막고 `..` 는 안 막았다).
 * 이것으로 모든 git ref 규칙을 다 막는다고 보장하지는 않는다 — 그래서
 * update-ref 호출부는 별도로 실패를 감지해 경고한다(아래).
 */
function sanitizeRefComponent(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
}

/**
 * baseline 스냅샷을 고정하는 git ref 경로. 현재 워크아이템으로 네임스페이스한다
 * (WI-D AC-06) — 서로 다른 워크아이템이 같은 AC-ID 를 재사용해도(관행상 흔하다)
 * 이 ref 가 서로 덮어쓰지 않는다. 그래야 보관(archive)된 워크아이템의 dangling
 * 커밋(git stash create 산물)이 참조를 잃어 git gc 대상이 되는 걸 막는다.
 * 현재 워크아이템이 없으면(레거시 state 등) 예전처럼 AC-ID 만 쓴다.
 * startBaseline/isolatedCommit 의 공개 시그니처는 바꾸지 않는다 — 여기서
 * loadState 로 직접 판단한다.
 * ac 도 sanitize 한다(리뷰 지적 AC-12 — workitem 만 걸러서 절반만 안전했다.
 * `awl commit <criterion>` 의 criterion 은 완전 자유 텍스트 CLI 인자다).
 */
function baselineRefPath(cwd: string, ac: string): string {
  const state = loadState(cwd);
  const workitem = typeof state.workitem === 'string' ? state.workitem : null;
  const safeAc = sanitizeRefComponent(ac);
  return workitem
    ? `refs/awl/baseline/${sanitizeRefComponent(workitem)}/${safeAc}`
    : `refs/awl/baseline/${safeAc}`;
}

/**
 * baseline ref 를 고정한다. 이 ref 는 어디서도 다시 읽지 않는다(dangling 커밋을
 * git gc 로부터 보호하는 용도일 뿐 — 진짜 baseline 출처는 state.json 의
 * criteria[].snapshot 이다) — 그래서 실패해도 격리 커밋 자체를 막지 않는다.
 * 다만 조용히 삼키면 보호가 무음으로 무력화되므로(리뷰 지적 AC-12 — 예:
 * sanitize 로 못 거른 ref 이름 충돌) 실패 시 경고만 남긴다.
 */
async function pinBaselineRef(cwd: string, ac: string, sha: string): Promise<void> {
  const refPath = baselineRefPath(cwd, ac);
  const result = await git(['update-ref', refPath, sha], cwd);
  if (result.exitCode !== 0) {
    process.stderr.write(
      `  경고: baseline 보호용 git ref(${refPath})를 못 만들었습니다(기능엔 영향 없음): ${result.stderr.trim()}\n`,
    );
  }
}

/** 완료 조건 작업의 베이스라인을 잡는다. 시작 시점 스냅샷을 refs/awl 로 고정한다. */
export async function startBaseline(cwd: string, ac: string): Promise<Baseline> {
  const head = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
  const snapshot = await captureSnapshot(cwd);
  const untracked = await listUntracked(cwd);
  await pinBaselineRef(cwd, ac, snapshot);
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
  expectedHead?: string,
): Promise<CommitOutcome> {
  const empty = { stagedFiles: [], excludedFiles: [], extraFiles: [] };

  // HEAD 드리프트 확인 — diff/apply 를 시도하기 전에 먼저 본다 (D-36).
  // "자체 검증 통과"(아래 selfCheckOk)는 committedFiles == stagedFiles 를 보는
  // 내부 일관성 검사일 뿐이다 — 커밋은 스테이징한 내용 그대로 만들어지므로 이
  // 비교는 항상 동어반복적으로 통과한다(순환 참조). 실제 위험 신호는 따로 있다:
  // 이 완료조건을 시작한 뒤 다른 커밋이 이 브랜치 HEAD 에 얹혔다면(다른 완료조건을
  // 실수로 여기서 커밋했거나, 동시 진행 중인 다른 세션/에이전트의 작업), 그
  // 커밋이 건드린 파일은 snapshot 시점과 달라져 있어 diff/apply 단계에서 결국
  // hunk 충돌로 걸리긴 하지만(작업 자체는 안전) "hunk 충돌"이라는 일반 메시지만
  // 뜨고 진짜 원인(HEAD 이동)은 안 보인다. 여기서 먼저 확인해 명확한 이유를 준다.
  if (expectedHead !== undefined) {
    const currentHead = (await git(['rev-parse', 'HEAD'], cwd)).stdout.trim();
    if (currentHead !== expectedHead) {
      const log = (
        await git(['log', '--oneline', `${expectedHead}..${currentHead}`], cwd)
      ).stdout.trim();
      const commits = lines(log);
      return {
        committed: false,
        reason: [
          `HEAD 가 이 완료조건의 베이스라인을 잡은 뒤 다른 커밋 ${commits.length}개로 이동했습니다:`,
          ...commits.map((c) => `  ${c}`),
          '다른 완료조건을 실수로 여기서 커밋했다면 그쪽을 마저 정리하세요.',
          '의도한 것이면(동시 작업 등) 지금 이 워킹트리의 변경을 먼저 확인한 뒤',
          `awl commit ${ac} --start 로 베이스라인을 새로 잡고 다시 시도하세요.`,
        ].join('\n'),
        selfCheckOk: false,
        ...empty,
      };
    }
  }

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

/**
 * awl commit 이 거부됐을 때, hunk 충돌 사유일 때만 격리 워크트리로 옮기는
 * 구체적 안내를 만든다(WI-F AC-04). 실사고: "사람이 확인하세요"로 끝나고
 * 대안이 "커밋 없이 계속 진행"뿐이었더니, 결국 내 변경이 나중에 남의 커밋에
 * 섞여 들어갔다 — awl commit 이 막으려던 사고가 다른 경로로 재현됐다.
 * 다른 거부 사유("커밋할 변경 없음" 등)에는 관련 없는 안내를 안 붙인다.
 */
export function buildRescueGuidance(reason: string | undefined): string | null {
  if (!reason || !reason.includes('hunk')) {
    return null;
  }
  return [
    '',
    '  격리된 워크트리로 옮기는 방법(내 변경을 그대로 다른 곳으로 이동):',
    '    git stash push -u -m "rescue"          # 내 변경(추적+미추적 전부)을 스택에 담는다',
    '    git worktree add ../<새-디렉토리> -b <새-브랜치>',
    '    cd ../<새-디렉토리> && git stash pop    # 옮긴 워크트리에서 변경을 복원',
    '  (또는 awl work new <ID> --worktree 로 새 워크아이템 + 격리 워크트리를 한 번에 만들고 위 순서로 옮기세요.)',
  ].join('\n');
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
  opts: { start?: boolean; message?: string; base?: string; force?: boolean },
): Promise<void> {
  const root = requireRoot();
  const gateBlock = gate1BlockReason(loadState(root), 'commit');
  if (gateBlock) { process.stderr.write(`\n  ${gateBlock}\n`); process.exit(1); }
  if (!opts.force) {
    const protection = await protectedFilesMessage(root, loadConfig(root).config?.protectedFiles);
    if (protection) { process.stderr.write(`\n  ${protection}\n`); process.exit(1); }
  }
  const c = caps();
  const color = makeColors(c.color);
  const now = new Date().toISOString();

  if (opts.start) {
    const { snapshot, head, untracked } = await startBaseline(root, ac);
    // firstBaseline 은 이 AC 가 "처음" --start 될 때만 기록하고 이후 절대 안 덮어쓴다
    // (WI-H AC-01, D-26/D-28). baseline/snapshot 은 격리 커밋마다(닫힐 때) 다음
    // diff 기준점으로 갱신되지만, review 의 범위 시작점은 AC 가 처음 시작된 시점
    //그대로 고정돼야 한다 — 하나의 필드(baseline)로 두 목적을 겸용한 게 버그의
    // 근본 원인이었다. setCriterion 은 얕은 병합이라 여기서 안 건드리면(닫는 경로도
    // 마찬가지) 기존 값이 그대로 보존된다.
    const existing = getCriterion(loadState(root), ac);
    const firstBaseline =
      typeof existing?.firstBaseline === 'string' ? existing.firstBaseline : head;
    const state = setCriterion(loadState(root), ac, {
      status: 'in_progress',
      baseline: head,
      snapshot,
      untrackedAtStart: untracked,
      startedAt: now,
      firstBaseline,
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
  const expectedHead = typeof crit?.baseline === 'string' ? crit.baseline : undefined;
  const outcome = await isolatedCommit(
    root,
    ac,
    opts.message,
    snapshot,
    untrackedAtStart,
    expectedHead,
  );

  // 무엇이 커밋될지/제외됐는지 보여준다.
  process.stdout.write('\n');
  if (outcome.stagedFiles.length > 0) {
    process.stdout.write('  커밋할 내 변경:\n');
    for (const f of outcome.stagedFiles) {
      process.stdout.write(`    ${color.green('+')} ${f}\n`);
    }
    // 파일 개수가 많으면 눈에 띄게 알린다 — "맞다/틀리다"는 판단하지 않는다
    // (awl 은 이 완료조건의 의도된 범위를 모른다), 개수만 센다. 사람/에이전트가
    // 스스로 범위와 대조하도록 만드는 게 목적이다(D-36 — 자체검증 통과 메시지를
    // 과신해 실제로는 무관한 파일이 섞인 커밋을 그대로 넘긴 실사고 재발 방지).
    if (outcome.stagedFiles.length > STAGED_FILES_NOTICE_THRESHOLD) {
      process.stdout.write(
        `  ${color.yellow(`파일 ${outcome.stagedFiles.length}개`)} — 이 완료조건의 범위와 일치하는지 위 목록을 직접 확인하세요.\n`,
      );
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
    const guidance = buildRescueGuidance(outcome.reason);
    if (guidance) {
      process.stderr.write(`${guidance}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`\n  커밋됨: ${outcome.commit?.slice(0, 10)}  ${opts.message}\n`);
  if (!outcome.selfCheckOk) {
    process.stderr.write(
      `  ${color.red('내부 검증 경고')}: 스테이징한 파일과 실제 커밋 내용이 다릅니다: ${outcome.extraFiles.join(', ')}\n`,
    );
  } else {
    // D-36: 이건 "커밋 = 스테이징 내용"이라는 내부 일관성만 확인한다(항상 참인
    // 동어반복에 가깝다) — "이 커밋이 이 완료조건에만 맞다"는 보장이 아니다.
    // 그 판단은 위 파일 목록을 직접 보고 하는 몫이다. 예전 문구("내가 쓴 파일만
    // 커밋됨")는 이 구분 없이 안심을 줘서 실제로 무관한 파일이 섞인 커밋을
    // 그대로 넘긴 사고가 있었다(실사용 재현).
    process.stdout.write(`  ${color.dim('내부 검증: 스테이징한 내용 그대로 커밋됨.')}\n`);
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
  await pinBaselineRef(root, ac, newSnap);
  writeState(
    root,
    setCriterion(loadState(root), ac, {
      snapshot: newSnap,
      baseline: outcome.commit,
      untrackedAtStart: newUntracked,
    }),
  );
}
