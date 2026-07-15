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
  | 'decision'
  | 'gotcha-applied'
  | 'gotcha-missed'
  | 'narrative'
  | 'gate'
  | 'clarify';

/** narrative.kind 로 허용되는 값 (WI-P AC-02). */
export const NARRATIVE_KINDS = [
  'gate-caught',
  'reviewer-caught',
  'spike-prevented',
  'blocked-discarded',
] as const;

/** gate:1 의 decision 으로 허용되는 값 (WI-Q AC-01). */
export const GATE1_DECISIONS = ['approved', 'modified', 'rejected', 'split'] as const;
/** gate:2 의 decision 으로 허용되는 값 (WI-Q AC-01). */
export const GATE2_DECISIONS = ['approved', 'more-work', 'abandoned'] as const;

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
  'gotcha-applied': { required: ['gotchaId', 'what'] },
  'gotcha-missed': { required: ['gotchaId', 'what', 'why'] },
  narrative: { required: ['kind', 'counterfactual'] },
  gate: { required: ['gate', 'decision', 'presentedCriteria'], arrays: ['presentedCriteria'] },
  clarify: { required: ['questions'], arrays: ['questions'] },
};

export const RECORD_TYPES = Object.keys(SCHEMAS) as RecordType[];

export interface RecordDefaults {
  project?: string;
  workitem?: string;
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

  // workitem 은 필수가 아니다(work new 이전 시점의 기록도 있을 수 있다).
  // 데이터에 명시가 없으면 state.json 의 현재 워크아이템을 자동으로 태깅한다
  // — 스킬이 매번 workitem 을 직접 적어 넣어야 했던 부담을 없앤다(evolve 의
  // 워크아이템별 집계가 이 태그에 의존하므로, 빠지면 evolve --collect 가 조용히
  // 기록을 놓친다).
  const workitem =
    (typeof data.workitem === 'string' && data.workitem.trim() !== '' && data.workitem) ||
    defaults.workitem;

  const schema = SCHEMAS[type];
  for (const field of schema.required) {
    const v = data[field];
    if (v === undefined || v === null || v === '') {
      missing.push(field);
    } else if (schema.arrays?.includes(field) && (!Array.isArray(v) || v.length === 0)) {
      missing.push(`${field} (비어있지 않은 배열이어야 함)`);
    }
  }

  // 성능 재검토(WI-I AC-05): performanceSensitive:true 인 decision 은 alternatives
  // (비어있지 않은 배열)를 필수로 요구한다 — 성능 트레이드오프가 걸린 결정은 대안을
  // 최소 하나는 검토했다는 근거를 남긴다. performanceSensitive 가 없거나 false 면
  // 기존과 동일(하위호환).
  if (type === 'decision' && data.performanceSensitive === true) {
    const alt = data.alternatives;
    if (!Array.isArray(alt) || alt.length === 0) {
      missing.push(
        'alternatives (비어있지 않은 배열이어야 함 — performanceSensitive:true 인 결정은 대안을 남겨야 합니다)',
      );
    }
  }

  // narrative.kind 는 정해진 4값 중 하나여야 한다 (WI-P AC-02). 값이 아예 없는
  // 경우는 위 required 루프가 이미 'kind' 로 missing 처리하므로 여기선 건너뛴다.
  // 문자열 타입만 검사하면 숫자 등 다른 타입의 truthy 값이 두 체크를 모두
  // 통과해버리므로(리뷰 지적, WI-P 리뷰), 값이 있으면 타입 불문 enum 에 있는지 본다.
  if (type === 'narrative') {
    const kindMissing = data.kind === undefined || data.kind === null || data.kind === '';
    if (!kindMissing && !(NARRATIVE_KINDS as readonly unknown[]).includes(data.kind)) {
      missing.push(`kind (다음 중 하나여야 함: ${NARRATIVE_KINDS.join(', ')})`);
    }
  }

