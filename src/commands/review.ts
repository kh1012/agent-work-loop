import crypto from 'node:crypto';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { type AwlConfig, requireConfig } from './config.js';
import { filterRules, loadRules } from './rules.js';
import { loadState } from './state.js';
import { type VerifyReport, runVerifyChecks } from './verify.js';

/**
 * awl review — 리뷰어에게 넘길 자료를 조립한다.
 *
 * awl 은 리뷰를 하지 않는다. 판단은 에이전트(서브에이전트)가 한다.
 * provenance 가 핵심이다: 이 diff/검증이 어떤 워크트리·커밋에서 나왔는지 밝혀야
 * 리뷰어가 엉뚱한 곳에서 교차검증하지 않는다.
 * 구현자의 대화 맥락은 포함하지 않는다(신선한 눈으로 봐야 한다).
 */

async function git(args: string[], cwd: string): Promise<string> {
  const r = await run({ cmd: 'git', args, cwd, timeoutMs: 30_000 });
  return r.exitCode === 0 ? r.stdout : '';
}

export interface Provenance {
  branch: string;
  commit: string;
  worktree: string;
  note: string;
}

export interface ReviewBundle {
  reviewId: string;
  criteria: Record<string, unknown>[];
  diff: string;
  verify: VerifyReport;
  provenance: Provenance;
  rules: { id: string; body: string }[];
}

/**
 * 새 리뷰 ID 를 발급한다(WI-S AC-02) — record.ts 의 newRecordId() 와 같은
 * 패턴(접두어+hex). 리뷰 결과를 awl record review 로 남길 때 이 id 를 그대로
 * 써서, 나중에 "이 리뷰 번들이 실제로 기록됐는가"를 사람이 대조할 수 있게 한다.
 * awl 은 그 대조 자체를 강제하지 않는다(판단하지 않는다) — id 를 발급만 한다.
 */
export function newReviewId(): string {
  return `rev_${crypto.randomBytes(9).toString('hex')}`;
}

/** "AC-01..AC-03" 또는 "AC-03" 범위로 완료 조건을 고른다. */
export function selectCriteria(
  state: Record<string, unknown>,
  range: string,
): Record<string, unknown>[] {
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  if (range.includes('..')) {
    const [start, end] = range.split('..');
    return criteria.filter((c) => {
      const id = String(c.id);
      return id >= (start ?? '') && id <= (end ?? '');
    });
  }
  return criteria.filter((c) => c.id === range);
}

export async function assembleReview(
  cwd: string,
  config: AwlConfig,
  state: Record<string, unknown>,
  range: string,
  base: string | undefined,
): Promise<ReviewBundle> {
  const criteria = selectCriteria(state, range);

  // diff 범위: 지정 base 우선, 없으면 범위 첫 완료 조건의 firstBaseline..HEAD.
  // firstBaseline 이 없는(마이그레이션 전) 완료조건은 baseline 으로 폴백한다 —
  // baseline 은 격리 커밋이 닫힐 때마다 그 AC 자신의 최종 커밋으로 덮어써지므로,
  // 이미 닫힌 AC 가 범위 첫 항목이면 그 AC 자신의 diff 가 빠지는 버그가 있었다
  // (WI-H AC-01, D-26/D-28). firstBaseline 은 AC 가 처음 시작될 때만 고정된다.
  const firstBaseline = criteria
    .map((c) =>
      typeof c.firstBaseline === 'string'
        ? c.firstBaseline
        : typeof c.baseline === 'string'
          ? c.baseline
          : undefined,
    )
    .find(Boolean);
  const diffArgs = base
    ? ['diff', `${base}..HEAD`]
    : firstBaseline
      ? ['diff', `${firstBaseline}..HEAD`]
      : ['diff', 'HEAD'];
  const diff = await git(diffArgs, cwd);

  const verify = await runVerifyChecks(config.verify, cwd, { bail: false });

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
  const worktree = (await git(['rev-parse', '--show-toplevel'], cwd)).trim() || cwd;

  const { rules } = loadRules();
  const reviewRules = filterRules(rules, { scope: 'review' }).map((r) => ({
    id: r.id,
    body: r.body,
  }));

  return {
    reviewId: newReviewId(),
    criteria,
    diff,
    verify,
    provenance: {
      branch,
      commit,
      worktree,
      note: '이 diff와 검증 결과는 위 워크트리/커밋에서 나왔습니다',
    },
    rules: reviewRules,
  };
}

function renderReview(bundle: ReviewBundle, range: string, c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = ['', `  리뷰 자료  ${range}`, ''];
  out.push(`    reviewId     ${bundle.reviewId}`);
  out.push(`    완료 조건    ${bundle.criteria.length}개`);
  out.push(`    diff         ${bundle.diff.split('\n').length}줄`);
  out.push(`    검증         ${bundle.verify.passed ? color.green('통과') : color.red('실패')}`);
  out.push(`    규칙(review) ${bundle.rules.length}개`);
  out.push('');
  out.push('  provenance (리뷰어가 교차검증할 위치)');
  out.push(`    브랜치       ${bundle.provenance.branch}`);
  out.push(`    커밋         ${bundle.provenance.commit.slice(0, 10)}`);
  out.push(`    워크트리     ${bundle.provenance.worktree}`);
  out.push('');
  out.push(`  ${color.dim(`리뷰어(서브에이전트)에게는 awl review ${range} --json 을 넘기세요.`)}`);
  out.push(
    `  ${color.dim(`판정을 받으면 awl record review --json '{"reviewId":"${bundle.reviewId}",...}' 로 기록하세요.`)}`,
  );
  return out.join('\n');
}

export async function runReview(
  range: string,
  opts: { json: boolean; base?: string },
): Promise<void> {
  const { projectRoot, config } = requireConfig();
  const state = loadState(projectRoot);
  const bundle = await assembleReview(projectRoot, config, state, range, opts.base);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(bundle, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReview(bundle, range, caps())}\n`);
  }
}
