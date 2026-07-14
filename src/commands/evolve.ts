import fs from 'node:fs';
import path from 'node:path';
import { deltasDir, generationsDir, lockFile } from '../core/paths.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { requireConfig, resolveProjectRoot } from './config.js';
import { readRecords } from './record.js';
import { loadState } from './state.js';

/**
 * awl evolve — 기록을 교훈으로, 교훈을 규칙으로 잇는다.
 *
 * awl 은 판단하지 않는다. LLM 을 호출하지 않는다.
 * - `--collect`: 기록을 모아 에이전트에게 넘길 자료를 낸다(판단하지 않음).
 * - `--record`: 에이전트가 뽑은 교훈을 deltas 에 쓰고, 반복 횟수를 센다(만들어내지 않음).
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
// deltas 저장/로드
// ---------------------------------------------------------------------------

export interface Delta {
  id: string;
  lesson: string;
  context?: string;
  source?: Record<string, unknown>;
  sameAs?: string;
  count: number;
  createdAt?: string;
  history?: Record<string, unknown>[];
}

export function loadDeltaList(): Delta[] {
  let files: string[];
  try {
    files = fs.readdirSync(deltasDir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Delta[] = [];
  for (const f of files.sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(deltasDir(), f), 'utf8')) as Delta);
    } catch {
      // 깨진 파일은 건너뛴다.
    }
  }
  return out;
}

function writeDelta(d: Delta): void {
  fs.mkdirSync(deltasDir(), { recursive: true });
  fs.writeFileSync(path.join(deltasDir(), `${d.id}.json`), `${JSON.stringify(d, null, 2)}\n`);
}

function nextDeltaId(deltas: Delta[]): string {
  let max = 0;
  for (const d of deltas) {
    const m = /^D-(\d+)$/.exec(d.id);
    if (m?.[1]) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return `D-${String(max + 1).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

export interface EvolveMetrics {
  criteriaTotal: number;
  avgAttempts: number;
  blockedRatio: number;
  reviewRejects: number;
  proceduralErrors: number;
}

export interface EvolveCollection {
  workitem: string | null;
  project: string;
  blocked: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  retried: Record<string, unknown>[];
  existingDeltas: { id: string; lesson: string; count: number }[];
  metrics: EvolveMetrics;
}

/** 이번 워크아이템의 기록을 모은다. 판단하지 않는다. state 는 주입받는다(테스트 가능). */
export function collectEvolve(
  project: string,
  workitem: string | null,
  state: Record<string, unknown>,
): EvolveCollection {
  const records = readRecords(workitem ? { workitem } : {});
  const blocked = records.filter((r) => r.type === 'blocked');
  const reviews = records.filter((r) => r.type === 'review');
  const retried = records.filter(
    (r) => r.type === 'attempt' && typeof r.attempt === 'number' && r.attempt >= 2,
  );

  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const criteriaTotal = criteria.length;
  const attemptsSum = criteria.reduce((s, c) => s + num(c.attempts), 0);
  const blockedCount = criteria.filter((c) => c.status === 'blocked').length;
  const proceduralErrors = criteria.reduce((s, c) => s + num(c.proceduralErrors), 0);

  const existingDeltas = loadDeltaList().map((d) => ({
    id: d.id,
    lesson: d.lesson,
    count: d.count,
  }));

  const metrics: EvolveMetrics = {
    criteriaTotal,
    avgAttempts: criteriaTotal > 0 ? Math.round((attemptsSum / criteriaTotal) * 100) / 100 : 0,
    blockedRatio: criteriaTotal > 0 ? Math.round((blockedCount / criteriaTotal) * 100) / 100 : 0,
    reviewRejects: reviews.length,
    proceduralErrors,
  };

  return { workitem, project, blocked, reviews, retried, existingDeltas, metrics };
}

