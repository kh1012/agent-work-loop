import fs from 'node:fs';
import { backlogCursorPath } from '../core/paths.js';
import { type Caps, caps, makeColors, sectionBox, signal } from '../core/tty.js';
import { type Gotcha, loadGotchaList } from './evolve.js';
import { loadRules, type Rule } from './rules.js';

/**
 * awl backlog — 정리 신호(ADK stage 6). awl 은 판단하지 않는다: 무엇을 승격할지, 언제
 * 회의를 소집할지는 사람이 정한다. awl 은 쌓인 것을 세고 보여주기만 한다.
 *
 * "3회 반복된 승격 후보"만 센다(prototype.md) — gotcha.count 는 evolve.ts 의
 * recordGotcha 가 이미 세고 있으므로(sameAs 매칭마다 +1), 여기서는 그 카운트를
 * 그대로 읽는다. 이미 규칙으로 승격된 gotcha(rule.source 가 가리킴)는 뺀다.
 *
 * "지난 정리 이후 증분" — 누적이 아니라 커서(~/.awl/backlog-cursor.json) 이후로
 * 새 활동(history 에 커서 이후 시각을 가진 항목)이 있는 후보만 센다. --reset 이 커서를
 * 지금 시각으로 갱신한다. rule/gotcha 파일 자체는 안 건드린다 — "정리의 산출물은
 * 기존 것들의 변경이다"(prototype.md) — 사람이 직접 승격/수정한다.
 */

export const BACKLOG_THRESHOLD = 30;
export const REPEAT_THRESHOLD = 3;

export interface BacklogCursor {
  lastCleanupAt?: string;
}

export function readBacklogCursor(): BacklogCursor {
  try {
    const raw = JSON.parse(fs.readFileSync(backlogCursorPath(), 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.lastCleanupAt === 'string') {
      return { lastCleanupAt: raw.lastCleanupAt };
    }
    return {};
  } catch {
    return {};
  }
}

export function writeBacklogCursor(cursor: BacklogCursor): void {
  fs.writeFileSync(backlogCursorPath(), `${JSON.stringify(cursor, null, 2)}\n`);
}

/** 이미 규칙으로 승격된 gotcha id 집합(rule.source 로 대조). 순수 함수. */
export function promotedGotchaIds(rules: Pick<Rule, 'source'>[]): Set<string> {
  return new Set(
    rules.map((r) => r.source).filter((s): s is string => typeof s === 'string' && s !== ''),
  );
}

/**
 * 3회 이상 반복됐지만 아직 승격되지 않은 gotcha 중, 커서 이후 새 활동(history 항목)이
 * 있는 것만 후보로 남긴다("지난 정리 이후 증분"). 순수 함수.
 */
export function collectBacklogCandidates(
  gotchas: Gotcha[],
  promotedIds: Set<string>,
  sinceIso: string,
): Gotcha[] {
  return gotchas.filter((g) => {
    if (g.count < REPEAT_THRESHOLD || promotedIds.has(g.id)) {
      return false;
    }
    const history = g.history ?? [];
    return history.some((h) => typeof h.at === 'string' && h.at > sinceIso);
  });
}

export interface BacklogReport {
  candidateCount: number;
  candidates: { id: string; lesson: string; count: number }[];
  zeroHitRuleCount: number;
  zeroHitRules: { id: string; body: string }[];
  since?: string;
  overThreshold: boolean;
}

/** 순수 함수 — gotcha/rule/커서로부터 리포트를 계산한다. */
export function computeBacklogReport(
  gotchas: Gotcha[],
  rules: Rule[],
  cursor: BacklogCursor,
): BacklogReport {
  const since = cursor.lastCleanupAt ?? '';
  const candidates = collectBacklogCandidates(gotchas, promotedGotchaIds(rules), since);
  const zeroHitRules = rules.filter((r) => r.hits === 0);
  return {
    candidateCount: candidates.length,
    candidates: candidates.map((g) => ({ id: g.id, lesson: g.lesson, count: g.count })),
    zeroHitRuleCount: zeroHitRules.length,
    zeroHitRules: zeroHitRules.map((r) => ({ id: r.id, body: r.body.split('\n')[0] ?? '' })),
    ...(cursor.lastCleanupAt ? { since: cursor.lastCleanupAt } : {}),
    overThreshold: candidates.length > BACKLOG_THRESHOLD,
  };
}

function renderBacklog(report: BacklogReport, c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = [];

  if (report.overThreshold) {
    out.push(
      `${signal(c, 'warn')} 3회 반복된 승격 후보가 ${report.candidateCount}건 쌓였습니다.`,
    );
  } else {
    out.push(`3회 반복된 승격 후보 ${report.candidateCount}건.`);
  }
  out.push(color.dim(report.since ? `마지막 정리 ${report.since}` : '마지막 정리 기록 없음'));

  if (report.candidates.length > 0) {
    out.push('');
    for (const g of report.candidates) {
      out.push(`  ${g.id}  ${g.lesson}  (${g.count}회)`);
    }
  }

  if (report.zeroHitRules.length > 0) {
    out.push('');
    out.push('함께 볼 것');
    out.push(`  제약 hits 0        ${report.zeroHitRuleCount}건`);
  }

  if (report.candidateCount === 0 && report.zeroHitRules.length === 0) {
    out.push('');
    out.push(color.dim('정리할 신호가 없습니다.'));
  }

  return sectionBox('backlog', out, c);
}

export function runBacklog(opts: { json?: boolean; reset?: boolean } = {}): void {
  const c = caps();
  if (opts.reset) {
    writeBacklogCursor({ lastCleanupAt: new Date().toISOString() });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ reset: true }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`\n  ${makeColors(c.color).green('정리 완료')} — 커서를 지금 시각으로 갱신했습니다.\n`);
    return;
  }

  const gotchas = loadGotchaList();
  const { rules } = loadRules();
  const cursor = readBacklogCursor();
  const report = computeBacklogReport(gotchas, rules, cursor);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderBacklog(report, c)}\n`);
}
