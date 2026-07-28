import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseFrontmatter } from '../core/doc-frontmatter.js';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors, sectionBox, signal } from '../core/tty.js';
import { findTicketPath, loadTicketRuntime, writeTicketRuntime } from './commit.js';
import { type AwlConfig, requireConfig } from './config.js';
import { extractConditionBlocks, listDocFiles } from './doc.js';
import { type SkillSlot, loadProfile } from './profile.js';
import { readRecords } from './record.js';
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
  /** hits 내림차순 상위 MAX_SHOWN_RULES 개까지만 본문 포함(WI-I2). */
  rules: { id: string; body: string }[];
  /** rules 에서 잘려나간(본문 대신 id만 남은) 규칙 id들. 빈 배열이면 안 잘림(WI-I2). */
  additionalRuleIds: string[];
  /** profile.local.json 이 바꾼 스킬 슬롯 이름들(ADK stage 4) — 정보 표시, 경고 아니다
   * (prototype.md:519-524 "스킬을 바꾸는 건 정보다"). 없으면 빈 배열. */
  localSkills: string[];
  /** 이 티켓에 대해 findings 가 비어있지 않았던 review 기록 수(WI-G24, "왕복"). ticket
   * 경로(assembleReviewForTicket)에서만 채운다 — AC-range 경로(assembleReview)는 없음. */
  roundTrips?: number;
}

/**
 * review pack 에 본문을 싣는 프로젝트 규칙 개수 상한(WI-I2, 토큰 스트레스 테스트로
 * 확정). scope:review 로 승격된 규칙은 diff 와의 관련성과 무관하게 전부 실렸었다
 * — 성숙한 프로젝트일수록(gotcha 가 계속 승격될수록) 이 목록이 무한정 커진다.
 * hits(실제로 몇 번 걸렸나)가 관련성의 유일한 신호라 그 기준 내림차순으로 자른다
 * — 파일 경로 매칭은 규칙에 구조화된 path 필드가 없어 못 한다(rules.ts:16-27).
 */
export const MAX_SHOWN_RULES = 25;

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

/**
 * 검증·provenance·규칙·로컬스킬 — range 기반이든 ticket 기반이든 리뷰 번들에 똑같이
 * 필요한 부분(WI-G23, 중복 제거). diff/criteria/reviewId 만 호출부마다 다르다.
 */
async function gatherReviewContext(
  cwd: string,
  config: AwlConfig,
): Promise<Pick<ReviewBundle, 'verify' | 'provenance' | 'rules' | 'additionalRuleIds' | 'localSkills'>> {
  const verify = await runVerifyChecks(config.verifications, cwd, { bail: false });

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim();
  const commit = (await git(['rev-parse', 'HEAD'], cwd)).trim();
  const worktree = (await git(['rev-parse', '--show-toplevel'], cwd)).trim() || cwd;

  // hits 내림차순 상위 MAX_SHOWN_RULES 개만 본문을 싣는다(WI-I2) — 실제로 몇 번
  // 걸렸는지가 관련성의 유일한 신호다. 나머지는 id만 additionalRuleIds 로 남겨
  // 조용히 숨기지 않는다.
  const { rules } = loadRules();
  const sortedRules = filterRules(rules, { scope: 'review' }).sort((a, b) => b.hits - a.hits);
  const reviewRules = sortedRules.slice(0, MAX_SHOWN_RULES).map((r) => ({ id: r.id, body: r.body }));
  const additionalRuleIds = sortedRules.slice(MAX_SHOWN_RULES).map((r) => r.id);

  const loadedProfile = loadProfile(cwd);
  const localSkills = loadedProfile.profile
    ? (Object.keys(loadedProfile.sources) as SkillSlot[]).filter(
        (slot) => loadedProfile.sources[slot] === 'local',
      )
    : [];

  return {
    verify,
    provenance: {
      branch,
      commit,
      worktree,
      note: '이 diff와 검증 결과는 위 워크트리/커밋에서 나왔습니다',
    },
    rules: reviewRules,
    additionalRuleIds,
    localSkills,
  };
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

  const context = await gatherReviewContext(cwd, config);

  return {
    reviewId: newReviewId(),
    criteria,
    diff,
    ...context,
  };
}

export type ReviewPackResult = { bundle: ReviewBundle } | { missing: string };

/**
 * 이 티켓을 지목한 review 기록 중 findings 가 비어있지 않은 것의 수(WI-G24, "왕복").
 * 지적이 있어야 "다시 고치고 다시 봤다"는 왕복이 성립한다 — 지적 없이 끝난 리뷰는
 * 왕복이 아니다. 저장하지 않고 매번 readRecords 에서 계산한다(D-15, 파생 가능한
 * 값을 별도로 안 쓴다 — countMissing 류와 같은 원칙).
 *
 * matchIds 는 조건 id 들 + 티켓 자신의 id 를 합친 목록이다(시뮬레이션 발견,
 * adk-simulation.md 시나리오A) — 기반 티켓(conditions:[])은 지목할 조건 id 가
 * 원래 없어 조건 id만으로 매칭하면 영원히 0으로 고정돼 "왕복 2회 초과 시 사람
 * 호출" 안전장치가 기반 티켓에서는 절대 안 켜진다. `review.criteria`(비어있지
 * 않은 배열이 필수)에 조건 id 가 없는 기반 티켓 리뷰는 티켓 id 자신을 담아
 * 남기는 관례로 구멍을 막는다.
 */
