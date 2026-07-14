import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recordsDir } from '../core/paths.js';
import { run } from '../core/runner.js';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { getCriterion, loadState } from './state.js';

/**
 * awl record — 구조를 강제하는 기록.
 *
 * 줄글을 쓸 자리 자체를 없앤다. 사람이 못 읽는 기록은 기계(evolve)도 못 읽으므로,
 * 시인성은 미관이 아니라 evolve 가 동작하느냐의 문제다.
 * 기록은 append only. 수정/삭제하지 않는다(update 명령을 만들지 않는다).
 */

export type RecordType =
  | 'audit'
  | 'spike'
  | 'criteria'
  | 'attempt'
  | 'blocked'
  | 'review'
  | 'decision';

interface Schema {
  required: string[];
  /** 비어있지 않은 배열이어야 하는 필드 */
  arrays?: string[];
}

/**
 * 타입별 필수 구조. 자유 텍스트 필드 하나로 퉁치지 않는다.
 * (audit/spike/criteria/review/decision 의 구조는 가정 — docs/decisions.md D-15)
 */
export const SCHEMAS: Record<RecordType, Schema> = {
  audit: { required: ['scope', 'findings'], arrays: ['findings'] },
  spike: { required: ['question', 'found'] },
  criteria: { required: ['items'], arrays: ['items'] },
  attempt: { required: ['what', 'why', 'how', 'result'] },
  blocked: { required: ['what', 'why', 'tried', 'lesson'], arrays: ['tried'] },
  review: { required: ['target', 'verdict'] },
  decision: { required: ['question', 'decision', 'rationale'] },
};

export const RECORD_TYPES = Object.keys(SCHEMAS) as RecordType[];

export interface RecordDefaults {
  project?: string;
  id: string;
  at: string;
}

export interface BuildResult {
  record?: Record<string, unknown>;
  missing: string[];
}

