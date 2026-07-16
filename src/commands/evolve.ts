import fs from 'node:fs';
import path from 'node:path';
import { generationsDir, gotchasDir, legacyDeltasDir, lockFile } from '../core/paths.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { requireConfig } from './config.js';
import { computeCoverage, readRecords } from './record.js';
import { loadState } from './state.js';

/**
 * awl evolve — 기록을 교훈(gotcha)으로, 교훈을 규칙으로 잇는다.
 *
 * awl 은 판단하지 않는다. LLM 을 호출하지 않는다.
 * - `--collect`: 기록을 모아 에이전트에게 넘길 자료를 낸다(판단하지 않음).
 * - `--record`: 에이전트가 뽑은 교훈을 gotchas 에 쓰고, 반복 횟수를 센다(만들어내지 않음).
 * 교훈 추출(판단)은 그 사이에서 에이전트가 스킬로 한다.
 */

// ---------------------------------------------------------------------------
// 락 (~/.awl/.lock) — 동시 evolve 가 규칙/교훈을 조용히 날리는 것을 막는다
// ---------------------------------------------------------------------------

export function acquireLock(): boolean {
  const p = lockFile();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const fd = fs.openSync(p, 'wx'); // 이미 있으면 EEXIST
    fs.writeSync(fd, JSON.stringify({ pid: process.pid }));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw e;
  }
}

export function releaseLock(): void {
  try {
    fs.unlinkSync(lockFile());
  } catch {
    // 이미 없으면 무시.
  }
}

// ---------------------------------------------------------------------------
// gotchas 저장/로드 (WI-O — 예전 이름 delta 를 개명함)
// ---------------------------------------------------------------------------

export interface Gotcha {
  id: string;
  lesson: string;
  context?: string;
  source?: Record<string, unknown>;
  sameAs?: string;
  count: number;
  createdAt?: string;
  history?: Record<string, unknown>[];
}

/** D-0XX 형식 ID 를 G-0XX 로 바꾼다. 이미 다른 형식이면(또는 문자열이 아니면) 그대로 둔다. */
function remapDeltaId(id: unknown): unknown {
  if (typeof id !== 'string') {
    return id;
  }
  const m = /^D-(\d+)$/.exec(id);
  return m ? `G-${m[1]}` : id;
}

export interface MigrateDeltasResult {
  /** 이번 호출에서 실제로 옮겼는가(이미 마이그레이션됐으면 false). */
  migrated: boolean;
  count: number;
  backupDir?: string;
}

/**
 * ~/.awl/gotchas/ 가 없고 ~/.awl/deltas/ 만 있으면(레거시 설치) 자동으로
 * 마이그레이션한다(WI-O AC-02) — state.ts 의 migrateState() 와 같은 패턴: 무손실,
 * 멱등, 자동. 원본 deltas/ 는 지우지 않는다(백업도 별도로 만든다 — 이중 안전).
 * 이미 gotchas/ 가 있으면(마이그레이션 완료 또는 애초에 새 설치) 아무것도 안 한다.
 */
export function migrateDeltasToGotchas(): MigrateDeltasResult {
  if (fs.existsSync(gotchasDir())) {
    return { migrated: false, count: 0 };
  }
  const dDir = legacyDeltasDir();
  let files: string[];
  try {
    files = fs.readdirSync(dDir).filter((f) => f.endsWith('.json'));
  } catch {
    return { migrated: false, count: 0 }; // deltas/ 도 없음 — 완전 새 설치.
  }
  if (files.length === 0) {
    return { migrated: false, count: 0 };
  }

  const backupDir = `${dDir}.backup-${Date.now()}`;
  fs.mkdirSync(backupDir, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(dDir, f), path.join(backupDir, f));
  }

  fs.mkdirSync(gotchasDir(), { recursive: true });
  let count = 0;
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dDir, f), 'utf8')) as Record<
        string,
        unknown
      >;
      const migrated = {
        ...raw,
        id: remapDeltaId(raw.id),
        ...(raw.sameAs !== undefined ? { sameAs: remapDeltaId(raw.sameAs) } : {}),
      };
      fs.writeFileSync(
        path.join(gotchasDir(), `${migrated.id}.json`),
        `${JSON.stringify(migrated, null, 2)}\n`,
      );
      count += 1;
    } catch {
      // 깨진 파일은 건너뛴다(loadGotchaList 와 같은 원칙).
    }
  }
  return { migrated: true, count, backupDir };
}