/** 세대 지표를 프로젝트별 디렉토리에 기록한다. */
export function writeGeneration(
  project: string,
  workitem: string | null,
  metrics: EvolveMetrics,
  at: string,
): string {
  const dir = generationsDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${workitem ?? 'unknown'}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify({ workitem, at, ...metrics }, null, 2)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// record (교훈 쓰기 + 반복 세기)
// ---------------------------------------------------------------------------

export interface RecordDeltaInput {
  lesson: string;
  context?: string;
  source?: Record<string, unknown>;
  sameAs?: string;
}

export interface RecordDeltaResult {
  delta: Delta;
  repeated: boolean; // count >= 2 가 됐는가
  created: boolean; // 새로 만들었는가
}

/** 교훈을 deltas 에 쓴다. sameAs 가 있으면 기존 교훈의 count 를 올린다. */
export function recordDelta(input: RecordDeltaInput, at: string): RecordDeltaResult {
  const deltas = loadDeltaList();

  if (input.sameAs) {
    const existing = deltas.find((d) => d.id === input.sameAs);
    if (existing) {
      existing.count += 1;
      existing.history = [...(existing.history ?? []), { at, source: input.source }];
      writeDelta(existing);
      return { delta: existing, repeated: existing.count >= 2, created: false };
    }
    // sameAs 가 가리키는 교훈이 없으면 새로 만든다(잘못된 참조 방어).
  }

  const id = nextDeltaId(deltas);
  const delta: Delta = {
    id,
    lesson: input.lesson,
    context: input.context,
    source: input.source,
    sameAs: input.sameAs,
    count: 1,
    createdAt: at,
    history: [{ at, source: input.source }],
  };
  writeDelta(delta);
  return { delta, repeated: false, created: true };
}

// ---------------------------------------------------------------------------
// 명령 진입점
// ---------------------------------------------------------------------------

function renderRepeatNotice(delta: Delta, c: Caps): string {
  const color = makeColors(c.color);
  const first = delta.history?.[0]?.source as Record<string, unknown> | undefined;
  const last = delta.history?.[delta.history.length - 1]?.source as
    | Record<string, unknown>
    | undefined;
  const fmt = (s: Record<string, unknown> | undefined): string =>
    s ? `${s.workitem ?? '?'} (${s.project ?? '?'})` : '?';
  return [
    '',
    `  교훈 ${color.bold(delta.id)} 이 ${delta.count}회 반복됐습니다.`,
    '',
    `    "${delta.lesson}"`,
    '',
    `    처음: ${fmt(first)}`,
    `    이번: ${fmt(last)}`,
    '',
    `  ${color.dim(`awl rules promote ${delta.id} 으로 규칙을 만들 수 있습니다.`)}`,
    '  (자동 승격하지 않습니다. 사람이 확인합니다.)',
  ].join('\n');
}

/** awl evolve --collect */
export function runEvolveCollect(opts: { workitem?: string; json: boolean }): void {
  const { config } = requireConfig();
  if (!acquireLock()) {
    process.stderr.write(
      '\n  다른 evolve 가 실행 중입니다(~/.awl/.lock). 끝난 뒤 다시 시도하세요.\n',
    );
    process.exit(1);
  }
  try {
    const workitem = opts.workitem ?? null;
    const state = loadState(resolveProjectRoot() ?? process.cwd());
    const collection = collectEvolve(config.project, workitem, state);
    const at = new Date().toISOString();
    writeGeneration(config.project, workitem, collection.metrics, at);
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

  if (!acquireLock()) {
    process.stderr.write('\n  다른 evolve 가 실행 중입니다(~/.awl/.lock).\n');
    process.exit(1);
  }
  try {
    const input: RecordDeltaInput = {
      lesson: data.lesson,
      context: typeof data.context === 'string' ? data.context : undefined,
      source: (data.source as Record<string, unknown>) ?? undefined,
      sameAs: typeof data.sameAs === 'string' ? data.sameAs : undefined,
    };
    const result = recordDelta(input, new Date().toISOString());
    if (result.repeated) {
      process.stdout.write(`${renderRepeatNotice(result.delta, caps())}\n`);
    } else if (result.created) {
      process.stdout.write(`\n  교훈 ${result.delta.id} 을 기록했습니다.\n`);
    } else {
      process.stdout.write(
        `\n  교훈 ${result.delta.id} 의 반복을 기록했습니다(${result.delta.count}회).\n`,
      );
    }
  } finally {
    releaseLock();
  }
}
