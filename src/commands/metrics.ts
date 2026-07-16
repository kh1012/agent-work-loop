import fs from 'node:fs';
import path from 'node:path';
import { generationsDir } from '../core/paths.js';
import { type Caps, caps, card, makeColors } from '../core/tty.js';
import { requireConfig } from './config.js';

/**
 * awl metrics — 세대(워크아이템)별 프록시 지표 추세를 보여준다.
 *
 * awl 은 LLM 토큰을 측정할 수 없다. 시도 횟수/막힘 비율/리뷰 지적 수/절차 실수/
 * gotcha 적용·누락 같은 프록시 지표만 센다(evolve.ts 가 워크아이템을 닫을 때마다
 * 이미 ~/.awl/generations/<project>/<WI>.json 에 쌓아둔 것을 그대로 읽는다).
 */

export interface CoverageSnapshot {
  auditFindingsTotal: number;
  addressed: number;
  excluded: number;
  excludedApprovedByHuman: boolean;
}

export interface Generation {
  workitem: string;
  at: string;
  criteriaTotal: number;
  avgAttempts: number;
  blockedRatio: number;
  reviewRejects: number;
  proceduralErrors: number;
  gotchaApplied: number;
  gotchaMissed: number;
  coverage: CoverageSnapshot;
}

/** 워크아이템마다 난이도가 다르다는 경고 — 사람용/JSON 양쪽에 항상 포함한다. */
export function renderMetricsCaveat(): string {
  return '워크아이템마다 난이도가 다릅니다 — 세대 간 절대 비교보다는 경향(추세)만 참고하세요.';
}

/** coverage 가 없는 옛 스냅샷(WI-T 이전)도 0/false 로 채워 하위호환한다. */
function readCoverage(raw: unknown): CoverageSnapshot {
  const c = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    auditFindingsTotal: num(c.auditFindingsTotal),
    addressed: num(c.addressed),
    excluded: num(c.excluded),
    excludedApprovedByHuman: c.excludedApprovedByHuman === true,
  };
}

/**
 * 프로젝트의 세대 스냅샷을 전부 읽어 시간순(at)으로 정렬한다.
 * gotchaApplied/gotchaMissed 가 없는 옛 스냅샷(WI-P 이전)도 0으로 채워 하위호환한다.
 */
export function loadGenerations(project: string): Generation[] {
  const dir = generationsDir(project);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const generations: Generation[] = [];
  for (const f of files) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue; // 깨진 파일은 건너뛴다.
    }
    generations.push({
      workitem: typeof raw.workitem === 'string' ? raw.workitem : f.replace(/\.json$/, ''),
      at: typeof raw.at === 'string' ? raw.at : '',
      criteriaTotal: num(raw.criteriaTotal),
      avgAttempts: num(raw.avgAttempts),
      blockedRatio: num(raw.blockedRatio),
      reviewRejects: num(raw.reviewRejects),
      proceduralErrors: num(raw.proceduralErrors),
      gotchaApplied: num(raw.gotchaApplied),
      gotchaMissed: num(raw.gotchaMissed),
      coverage: readCoverage(raw.coverage),
    });
  }
  generations.sort((a, b) => a.at.localeCompare(b.at));
  return generations;
}

/** 사람용 세대 표 렌더링. export 해 리뷰/테스트가 직접 볼 수 있게 한다 (WI-P 리뷰 지적). */
export function renderMetrics(generations: Generation[], c: Caps): string {
  const color = makeColors(c.color);
  const caveat = color.dim(renderMetricsCaveat());
  if (generations.length === 0) {
    return card('세대 지표', ['세대 기록이 없습니다.', '', caveat], c);
  }
  const idWidth = Math.max(...generations.map((g) => g.workitem.length), 9) + 2;
  const out: string[] = [];
  out.push(
    `${'워크아이템'.padEnd(idWidth, ' ')}완료조건  시도평균  막힘비율  리뷰지적  절차실수  gotcha적용  gotcha누락  커버리지`,
  );
  for (const g of generations) {
    const coverage = `${g.coverage.addressed}/${g.coverage.auditFindingsTotal}`;
    out.push(
      `${g.workitem.padEnd(idWidth, ' ')}${String(g.criteriaTotal).padEnd(10, ' ')}${String(g.avgAttempts).padEnd(10, ' ')}${String(g.blockedRatio).padEnd(10, ' ')}${String(g.reviewRejects).padEnd(10, ' ')}${String(g.proceduralErrors).padEnd(10, ' ')}${String(g.gotchaApplied).padEnd(12, ' ')}${String(g.gotchaMissed).padEnd(12, ' ')}${coverage}`,
    );
  }
  out.push('');
  out.push(caveat);
  return card(`세대 ${generations.length}개 · 시간순`, out, c);
}

/** awl metrics */
export function runMetrics(opts: { json?: boolean }): void {
  const { config } = requireConfig();
  const generations = loadGenerations(config.project);
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ generations, caveat: renderMetricsCaveat() }, null, 2)}\n`,
    );
    return;
  }
  process.stdout.write(`${renderMetrics(generations, caps())}\n`);
}