export function countReviewRoundTrips(
  reviewRecords: Record<string, unknown>[],
  matchIds: string[],
): number {
  return reviewRecords.filter(
    (r) =>
      Array.isArray(r.criteria) &&
      (r.criteria as unknown[]).some((id) => matchIds.includes(String(id))) &&
      Array.isArray(r.findings) &&
      r.findings.length > 0,
  ).length;
}

/**
 * `awl review pack <ticket-id>` — 4게이트 티켓 모델용 리뷰 자료 조립(WI-G23/G24).
 * assembleReview(AC-range 키)와 같은 ReviewBundle 을 만들되, 조건을
 * docs/tickets/*.md → spec 조건 원문에서 가져오고 diff 기준점은
 * .awl/tickets/<id>.json 런타임에서 읽는다 — lastReviewedCommit 이 있으면
 * (재리뷰, runReviewPack 이 이전 호출 성공 시 남겨둔다) 그 지점부터, 없으면
 * firstBaseline/baseline(첫 리뷰, 티켓 전체) 부터.
 *
 * 리뷰어가 재료로 판단할 수 없으면(설계: "재료 부족: <무엇>") bundle 대신
 * missing 을 돌려준다 — 티켓을 못 찾거나, 스펙에서 조건 원문을 못 찾거나,
 * 베이스라인 이후 diff 가 비어 있으면(가장 흔한 원인: `awl commit --start`
 * 를 안 함) 여기 걸린다.
 */
export async function assembleReviewForTicket(
  cwd: string,
  config: AwlConfig,
  ticketId: string,
  base: string | undefined,
): Promise<ReviewPackResult> {
  const ticketPath = findTicketPath(cwd, ticketId);
  if (!ticketPath) {
    return { missing: `티켓을 찾을 수 없습니다: ${ticketId}` };
  }
  const parsedTicket = parseFrontmatter(fs.readFileSync(ticketPath, 'utf8'));
  if (!parsedTicket) {
    return { missing: `티켓 프론트매터를 읽을 수 없습니다: ${ticketId}` };
  }

  const specId = typeof parsedTicket.data.spec === 'string' ? parsedTicket.data.spec : '';
  const conditionIds = Array.isArray(parsedTicket.data.conditions)
    ? (parsedTicket.data.conditions as unknown[]).map(String)
    : [];

  let specBody: string | null = null;
  if (specId) {
    for (const file of listDocFiles(cwd)) {
      if (file.type !== 'spec') {
        continue;
      }
      try {
        const parsed = parseFrontmatter(fs.readFileSync(file.path, 'utf8'));
        if (parsed?.data.id === specId) {
          specBody = parsed.body;
          break;
        }
      } catch {
        // 손상된 파일 하나가 조회를 막지 않는다.
      }
    }
  }

  const blocks = specBody ? extractConditionBlocks(specBody) : [];
  const criteria = conditionIds.map((id) => ({
    id,
    text: blocks.find((b) => b.heading === id)?.text ?? null,
  }));
  // 기반 티켓(conditions:[])은 조건이 원래 없다 — 그건 재료 부족이 아니라 정상
  // 상태다(adk-simulation.md 시나리오 A, "재료 조건 없음"도 유효한 리뷰 재료).
  // "재료 부족"은 conditionIds 가 있는데 스펙에서 그 id 를 못 찾았을 때만 해당한다.
  const unresolvedIds = criteria.filter((c) => c.text === null).map((c) => c.id);
  if (unresolvedIds.length > 0) {
    return { missing: `완료 조건 원문(${unresolvedIds.join(', ')}을(를) 스펙에서 찾을 수 없습니다)` };
  }

  const runtime = loadTicketRuntime(cwd, ticketId);
  // 재리뷰(고친 커밋만 본다, WI-G24): lastReviewedCommit 이 있으면 최우선(명시 base
  // 다음). 없으면(첫 리뷰) firstBaseline/baseline — 티켓 전체 diff.
  const runtimeBase =
    typeof runtime?.lastReviewedCommit === 'string'
      ? runtime.lastReviewedCommit
      : typeof runtime?.firstBaseline === 'string'
        ? runtime.firstBaseline
        : typeof runtime?.baseline === 'string'
          ? runtime.baseline
          : undefined;
  const diffArgs = base
    ? ['diff', `${base}..HEAD`]
    : runtimeBase
      ? ['diff', `${runtimeBase}..HEAD`]
      : ['diff', 'HEAD'];
  const diff = await git(diffArgs, cwd);
  if (diff.trim() === '') {
    return {
      missing: 'diff(베이스라인 이후 변경이 없습니다 — awl commit --start 를 먼저 실행했는지 확인하세요)',
    };
  }

  const context = await gatherReviewContext(cwd, config);
  const roundTrips = countReviewRoundTrips(readRecords(cwd, { type: 'review' }), [
    ...conditionIds,
    ticketId,
  ]);

  return {
    bundle: {
      reviewId: newReviewId(),
      criteria,
      diff,
      roundTrips,
      ...context,
    },
  };
}

