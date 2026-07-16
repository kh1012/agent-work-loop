import { type Caps, caps, card, makeColors, signal } from '../core/tty.js';
import { readRecords } from './record.js';

/**
 * awl feedback — awl 도구 자체 피드백(awl-feedback)을 area 별로 묶어 보여준다.
 *
 * awl 은 판단하지 않는다. 묶고 세고 정렬만 한다 — "이렇게 고쳐라"를 말하지 않는다.
 * 2회 이상 반복된 area 를 강조하는 것까지가 awl 의 몫이다(반복이 곧 우선순위 신호).
 * 번역(패치로 바꾸기)은 사람 + LLM 이 한다.
 *
 * ~/.awl 의 기록을 읽으므로 어느 폴더에서 실행하든 내용은 같다(프로젝트 무관).
 */

/** 심각도 정렬 순위 (high 가 먼저 온다). */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

export interface FeedbackFilter {
  area?: string;
  severity?: string;
  /** ISO 문자열. at 이 이 값 이상인 기록만 (사전식 비교 — ISO 라 안전). */
  since?: string;
}

export interface AreaGroup {
  count: number;
  repeated: boolean;
  items: Record<string, unknown>[];
}

export interface FeedbackReport {
  /** 이 피드백들이 나온 서로 다른 워크아이템 수. */
  collectedFrom: number;
  areas: Record<string, AreaGroup>;
  /** count 2 이상인 area 를 count 내림차순으로 — 우선 검토 신호. */
  prioritized: string[];
}

/** awl-feedback 기록을 읽어 필터를 적용한다(프로젝트 무관, ~/.awl 전역). */
export function loadAwlFeedback(filter: FeedbackFilter = {}): Record<string, unknown>[] {
  let records = readRecords().filter((r) => r.type === 'awl-feedback');
  if (filter.area) {
    records = records.filter((r) => r.area === filter.area);
  }
  if (filter.severity) {
    records = records.filter((r) => r.severity === filter.severity);
  }
  if (filter.since) {
    // ISO 표기가 서로 다르면(밀리초 없음, 숫자 UTC 오프셋 +09:00 등) 사전식 비교가
    // 틀린다(적대검증). epoch(ms)로 수치 비교한다. since 파싱 불가면 필터 무시.
    const sinceMs = new Date(filter.since).getTime();
    if (!Number.isNaN(sinceMs)) {
      records = records.filter((r) => {
        if (typeof r.at !== 'string') {
          return false;
        }
        const atMs = new Date(r.at).getTime();
        return !Number.isNaN(atMs) && atMs >= sinceMs;
      });
    }
  }
  return records;
}

/** --since 값이 파싱 불가한 날짜인가 (runFeedback 이 안내에 쓴다). */
export function isInvalidSince(since: string | undefined): boolean {
  return typeof since === 'string' && since !== '' && Number.isNaN(new Date(since).getTime());
}

/** area 별로 묶고 count/repeated/severity 정렬만 한다. 판단하지 않는다. */
export function buildFeedbackReport(records: Record<string, unknown>[]): FeedbackReport {
  const areas: Record<string, AreaGroup> = {};
  const workitems = new Set<string>();
  for (const r of records) {
    if (typeof r.workitem === 'string') {
      workitems.add(r.workitem);
    }
    const area = typeof r.area === 'string' ? r.area : '기타';
    const g = areas[area] ?? { count: 0, repeated: false, items: [] };
    g.count += 1;
    g.items.push(r);
    areas[area] = g;
  }
  for (const g of Object.values(areas)) {
    g.repeated = g.count >= 2; // gotcha 2회 승격과 같은 원리 — 반복이 우선순위 신호.
    g.items.sort(
      (a, b) => (SEVERITY_RANK[String(a.severity)] ?? 3) - (SEVERITY_RANK[String(b.severity)] ?? 3),
    );
  }
  const prioritized = Object.entries(areas)
    .filter(([, g]) => g.count >= 2)
    .sort(([, a], [, b]) => b.count - a.count)
    .map(([area]) => area);
  return { collectedFrom: workitems.size, areas, prioritized };
}

/** 사람용 렌더. 해법을 제시하지 않는다 — 묶어 보여주고 "우선 검토하세요"까지만. */
export function renderFeedback(report: FeedbackReport, c: Caps): string {
  const color = makeColors(c.color);
  const entries = Object.entries(report.areas).sort(([, a], [, b]) => b.count - a.count);
  if (entries.length === 0) {
    return card(
      'awl 자체 피드백',
      [
        '아직 수집된 awl-feedback 이 없습니다.',
        '',
        color.dim(
          '워크아이템을 닫을 때(evolve) awl 도구 자체가 불편했다면 awl record awl-feedback 으로 남기세요.',
        ),
      ],
      c,
    );
  }
  const out: string[] = [];
  for (const [area, g] of entries) {
    const tag = g.repeated ? `  ${signal(c, 'warn')} 반복` : ''; // 하드코딩 [!] 대신 caps 폴백(F-07)
    out.push(`${color.bold(area)}   ${g.count}건${tag}`);
    for (const item of g.items) {
      const wi = typeof item.workitem === 'string' ? item.workitem : '?';
      const sev = String(item.severity ?? '?');
      out.push(`  ${color.dim('-')} ${String(item.what ?? '')}  ${color.dim(`(${wi}, ${sev})`)}`);
    }
    out.push('');
  }
  if (report.prioritized.length > 0) {
    const list = report.prioritized.map((a) => `${a}(${report.areas[a]?.count})`).join(', ');
    out.push(color.yellow(`2회 이상 반복된 area: ${list}`));
    out.push(
      color.dim(
        '→ 이 area 를 우선 검토하세요. 무엇을 고칠지는 사람이 정합니다(awl 은 판단하지 않습니다).',
      ),
    );
  }
  return card(`awl 자체 피드백 · 워크아이템 ${report.collectedFrom}개에서 수집`, out, c);
}

/** awl feedback */
export function runFeedback(opts: {
  json?: boolean;
  area?: string;
  severity?: string;
  since?: string;
}): void {
  if (isInvalidSince(opts.since)) {
    process.stderr.write(
      `\n  ${signal(caps(), 'warn')} --since '${opts.since}' 를 날짜로 읽지 못해 무시합니다. 예: 2026-07-01\n`,
    );
  }
  const records = loadAwlFeedback({ area: opts.area, severity: opts.severity, since: opts.since });
  const report = buildFeedbackReport(records);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderFeedback(report, caps())}\n`);
}
