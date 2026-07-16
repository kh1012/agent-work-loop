import { resolveProjectRoot } from './config.js';
import { loadProjectName, readRecords } from './record.js';

/**
 * awl brief — KST "오늘"의 진행분(records)을 모아 낸다.
 *
 * awl 은 판단하지 않는다 — KST 경계로 records 를 모아 데이터·상태만 낸다.
 * 가이드·큐레이션(사람 친화 "오늘 한 일 정리")은 스킬(별도 LLM CLI) 몫이다.
 *
 * 저장은 UTC 를 유지한다(record `at` 은 `new Date().toISOString()`, UTC ISO).
 * brief 만 표시·필터 시점에 KST(+9)로 변환한다 — 저장 포맷은 안 바꾼다.
 */

/** KST 는 UTC+9. 서머타임 없음(고정 오프셋). */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * UTC epoch ms 를 KST 달력 날짜 'YYYY-MM-DD' 로 변환한다(순수).
 *
 * +9h 시프트한 시각의 UTC 달력 부분이 곧 KST 달력이다.
 * 예: 2026-07-16T15:00:00Z → KST 2026-07-17(자정 넘어감).
 */
export function kstDateOf(utcMs: number): string {
  const shifted = new Date(utcMs + KST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * KST 날짜 'YYYY-MM-DD' 의 UTC epoch 범위 [startMs, endMs) 를 낸다(순수, 반열림).
 *
 * KST 00:00 = 그 오프셋(+09:00)을 붙여 파싱하면 곧 UTC 경계다.
 * 잘못된 날짜면 startMs 가 NaN — 호출부가 판정한다(awl 은 던지지 않는다).
 */
export function kstDayRange(kstDate: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(`${kstDate}T00:00:00.000+09:00`);
  return { startMs, endMs: startMs + DAY_MS };
}

/**
 * records 를 project + KST 오늘 범위 [start, end) 로 재필터한다(순수).
 *
 * readRecords 는 type/workitem 만 필터하므로(project 는 조회 안 함) brief 가
 * project 와 KST-오늘 경계로 한 번 더 거른다. `at` 파싱 불가 레코드는 버린다.
 */
export function recordsInKstDay(
  records: Record<string, unknown>[],
  project: string | undefined,
  range: { startMs: number; endMs: number },
): Record<string, unknown>[] {
  return records.filter((r) => {
    if (project && r.project !== project) {
      return false;
    }
    const t = Date.parse(String(r.at));
    if (Number.isNaN(t)) {
      return false;
    }
    return t >= range.startMs && t < range.endMs;
  });
}

export interface BriefCliOpts {
  today?: boolean;
  date?: string;
  json?: boolean;
}

/**
 * awl brief 진입점. KST 오늘(또는 --date)의 records 를 모아 낸다.
 * --date 가 있으면 그 날, 없으면 KST 오늘(Date.now 기준)을 쓴다.
 */
export async function runBrief(opts: BriefCliOpts): Promise<void> {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('프로젝트 루트를 찾지 못했습니다(.git/.awl 없음).\n');
    process.exitCode = 1;
    return;
  }
  const project = loadProjectName(root);
  const date =
    typeof opts.date === 'string' && opts.date !== '' ? opts.date : kstDateOf(Date.now());
  const range = kstDayRange(date);
  if (Number.isNaN(range.startMs)) {
    process.stderr.write(`날짜 형식이 잘못됐습니다: ${date} (YYYY-MM-DD 필요)\n`);
    process.exitCode = 1;
    return;
  }

  const dayRecords = recordsInKstDay(readRecords(), project, range);

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ date, project, records: dayRecords }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${date} (KST) — records ${dayRecords.length}건\n`);
}
