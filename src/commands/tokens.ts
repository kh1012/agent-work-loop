import { type SessionUsageEvent, readSessionUsageEvents } from '../core/session-log.js';
import { type Caps, caps, makeColors, sectionBox, signal } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { collectLanes } from './lane.js';
import { readRecords } from './record.js';

/**
 * awl tokens <ticket-id> — 티켓별·단계별 토큰 사용량(ADK stage 5, WI-E).
 *
 * awl 은 토큰을 직접 못 센다. 대신 시각을 갖고 있다 — 이 티켓의 기록(시작~끝)과
 * 그 구간의 세션 로그(core/session-log.ts) usage 를 시각으로 엮는다.
 *
 * 단계 귀속은 휴리스틱이다(완벽한 정확도는 범위 밖) — 레코드를 시각순으로 늘어놓고
 * 인접 레코드 사이 구간에 든 usage 를 그 구간을 연 레코드의 `type`(spike/attempt/
 * review/audit/gate 등, ADK 6단계로 억지로 매핑하지 않는다 — 있는 그대로가 더 정직하다)
 * 으로 묶어 합산한다.
 *
 * input/output/cache 는 절대 합치지 않는다 — 캐시 읽기는 싸서 합치면 실제 비용과
 * 어긋난다(prototype.md).
 */

export interface TokenTotals {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface StageTokens extends TokenTotals {
  stage: string;
}

export interface TokensReport {
  ticketId: string;
  /** 이 티켓의 레코드가 아예 없으면 false — 나머지 필드는 0/빈 값. */
  found: boolean;
  windowStart?: string;
  windowEnd?: string;
  total: TokenTotals;
  byStage: StageTokens[];
}

function zeroTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
}

function addEvent(totals: TokenTotals, e: SessionUsageEvent): void {
  totals.input += e.inputTokens;
  totals.output += e.outputTokens;
  totals.cacheCreation += e.cacheCreationTokens;
  totals.cacheRead += e.cacheReadTokens;
}

/**
 * 순수 함수 — 그 티켓의 레코드(시각순 정렬 안 돼 있어도 됨)와 세션 usage 이벤트로부터
 * 리포트를 계산한다. 레코드가 없으면 found:false 로 즉시 끝난다(세션 로그가 있어도
 * 시간창을 못 잡으므로 의미 없다 — awl 이 가진 "시각"이 출발점이다).
 */
export function computeTokensReport(
  ticketId: string,
  records: Record<string, unknown>[],
  sessionEvents: SessionUsageEvent[],
): TokensReport {
  const withAt = records
    .filter((r): r is Record<string, unknown> & { at: string } => typeof r.at === 'string')
    .sort((a, b) => a.at.localeCompare(b.at));

  if (withAt.length === 0) {
    return { ticketId, found: false, total: zeroTotals(), byStage: [] };
  }

  const first = withAt[0];
  const last = withAt[withAt.length - 1];
  if (!first || !last) {
    // withAt.length === 0 은 이미 위에서 걸러졌으니 이론상 못 오지만, 인덱스
    // 접근을 좁혀 noUncheckedIndexedAccess 를 만족시킨다.
    return { ticketId, found: false, total: zeroTotals(), byStage: [] };
  }
  const windowStart = first.at;
  const windowEnd = last.at;

  const inWindow = sessionEvents.filter(
    (e) => e.timestamp >= windowStart && e.timestamp <= windowEnd,
  );

  // 인접 레코드 사이 구간 — record[i].at ~ record[i+1].at(마지막은 windowEnd 까지).
  // 그 구간에 든 이벤트를 record[i] 의 type 으로 묶는다.
  const byStageMap = new Map<string, TokenTotals>();
  const total = zeroTotals();
  for (const e of inWindow) {
    addEvent(total, e);
    // 이 이벤트 시각보다 뒤(또는 같음)인 첫 레코드를 못 찾을 때까지, 그 이벤트를
    // "연" 레코드 = 이 이벤트 시각 이하인 마지막 레코드.
    let owner = first;
    for (const r of withAt) {
      if (r.at <= e.timestamp) {
        owner = r;
      } else {
        break;
      }
    }
    const stage = typeof owner.type === 'string' ? owner.type : '(알 수 없음)';
    const bucket = byStageMap.get(stage) ?? zeroTotals();
    addEvent(bucket, e);
    byStageMap.set(stage, bucket);
  }

  const byStage: StageTokens[] = Array.from(byStageMap.entries()).map(([stage, t]) => ({
    stage,
    ...t,
  }));
  byStage.sort((a, b) => b.input - a.input);

  return { ticketId, found: true, windowStart, windowEnd, total, byStage };
}

function pct(part: number, whole: number): string {
  if (whole <= 0) {
    return '0%';
  }
  return `${Math.round((part / whole) * 100)}%`;
}