/** title(sectionBox 제목에 붙는 범위/티켓 표시)·hintCmd(리뷰어에게 넘길 명령)만 호출부마다 다르다. */
function renderReview(bundle: ReviewBundle, title: string, hintCmd: string, c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = [];
  out.push(`reviewId     ${bundle.reviewId}`);
  out.push(`완료 조건    ${bundle.criteria.length}개`);
  out.push(`diff         ${bundle.diff.split('\n').length}줄`);
  out.push(`검증         ${bundle.verify.passed ? color.green('통과') : color.red('실패')}`);
  const skipped = bundle.verify.results.filter((r) => r.skipped).map((r) => r.name);
  if (skipped.length > 0) {
    // 끄는 건 실패가 아니라 경고다(prototype.md:519-524) — 게이트 판단 시점에 조용히
    // 안 돌았다는 사실이 눈에 띄어야 한다("통과했다"와 "안 돌렸다"는 다르다,
    // reference.md:1222).
    out.push(`             ${color.yellow(`[!] 로컬에서 건너뜀: ${skipped.join(', ')}`)}`);
  }
  const ruleCountLine =
    bundle.additionalRuleIds.length > 0
      ? `규칙(review) ${bundle.rules.length}개  ${color.dim(`(+${bundle.additionalRuleIds.length}개 더, hits 낮음 — awl rules --json 으로 확인)`)}`
      : `규칙(review) ${bundle.rules.length}개`;
  out.push(ruleCountLine);
  if (bundle.localSkills.length > 0) {
    // 경고가 아니라 정보다(prototype.md:519-524) — 스킬을 바꾼 건 문제가 아니라 사실.
    out.push(`             ${color.dim(`[i] 로컬 스킬: ${bundle.localSkills.join(', ')}`)}`);
  }
  if (bundle.roundTrips !== undefined) {
    // 왕복 2회 초과면 사람을 불러야 한다(WI-G24, adk-reference.md) — 여기선 표시만
    // 한다(판단은 스킬/사람 몫). 2회까지는 정보, 3회부터 경고.
    const tag = bundle.roundTrips > 2 ? signal(c, 'warn') : signal(c, 'info');
    out.push(`왕복         ${bundle.roundTrips}회  ${tag}${bundle.roundTrips > 2 ? '  2회를 넘었습니다 — 사람을 불러야 합니다' : ''}`);
  }
  out.push('');
  out.push('provenance (리뷰어가 교차검증할 위치)');
  out.push(`  브랜치       ${bundle.provenance.branch}`);
  out.push(`  커밋         ${bundle.provenance.commit.slice(0, 10)}`);
  out.push(`  워크트리     ${bundle.provenance.worktree}`);
  out.push('');
  out.push(color.dim(`리뷰어(서브에이전트)에게는 ${hintCmd} 을 넘기세요.`));
  out.push(
    color.dim(
      `판정을 받으면 awl record review --json '{"reviewId":"${bundle.reviewId}",...}' 로 기록하세요.`,
    ),
  );
  return sectionBox(`리뷰 자료 · ${title}`, out, c);
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
    process.stdout.write(`${renderReview(bundle, range, `awl review ${range} --json`, caps())}\n`);
  }
}

/**
 * `awl review pack <ticket-id>` — 4게이트 티켓 모델용(WI-G23/G24). 성공하면 지금
 * HEAD 를 .awl/tickets/<id>.json 의 lastReviewedCommit 으로 남긴다 — 다음 호출
 * (재리뷰)이 이 지점부터 diff 를 잡아 고친 커밋만 보게 한다(WI-G24, "재리뷰는
 * 고친 커밋만 봐야 한다"). assembleReviewForTicket 자체는 순수하게 유지하고(테스트
 * 용이) 이 쓰기는 CLI 진입점에서만 한다.
 */
export async function runReviewPack(
  ticketId: string,
  opts: { json: boolean; base?: string },
): Promise<void> {
  const { projectRoot, config } = requireConfig();
  const c = caps();
  const result = await assembleReviewForTicket(projectRoot, config, ticketId, opts.base);
  if ('missing' in result) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ missing: result.missing }, null, 2)}\n`);
    } else {
      process.stderr.write(`\n  ${signal(c, 'error')} 재료 부족: ${result.missing}\n`);
    }
    process.exit(1);
    return;
  }
  const existing = loadTicketRuntime(projectRoot, ticketId) ?? {};
  writeTicketRuntime(projectRoot, ticketId, {
    ...existing,
    lastReviewedCommit: result.bundle.provenance.commit,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result.bundle, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${renderReview(result.bundle, `ticket:${ticketId}`, `awl review pack ${ticketId} --json`, c)}\n`,
    );
  }
}