/** 새 레코드 id 를 만든다. */
export function newRecordId(): string {
  return `rec_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * 입력 데이터를 검증해 레코드를 만든다. 필수 필드가 없으면 무엇이 빠졌는지 돌려준다.
 * 이것이 구조를 강제하는 방법이다.
 */
export function buildRecord(
  type: RecordType,
  data: Record<string, unknown>,
  defaults: RecordDefaults,
): BuildResult {
  const missing: string[] = [];

  // project 는 필수다. 데이터에 없으면 config 의 project 를 쓴다.
  const project =
    (typeof data.project === 'string' && data.project.trim() !== '' && data.project) ||
    defaults.project;
  if (!project) {
    missing.push('project');
  }

  const schema = SCHEMAS[type];
  for (const field of schema.required) {
    const v = data[field];
    if (v === undefined || v === null || v === '') {
      missing.push(field);
    } else if (schema.arrays?.includes(field) && (!Array.isArray(v) || v.length === 0)) {
      missing.push(`${field} (비어있지 않은 배열이어야 함)`);
    }
  }

  if (missing.length > 0) {
    return { missing };
  }

  const record: Record<string, unknown> = {
    id: defaults.id,
    at: defaults.at,
    project,
    type,
    ...data,
  };
  record.project = project;
  record.type = type;
  record.id = defaults.id;
  record.at = defaults.at;
  return { record, missing: [] };
}

/** at(ISO) 에서 YYYY-MM 월 파일 이름을 만든다. */
export function monthFile(at: string): string {
  const month = at.slice(0, 7); // YYYY-MM
  return path.join(recordsDir(), `${month}.jsonl`);
}

/** 레코드를 월별 JSONL 에 append 한다. 절대 수정하지 않는다. */
export function appendRecord(record: Record<string, unknown>): string {
  const file = monthFile(String(record.at));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return file;
}

/** git diff 를 캡처해 patch 파일로 저장하고 상대경로를 돌려준다. */
export async function captureDiff(id: string, at: string, cwd: string): Promise<string | null> {
  const r = await run({ cmd: 'git', args: ['diff', 'HEAD'], cwd, timeoutMs: 10000 });
  if (r.exitCode !== 0 && r.stdout.trim() === '') {
    return null;
  }
  const diffsDir = path.join(recordsDir(), 'diffs');
  fs.mkdirSync(diffsDir, { recursive: true });
  const name = `${at.slice(0, 10)}-${id}.patch`;
  fs.writeFileSync(path.join(diffsDir, name), r.stdout);
  return path.join('diffs', name);
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

export interface RecordFilter {
  type?: string;
  workitem?: string;
}

/** 모든 월별 JSONL 을 읽어 레코드 배열을 돌려준다(파싱 실패 줄은 건너뜀). */
export function readRecords(filter: RecordFilter = {}): Record<string, unknown>[] {
  const dir = recordsDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const f of files.sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        records.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // 깨진 줄은 건너뛴다.
      }
    }
  }
  const filtered = records.filter((r) => {
    if (filter.type && r.type !== filter.type) {
      return false;
    }
    if (filter.workitem && r.workitem !== filter.workitem) {
      return false;
    }
    return true;
  });
  // 최근이 위로.
  filtered.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return filtered;
}

/** 한 줄 요약(what/scope/question 등 대표 필드). 줄글을 쏟지 않는다. */
function summaryOf(r: Record<string, unknown>): string {
  const cand = r.what ?? r.scope ?? r.question ?? r.target ?? r.decision ?? '(요약 없음)';
  return String(cand);
}

/** 사람이 읽는 목록. what 만 보여주고 상세는 요청 시 펼친다. */
export function renderRecords(records: Record<string, unknown>[], c: Caps): string {
  const color = makeColors(c.color);
  if (records.length === 0) {
    return '\n  기록이 없습니다.\n';
  }
  const out: string[] = ['', `  기록 ${records.length}개 (최근순)`, ''];
  for (const r of records) {
    const type = String(r.type).padEnd(9, ' ');
    const wi = r.workitem ? `${String(r.workitem)} ` : '';
    const date = String(r.at).slice(0, 10);
    out.push(`  ${color.dim(date)}  ${color.bold(type)} ${color.dim(wi)}${summaryOf(r)}`);
  }
  out.push('');
  out.push(`  ${color.dim('상세는 awl records --json 또는 ~/.awl/records/ 를 보세요.')}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 명령 진입점
// ---------------------------------------------------------------------------

export interface RecordCliOpts {
  json?: string;
  file?: string;
  diff?: boolean;
}

/** awl record <type> — 스킬이 치는 명령. */
export async function runRecord(type: string, opts: RecordCliOpts): Promise<void> {
  if (!RECORD_TYPES.includes(type as RecordType)) {
    process.stderr.write(`\n  알 수 없는 기록 타입: ${type}\n  가능: ${RECORD_TYPES.join(', ')}\n`);
    process.exit(1);
  }

  let data: Record<string, unknown> = {};
  try {
    if (opts.file) {
      data = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
    } else if (opts.json) {
      data = JSON.parse(opts.json);
    }
  } catch (e) {
    process.stderr.write(`\n  데이터 JSON 을 읽지 못했습니다: ${String(e)}\n`);
    process.exit(1);
  }
  if (typeof data !== 'object' || data === null) {
    process.stderr.write('\n  데이터는 JSON 객체여야 합니다.\n');
    process.exit(1);
  }

  const projectRoot = resolveProjectRoot();
  let projectFromConfig: string | undefined;
  if (projectRoot) {
    const cfg = loadProjectName(projectRoot);
    projectFromConfig = cfg;
  }

  const id = newRecordId();
  const at = new Date().toISOString();

  // blocked --diff: git diff 를 캡처해 첨부한다.
  if (opts.diff && type === 'blocked' && projectRoot && data.diff === undefined) {
    const rel = await captureDiff(id, at, projectRoot);
    if (rel) {
      data.diff = rel;
    }
  }

  // blocked 에만 baseline SHA 를 붙인다(막힌 코드를 버리므로 출발점 복원에 필요).
  // 나머지 타입에는 넣지 않는다 — 안 쓰는 필드를 만들지 않는다(WI-7 D-21).
  if (type === 'blocked' && projectRoot && data.baseline === undefined) {
    const state = loadState(projectRoot);
    const focus =
      (typeof data.criterion === 'string' && data.criterion) ||
      (typeof state.currentFocus === 'string' ? state.currentFocus : undefined);
    if (focus) {
      const crit = getCriterion(state, focus);
      if (crit && typeof crit.baseline === 'string') {
        data.baseline = crit.baseline;
      }
    }
  }

  const { record, missing } = buildRecord(type as RecordType, data, {
    project: projectFromConfig,
    id,
    at,
  });
  if (!record) {
    process.stderr.write(`\n  기록을 거부했습니다. 빠진 필수 필드: ${missing.join(', ')}\n`);
    process.stderr.write(
      `  ${type} 에 필요한 필드: ${SCHEMAS[type as RecordType].required.join(', ')}\n`,
    );
    process.exit(1);
  }

  const file = appendRecord(record);
  process.stdout.write(`${JSON.stringify({ id, at, file })}\n`);
}

/** config.json 에서 project 이름만 가볍게 읽는다(스키마 검증은 requireConfig 몫). */
function loadProjectName(projectRoot: string): string | undefined {
  try {
    const p = path.join(projectRoot, '.awl', 'config.json');
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    return typeof j.project === 'string' ? j.project : undefined;
  } catch {
    return undefined;
  }
}

/** awl records — 사람이 읽는 조회. */
export function runRecords(opts: { type?: string; workitem?: string; json?: boolean }): void {
  const records = readRecords({ type: opts.type, workitem: opts.workitem });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderRecords(records, caps())}\n`);
}