  // gate.gate 는 1 또는 2여야 하고, decision 은 그 게이트에서만 허용되는 값이어야
  // 한다(WI-Q AC-01) — 게이트 1/2 가 서로 다른 의미의 결정을 갖기 때문이다
  // (예: 게이트 1엔 "split"이 있지만 게이트 2엔 없다). narrative.kind 와 같은
  // 특수 분기 패턴을 재사용한다(D-35).
  if (type === 'gate') {
    const gateMissing = data.gate === undefined || data.gate === null || data.gate === '';
    if (!gateMissing && data.gate !== 1 && data.gate !== 2) {
      missing.push('gate (1 또는 2여야 함)');
    }
    const decisionMissing =
      data.decision === undefined || data.decision === null || data.decision === '';
    if (!decisionMissing && (data.gate === 1 || data.gate === 2)) {
      const allowed = data.gate === 1 ? GATE1_DECISIONS : GATE2_DECISIONS;
      if (!(allowed as readonly unknown[]).includes(data.decision)) {
        missing.push(
          `decision (gate ${data.gate} 에서는 다음 중 하나여야 함: ${allowed.join(', ')})`,
        );
      }
    }
  }

  if (missing.length > 0) {
    return { missing };
  }

  // workitem 은 spread(...data)로 새어 들어올 수 있으니 먼저 떼어내고,
  // 계산된 workitem 이 있을 때만 다시 붙인다(delete 대신 — lint/performance/noDelete).
  const { workitem: _dataWorkitem, ...dataWithoutWorkitem } = data;
  const record: Record<string, unknown> = {
    id: defaults.id,
    at: defaults.at,
    project,
    type,
    ...dataWithoutWorkitem,
  };
  record.project = project;
  record.type = type;
  record.id = defaults.id;
  record.at = defaults.at;
  if (workitem) {
    record.workitem = workitem;
  }
  return { record, missing: [] };
}

/**
 * blocked 기록에 붙일 baseline(커밋 SHA)을 찾는다. 순수 함수(테스트 가능).
 * data.criterion 이 명시되면 그걸 쓰고, 없으면 state.currentFocus 로 추론한다.
 * 그 완료 조건에 baseline 이 없으면(예: commit --start 를 안 한 경우) undefined.
 */
export function resolveBlockedBaseline(
  data: Record<string, unknown>,
  state: Record<string, unknown>,
): string | undefined {
  const focus =
    (typeof data.criterion === 'string' && data.criterion) ||
    (typeof state.currentFocus === 'string' ? state.currentFocus : undefined);
  if (!focus) {
    return undefined;
  }
  const crit = getCriterion(state, focus);
  return crit && typeof crit.baseline === 'string' ? crit.baseline : undefined;
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
  workitem?: string;
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
  let currentWorkitem: string | undefined;
  let state: Record<string, unknown> = {};
  if (projectRoot) {
    projectFromConfig = loadProjectName(projectRoot);
    state = loadState(projectRoot);
    currentWorkitem =
      typeof state.workitem === 'string' && state.workitem.trim() !== ''
        ? state.workitem
        : undefined;
  }

  // 활성 워크아이템 강제 (WI-R AC-01) — 데이터(JSON)에 명시된 workitem, --workitem
  // 플래그, state.json 의 현재 워크아이템 중 무엇도 없으면 거부한다. 우선순위는
  // buildRecord 의 우선순위(데이터 > defaults)와 일치시킨다: 여기서는 defaults 로
  // 넘길 값(cliWorkitem ?? currentWorkitem)만 고르고, data.workitem 우선은
  // buildRecord 안에서 그대로 처리된다.
  const dataWorkitem =
    typeof data.workitem === 'string' && data.workitem.trim() !== '' ? data.workitem : undefined;
  const cliWorkitem =
    typeof opts.workitem === 'string' && opts.workitem.trim() !== '' ? opts.workitem : undefined;
  const defaultWorkitem = cliWorkitem ?? currentWorkitem;
  if (!dataWorkitem && !defaultWorkitem) {
    process.stderr.write(
      '\n  활성 워크아이템이 없습니다. awl work new <id> [설명] 으로 시작하세요.\n' +
        '  (이 기록 하나만 다른 워크아이템으로 남기려면 --workitem <id> 를 쓰세요)\n',
    );
    process.exit(1);
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
    const baseline = resolveBlockedBaseline(data, state);
    if (baseline) {
      data.baseline = baseline;
    }
  }

  const { record, missing } = buildRecord(type as RecordType, data, {
    project: projectFromConfig,
    workitem: defaultWorkitem,
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