export function renderTokensReport(report: TokensReport, c: Caps): string {
  const color = makeColors(c.color);
  if (!report.found) {
    return sectionBox(`tokens · ${report.ticketId}`, [
      `${signal(c, 'info')} 이 티켓의 기록이 없습니다.`,
      color.dim('awl record 로 이 티켓(workitem)에 대한 기록을 먼저 남기세요.'),
    ], c);
  }
  const out: string[] = [];
  out.push(`구간   ${report.windowStart} ~ ${report.windowEnd}`);
  out.push('');
  out.push(
    `총     input ${report.total.input.toLocaleString()} · output ${report.total.output.toLocaleString()} · cache생성 ${report.total.cacheCreation.toLocaleString()} · cache읽기 ${report.total.cacheRead.toLocaleString()}`,
  );
  if (report.byStage.length === 0) {
    out.push('');
    out.push(color.dim('이 구간에 대응하는 세션 로그 usage 를 못 찾았습니다.'));
  } else {
    out.push('');
    for (const s of report.byStage) {
      out.push(
        `  ${s.stage.padEnd(12, ' ')}input ${s.input.toLocaleString().padStart(8, ' ')} (${pct(s.input, report.total.input)})  output ${s.output.toLocaleString()}  cache생성 ${s.cacheCreation.toLocaleString()}  cache읽기 ${s.cacheRead.toLocaleString()}`,
      );
    }
  }
  return sectionBox(`tokens · ${report.ticketId}`, out, c);
}

export interface LaneTokensEntry extends TokenTotals {
  /** '(메인)' 은 레인 접미사가 없는 기록(메인 트리 또는 워크트리 없는 세션). */
  lane: string;
}

export interface LaneTokensReport {
  lanes: LaneTokensEntry[];
  total: TokenTotals;
}

const MAIN_LANE_LABEL = '(메인)';

function sumTotals(totals: TokenTotals[]): TokenTotals {
  const sum = zeroTotals();
  for (const t of totals) {
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheCreation += t.cacheCreation;
    sum.cacheRead += t.cacheRead;
  }
  return sum;
}

/**
 * 순수 함수 — 레인(+메인)마다 이미 갖고 온 기록·세션 이벤트로 합계를 낸다(WI-G17d).
 * 레인 하나당 computeTokensReport 를 그대로 재사용해 그 레인의 기록 시간창과 세션
 * usage 를 엮는다(레인 이름을 ticketId 자리에 넣어 재사용 — 의미는 "이 레인 전체").
 * I/O(readRecords/readSessionUsageEvents/collectLanes)는 호출부(computeLaneTokensReport)
 * 가 맡는다 — 테스트가 실제 ~/.claude/projects 세션 로그나 git 없이도 이 로직을 검증한다.
 */
export function buildLaneTokensReport(
  buckets: { lane: string; records: Record<string, unknown>[]; events: SessionUsageEvent[] }[],
): LaneTokensReport {
  const entries: LaneTokensEntry[] = [];
  for (const b of buckets) {
    const report = computeTokensReport(b.lane, b.records, b.events);
    if (report.found) {
      entries.push({ lane: b.lane, ...report.total });
    }
  }
  entries.sort((a, b) => b.input - a.input);
  return { lanes: entries, total: sumTotals(entries) };
}

/**
 * 레인별 토큰 합계(WI-G17d, ADK stage 5 "레인을 여럿 돌리면 레인별 합계와 총합이
 * 나와야 한다"). 레인마다 세션 로그가 그 워크트리 경로(sessionLogDir)에 따로
 * 쌓이므로(mangleProjectPath 가 절대경로를 그대로 쓴다), main 의 records/session-log
 * 뿐 아니라 각 레인 워크트리의 것도 따로 읽어야 한다 — lane.ts collectLanes 로 경로를
 * 얻는다. 집계 로직 자체는 buildLaneTokensReport(순수)에 맡긴다.
 */
export async function computeLaneTokensReport(projectRoot: string): Promise<LaneTokensReport> {
  const allRecords = readRecords(projectRoot);
  const lanes = await collectLanes(projectRoot);

  const buckets = [
    {
      lane: MAIN_LANE_LABEL,
      records: allRecords.filter((r) => typeof r.lane !== 'string'),
      events: readSessionUsageEvents(projectRoot),
    },
    ...lanes.map((l) => ({
      lane: l.name,
      records: allRecords.filter((r) => r.lane === l.name),
      events: readSessionUsageEvents(l.path),
    })),
  ];

  return buildLaneTokensReport(buckets);
}

export function renderLaneTokensReport(report: LaneTokensReport, c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = [];
  if (report.lanes.length === 0) {
    out.push(color.dim('레인·메인 어디에도 대응하는 기록/세션 로그를 못 찾았습니다.'));
    return sectionBox('tokens · 레인별', out, c);
  }
  for (const l of report.lanes) {
    out.push(
      `  ${l.lane.padEnd(12, ' ')}input ${l.input.toLocaleString().padStart(8, ' ')}  output ${l.output.toLocaleString()}  cache생성 ${l.cacheCreation.toLocaleString()}  cache읽기 ${l.cacheRead.toLocaleString()}`,
    );
  }
  out.push('');
  out.push(
    `총     input ${report.total.input.toLocaleString()} · output ${report.total.output.toLocaleString()} · cache생성 ${report.total.cacheCreation.toLocaleString()} · cache읽기 ${report.total.cacheRead.toLocaleString()}`,
  );
  return sectionBox('tokens · 레인별', out, c);
}

export async function runTokensByLane(opts: { json?: boolean } = {}): Promise<void> {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n`,
    );
    process.exit(1);
    return;
  }
  const report = await computeLaneTokensReport(projectRoot);
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderLaneTokensReport(report, caps())}\n`);
}

export async function runTokens(
  ticketId: string,
  opts: { json?: boolean } = {},
): Promise<void> {
  const projectRoot = resolveProjectRoot();
  if (!projectRoot) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const records = readRecords(projectRoot, { workitem: ticketId });
  const sessionEvents = readSessionUsageEvents(projectRoot);
  const report = computeTokensReport(ticketId, records, sessionEvents);

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderTokensReport(report, caps())}\n`);
}