export function loadGotchaList(): Gotcha[] {
  migrateDeltasToGotchas();
  let files: string[];
  try {
    files = fs.readdirSync(gotchasDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Gotcha[] = [];
  for (const f of files.sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(gotchasDir(), f), 'utf8')) as Gotcha);
    } catch {
      // 깨진 파일은 건너뛴다.
    }
  }
  return out;
}

function writeGotcha(g: Gotcha): void {
  fs.mkdirSync(gotchasDir(), { recursive: true });
  fs.writeFileSync(path.join(gotchasDir(), `${g.id}.json`), `${JSON.stringify(g, null, 2)}\n`);
}

function nextGotchaId(gotchas: Gotcha[]): string {
  let max = 0;
  for (const g of gotchas) {
    const m = /^G-(\d+)$/.exec(g.id);
    if (m?.[1]) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `G-${String(max + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

export interface CoverageMetrics {
  auditFindingsTotal: number;
  addressed: number;
  excluded: number;
  excludedApprovedByHuman: boolean;
}

export interface EvolveMetrics {
  criteriaTotal: number;
  avgAttempts: number;
  blockedRatio: number;
  reviewRejects: number;
  proceduralErrors: number;
  gotchaApplied: number;
  gotchaMissed: number;
  coverage: CoverageMetrics;
}

export interface EvolveCollection {
  workitem: string | null;
  project: string;
  blocked: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  retried: Record<string, unknown>[];
  existingGotchas: { id: string; lesson: string; count: number }[];
  metrics: EvolveMetrics;
  /**
   * awl 도구 자체 피드백 유도 (0.6.x). awl 은 판단하지 않는다 — 리마인더(prompt)와
   * 이번 워크아이템에서 이미 남긴 awl-feedback 기록(recorded)만 보여준다. gotcha 와
   * 다른 종류다(작업 코드 교훈이 아니라 awl 도구 자체가 아팠던 점). 에이전트가
   * 이걸 보고 남길지 말지 판단한다 — 매끄러웠으면 안 남긴다.
   */
  awlFeedback: {
    prompt: string;
    recorded: Record<string, unknown>[];
  };
}

/**
 * 이번 워크아이템의 기록을 모은다. 판단하지 않는다. state 는 주입받는다(테스트 가능).
 * scope(months/from/to)를 주면 그 월 파일만 읽는다 — 파이프라인 연속 실행 시 전량로드 회피.
 * scope 미지정이면 전량(하위호환, 오래된 워크아이템 evolve 안전).
 */
export function collectEvolve(
  project: string,
  workitem: string | null,
  state: Record<string, unknown>,
  scope?: { months?: string[]; from?: string; to?: string },
): EvolveCollection {
  const records = readRecords({ ...(workitem ? { workitem } : {}), ...(scope ?? {}) });
  const blocked = records.filter((r) => r.type === 'blocked');
  const reviews = records.filter((r) => r.type === 'review');
  const retried = records.filter(
    (r) => r.type === 'attempt' && typeof r.attempt === 'number' && r.attempt >= 2,
  );
  const gotchaApplied = records.filter((r) => r.type === 'gotcha-applied').length;
  const gotchaMissed = records.filter((r) => r.type === 'gotcha-missed').length;
  // awl 도구 자체 피드백 — 이번 워크아이템에서 이미 남긴 것. gotcha 추출 자료와
  // 섞지 않는다(다른 종류다). 없으면 빈 배열.
  const awlFeedbackRecords = records.filter((r) => r.type === 'awl-feedback');

  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const criteriaTotal = criteria.length;
  const attemptsSum = criteria.reduce((s, c) => s + num(c.attempts), 0);
  const blockedCount = criteria.filter((c) => c.status === 'blocked').length;
  const proceduralErrors = criteria.reduce((s, c) => s + num(c.proceduralErrors), 0);

  const existingGotchas = loadGotchaList().map((g) => ({
    id: g.id,
    lesson: g.lesson,
    count: g.count,
  }));

  // 커버리지 (WI-T AC-04) — computeCoverage(AC-02) 를 재사용해 조사에서 발견한
  // 문제 중 몇 건을 완료 조건이 실제로 다뤘는지 센다. excludedApprovedByHuman 은
  // gate:1 기록이 있고(AC-02 가 이미 배제를 사람에게 제시하도록 강제했으므로,
  // 기록이 있다는 것 자체가 배제가 있었다면 제시됐다는 뜻이다) auto:true(자율
  // 승인)가 아닐 때만 true.
  const auditRecords = records.filter((r) => r.type === 'audit');
  const criteriaRecords = records.filter((r) => r.type === 'criteria');
  const gate1 = records.find((r) => r.type === 'gate' && r.gate === 1);
  const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
  const coverageMetrics: CoverageMetrics = {
    auditFindingsTotal: coverage.auditFindingIds.length,
    addressed: coverage.addressedIds.length,
    excluded: coverage.excludedIds.length,
    excludedApprovedByHuman: Boolean(gate1) && gate1?.auto !== true,
  };

  const metrics: EvolveMetrics = {
    criteriaTotal,
    avgAttempts: criteriaTotal > 0 ? Math.round((attemptsSum / criteriaTotal) * 100) / 100 : 0,
    blockedRatio: criteriaTotal > 0 ? Math.round((blockedCount / criteriaTotal) * 100) / 100 : 0,
    reviewRejects: reviews.length,
    proceduralErrors,
    gotchaApplied,
    gotchaMissed,
    coverage: coverageMetrics,
  };

  const awlFeedback = {
    prompt:
      '이번 워크아이템에서 awl 도구 자체(작업 대상 코드가 아니라)가 불편했던 점이 있나? ' +
      '있으면 awl record awl-feedback 으로 남겨라(area/what/impact/severity, suggestion 은 선택). ' +
      '없으면 넘어가라 — 매끄러웠으면 좋은 신호다. gotcha(작업 코드 교훈)와 다른 종류다.',
    recorded: awlFeedbackRecords,
  };

  return { workitem, project, blocked, reviews, retried, existingGotchas, metrics, awlFeedback };
}

/** 세대 지표를 프로젝트별 디렉토리에 기록한다. */
export function writeGeneration(
  project: string,
  workitem: string | null,
  metrics: EvolveMetrics,
  at: string,
  extra?: Record<string, unknown>,
): string {
  const dir = generationsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${workitem ?? 'unknown'}.json`;
  const file = path.join(dir, name);
  // extra(experiment/startedAt/durationMs 등)는 그대로 스냅샷에 실린다 — metrics
  // --compare 가 케이스 축으로 읽는다(experiment-harness). 없으면 예전과 동일.
  fs.writeFileSync(file, `${JSON.stringify({ workitem, at, ...metrics, ...extra }, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// record (교훈 쓰기 + 반복 세기)
// ---------------------------------------------------------------------------

export interface RecordGotchaInput {
  lesson: string;
  context?: string;
  source?: Record<string, unknown>;
  sameAs?: string;
}

export interface RecordGotchaResult {
  gotcha: Gotcha;
  repeated: boolean; // count >= 2 가 됐는가
  created: boolean; // 새로 만들었는가
}

/** 교훈을 gotchas 에 쓴다. sameAs 가 있으면 기존 교훈의 count 를 올린다. */
export function recordGotcha(input: RecordGotchaInput, at: string): RecordGotchaResult {
  const gotchas = loadGotchaList();

  if (input.sameAs) {
    const existing = gotchas.find((g) => g.id === input.sameAs);
    if (existing) {
      existing.count += 1;
      existing.history = [...(existing.history ?? []), { at, source: input.source }];
      writeGotcha(existing);
      return { gotcha: existing, repeated: existing.count >= 2, created: false };
    }
    // sameAs 가 가리키는 교훈이 없으면 새로 만든다(잘못된 참조 방어).
  }

  const id = nextGotchaId(gotchas);
  const gotcha: Gotcha = {
    id,
    lesson: input.lesson,
    context: input.context,
    source: input.source,
    sameAs: input.sameAs,
    count: 1,
    createdAt: at,
    history: [{ at, source: input.source }],
  };
  writeGotcha(gotcha);
  return { gotcha, repeated: false, created: true };
}

// ---------------------------------------------------------------------------
// 명령 진입점
// ---------------------------------------------------------------------------

function renderRepeatNotice(gotcha: Gotcha, c: Caps): string {
  const color = makeColors(c.color);
  const first = gotcha.history?.[0]?.source as Record<string, unknown> | undefined;
  const last = gotcha.history?.[gotcha.history.length - 1]?.source as
    | Record<string, unknown>
    | undefined;
  const fmt = (s: Record<string, unknown> | undefined): string =>
    s ? `${s.workitem ?? '?'} (${s.project ?? '?'})` : '?';
  return [
    '',
    `  gotcha ${color.bold(gotcha.id)} 이 ${gotcha.count}회 반복됐습니다.`,
    '',
    `    "${gotcha.lesson}"`,
    '',
    `    처음: ${fmt(first)}`,
    `    이번: ${fmt(last)}`,
    '',
    `  ${color.dim(`awl rules promote ${gotcha.id} 으로 규칙을 만들 수 있습니다.`)}`,
    '  (자동 승격하지 않습니다. 사람이 확인합니다.)',
  ].join('\n');
}

/** awl evolve --collect */
export function runEvolveCollect(opts: {
  workitem?: string;
  json: boolean;
  from?: string;
  to?: string;
  months?: string[];
}): void {
  const { projectRoot, config } = requireConfig();
  if (!acquireLock()) {
    process.stderr.write(
      '\n  다른 evolve 가 실행 중입니다(~/.awl/.lock). 끝난 뒤 다시 시도하세요.\n',
    );
    process.exit(1);
  }
  try {
    const workitem = opts.workitem ?? null;
    const state = loadState(projectRoot);
    // 기간 범위가 하나라도 주어지면 그 월만 읽는다(없으면 전량 폴백).
    const scope =
      opts.months !== undefined || opts.from !== undefined || opts.to !== undefined
        ? { months: opts.months, from: opts.from, to: opts.to }
        : undefined;
    const collection = collectEvolve(config.project, workitem, state, scope);
    const at = new Date().toISOString();
    // 실험 케이스 메타(work new --experiment)를 세대 스냅샷에 실어 metrics --compare 가
    // 케이스 축으로 읽게 한다. 없으면(대부분) 예전과 동일.
    const extra: Record<string, unknown> = {};
    if (state.workitemExperiment !== undefined) {
      extra.experiment = state.workitemExperiment;
    }
    writeGeneration(config.project, workitem, collection.metrics, at, extra);
    // collect 는 스킬이 파싱하므로 기본 JSON.
    process.stdout.write(`${JSON.stringify(collection, null, 2)}\n`);
  } finally {
    releaseLock();
  }
}

/** awl evolve --record --json '<교훈>' */
export function runEvolveRecord(jsonInput: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonInput);
  } catch (e) {
    process.stderr.write(`\n  교훈 JSON 을 읽지 못했습니다: ${String(e)}\n`);
    process.exit(1);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    process.stderr.write('\n  교훈은 JSON 객체여야 합니다.\n');
    process.exit(1);
  }
  const data = parsed as Record<string, unknown>;
  if (typeof data.lesson !== 'string' || data.lesson.trim() === '') {
    process.stderr.write('\n  lesson(재사용 가능한 교훈 문장)이 필요합니다.\n');
    process.exit(1);
  }

  // source 를 안 주면 현재 프로젝트/워크아이템으로 자동 채운다 — 호출부가
  // 매번 적어 넣어야만 채워지면 조용히 샌다(D-34, record.ts 의 workitem
  // 자동 태깅과 같은 이유).
  let source = data.source as Record<string, unknown> | undefined;
  if (source === undefined) {
    const { projectRoot, config } = requireConfig();
    const state = loadState(projectRoot);
    source = {
      project: config.project,
      ...(typeof state.workitem === 'string' ? { workitem: state.workitem } : {}),
    };
  }

  if (!acquireLock()) {
    process.stderr.write('\n  다른 evolve 가 실행 중입니다(~/.awl/.lock).\n');
    process.exit(1);
  }
  try {
    const input: RecordGotchaInput = {
      lesson: data.lesson,
      context: typeof data.context === 'string' ? data.context : undefined,
      source,
      sameAs: typeof data.sameAs === 'string' ? data.sameAs : undefined,
    };
    const result = recordGotcha(input, new Date().toISOString());
    if (result.repeated) {
      process.stdout.write(`${renderRepeatNotice(result.gotcha, caps())}\n`);
    } else if (result.created) {
      process.stdout.write(`\n  교훈 ${result.gotcha.id} 을 기록했습니다.\n`);
    } else {
      process.stdout.write(
        `\n  교훈 ${result.gotcha.id} 의 반복을 기록했습니다(${result.gotcha.count}회).\n`,
      );
    }
  } finally {
    releaseLock();
  }
}
