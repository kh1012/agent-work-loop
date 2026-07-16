import { run } from '../core/runner.js';
import { resolveProjectRoot } from './config.js';
import { loadProjectName, readRecords } from './record.js';
import { loadState } from './state.js';

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

/** 그날의 한 커밋(요약). */
export interface BriefCommit {
  hash: string;
  subject: string;
}

/** 스킬이 소비하는 오늘 요약 구조. awl 은 데이터만 낸다(판단은 스킬). */
export interface Brief {
  date: string;
  project?: string;
  records: { type: string; workitem?: string; at: string; summary: string }[];
  commits: BriefCommit[];
  criteria: { id: string; status: string }[];
  verifyItems: VerifyItem[];
}

/** 검증 항목(사람이 눈으로 볼 것). how 는 방법(딥링크/화면/절차), 없으면 비움. */
export interface VerifyItem {
  what: string;
  how?: string;
  source: string; // 'record' | 'criterion' | 'heuristic'
}

/**
 * 레코드를 타입별로 짧게 요약한다(순수). 사람/스킬이 훑기 좋게 한 줄.
 * 마땅한 필드가 없으면 type 자체를 요약으로 쓴다.
 */
export function summarizeRecord(r: Record<string, unknown>): string {
  const type = String(r.type ?? '');
  if (type === 'gate') {
    return `gate${r.gate ?? '?'} ${r.decision ?? ''}`.trim();
  }
  const pick = r.what ?? r.lesson ?? r.scope ?? r.question ?? r.kind ?? r.condition ?? r.조건 ?? '';
  const s = String(pick).trim();
  return s !== '' ? s : type;
}

/** 시각 확인이 필요한 파일 확장자(변경 시 사람이 눈으로 볼 후보). */
const UI_EXT_RE = /\.(tsx|jsx|css|scss|sass|less|vue|svelte|html)$/i;
/** 시각 확인이 필요한 디렉토리(editor/components/views/pages). 로직 .ts 도 포함될 수 있으나 힌트다. */
const UI_DIR_RE = /(^|\/)(editor|components?|views?|pages?)(\/|$)/i;

function isUiFile(f: string): boolean {
  return UI_EXT_RE.test(f) || UI_DIR_RE.test(f);
}

/**
 * 검증 항목을 추출한다(순수). 명시필드 우선 + UI 파일변경 휴리스틱 보조.
 *
 * 명시(records/criteria 의 `manualVerify:true` 또는 `verifyHow` 문자열)를 먼저,
 * 그다음 UI 파일변경 휴리스틱을 뒤에 붙인다 — 명시가 항상 앞. `how`(방법)는
 * 명시필드의 `verifyHow` 에서만 오고, 휴리스틱엔 없다(비움). awl 은 무엇을·어떻게
 * 목록만 낸다 — 실행·큐레이션은 사람/스킬 몫이다.
 */
export function extractVerifyItems(
  records: Record<string, unknown>[],
  criteria: Record<string, unknown>[],
  changedFiles: string[],
): VerifyItem[] {
  const items: VerifyItem[] = [];
  const pushExplicit = (o: Record<string, unknown>, source: string): void => {
    const explicit = o.manualVerify === true || typeof o.verifyHow === 'string';
    if (!explicit) {
      return;
    }
    const what = String(o.what ?? o.조건 ?? o.condition ?? o.id ?? '(수동 검증 항목)');
    const how = typeof o.verifyHow === 'string' ? o.verifyHow : undefined;
    items.push({ what, how, source });
  };
  for (const r of records) {
    pushExplicit(r, 'record');
  }
  for (const c of criteria) {
    pushExplicit(c, 'criterion');
  }
  for (const f of changedFiles) {
    if (isUiFile(f)) {
      items.push({ what: `UI 변경: ${f}`, source: 'heuristic' });
    }
  }
  return items;
}

/**
 * 오늘 요약 3축(records/commits/criteria) + verifyItems 를 조립한다(순수).
 *
 * records 는 KST-오늘+project 로 이미 필터된 것을 받아 {type,workitem,at,summary}
 * 로 압축한다. criteria 는 {id,status} 로만 압축한다(baseline/attempts 등 내부필드 제외).
 * verifyItems 는 AC-04 에서 extractVerifyItems 로 채운다(여기선 빈 배열).
 */
export function buildBrief(input: {
  date: string;
  project?: string;
  records: Record<string, unknown>[];
  commits: BriefCommit[];
  criteria: Record<string, unknown>[];
  changedFiles: string[];
}): Brief {
  return {
    date: input.date,
    project: input.project,
    records: input.records.map((r) => ({
      type: String(r.type ?? ''),
      workitem: typeof r.workitem === 'string' ? r.workitem : undefined,
      at: String(r.at ?? ''),
      summary: summarizeRecord(r),
    })),
    commits: input.commits,
    criteria: input.criteria.map((c) => ({
      id: String(c.id ?? ''),
      status: String(c.status ?? ''),
    })),
    verifyItems: [],
  };
}

export interface BriefCliOpts {
  today?: boolean;
  date?: string;
  json?: boolean;
}

/**
 * 그날(KST 경계)의 git 커밋을 모은다(I/O). --since/--until 을 UTC ISO 경계로 넘긴다.
 * git 이 없거나 실패하면 빈 배열(brief 는 부분 데이터라도 낸다).
 */
async function gitCommitsInRange(
  root: string,
  range: { startMs: number; endMs: number },
): Promise<BriefCommit[]> {
  try {
    const r = await run({
      cmd: 'git',
      args: [
        'log',
        `--since=${new Date(range.startMs).toISOString()}`,
        `--until=${new Date(range.endMs).toISOString()}`,
        '--format=%H%x00%s',
      ],
      cwd: root,
      timeoutMs: 10_000,
    });
    if (r.exitCode !== 0) {
      return [];
    }
    const commits: BriefCommit[] = [];
    for (const line of r.stdout.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      const [hash, subject] = line.split('\0');
      commits.push({ hash: (hash ?? '').slice(0, 9), subject: subject ?? '' });
    }
    return commits;
  } catch {
    return [];
  }
}

/**
 * awl brief 진입점. KST 오늘(또는 --date)의 records/commits/criteria 를 모아 낸다.
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
  const commits = await gitCommitsInRange(root, range);
  const state = loadState(root);
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];

  const brief = buildBrief({
    date,
    project,
    records: dayRecords,
    commits,
    criteria,
    changedFiles: [],
  });

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(brief, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    `${date} (KST) — records ${brief.records.length} · commits ${brief.commits.length} · criteria ${brief.criteria.length}\n`,
  );
}
