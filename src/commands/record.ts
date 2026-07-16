import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { recordsDir } from '../core/paths.js';
import { run } from '../core/runner.js';
import { type Caps, caps, card, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';
import { getCriterion, loadState, writeState } from './state.js';

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
  | 'clarify'
  | 'awl-feedback';

/**
 * narrative.kind 로 허용되는 값 (WI-P AC-02).
 * tool-failed(WI-W): awl 자신의 도구가 오작동해(예: 자체 검증 통과를 보고하고도
 * 무관한 파일을 흡수) 실사고를 낸 순간 — 완료 조건/리뷰/스파이크가 아니라
 * 도구 자체의 결함이 원인일 때만 쓴다.
 */
export const NARRATIVE_KINDS = [
  'gate-caught',
  'reviewer-caught',
  'spike-prevented',
  'blocked-discarded',
  'tool-failed',
] as const;

/** gate:1 의 decision 으로 허용되는 값 (WI-Q AC-01). */
export const GATE1_DECISIONS = ['approved', 'modified', 'rejected', 'split'] as const;
/** gate:2 의 decision 으로 허용되는 값 (WI-Q AC-01). */
export const GATE2_DECISIONS = ['approved', 'more-work', 'abandoned'] as const;

/**
 * awl-feedback.area 로 허용되는 값 (0.6.x). awl 도구의 어느 기능이 아팠나 —
 * 이게 모으기(awl feedback)의 묶는 키가 된다. gotcha 와 달리 작업 대상 코드가
 * 아니라 awl 도구 자체에 대한 피드백이다.
 */
export const AWL_FEEDBACK_AREAS = [
  'commit',
  'review',
  'gate',
  'verify',
  'state',
  'init',
  'cli',
  '기타',
] as const;
/** awl-feedback.severity 로 허용되는 값 (0.6.x). */
export const AWL_FEEDBACK_SEVERITIES = ['high', 'medium', 'low'] as const;

interface Schema {
  required: string[];
  /** 비어있지 않은 배열이어야 하는 필드 */
  arrays?: string[];
  /** 배열이어야 하지만 비어있어도 되는 필드 (지적/부정행위 없음도 정당한 결과인 경우) */
  arraysAllowEmpty?: string[];
}

/**
 * 타입별 필수 구조. 자유 텍스트 필드 하나로 퉁치지 않는다.
 * (audit/spike/criteria/review/decision 의 구조는 가정 — docs/decisions.md D-15)
 */
export const SCHEMAS: Record<RecordType, Schema> = {
  audit: { required: ['scope', 'findings'], arrays: ['findings'] },
  spike: { required: ['question', 'found'] },
  criteria: { required: ['items'], arrays: ['items'] },
  // WI-U: why/how/alternatives 는 diff 크기(diffTier)에 따라 조건부로 요구된다
  // (buildRecord 의 attempt 전용 분기가 처리). what/result 만 무조건 필수.
  // result:'verified' 는 코드 변경 없이 확인만 한 가드/검증형 완료조건 — 직전 커밋을
  // 재지 않고 why/how 를 면제한다(what 만으로 통과, 피드백 F-3).
  attempt: { required: ['what', 'result'] },
  blocked: { required: ['what', 'why', 'tried', 'lesson'], arrays: ['tried'] },
  // WI-S: target/verdict(이분법) 를 reviewId/criteria/findings/cheatingDetected/
  // verifyPassedBefore 로 전면 교체 — target≈criteria, verdict≈findings.length 로
  // 정보 손실 없이 표현되므로 예전 필드는 없앤다(과거 기록은 append-only 로 그대로
  // 유효하게 남는다, D-33 원칙). criteria 만 비어있지 않은 배열을 강제한다 —
  // findings/cheatingDetected 는 존재는 필수지만 빈 배열(지적/부정행위 없음)도
  // 정당한 결과라 비어있어도 통과한다.
  review: {
    required: ['reviewId', 'criteria', 'findings', 'cheatingDetected', 'verifyPassedBefore'],
    arrays: ['criteria'],
    arraysAllowEmpty: ['findings', 'cheatingDetected'],
  },
  decision: { required: ['question', 'decision', 'rationale'] },
  'gotcha-applied': { required: ['gotchaId', 'what'] },
  'gotcha-missed': { required: ['gotchaId', 'what', 'why'] },
  narrative: { required: ['kind', 'counterfactual'] },
  gate: { required: ['gate', 'decision', 'presentedCriteria'], arrays: ['presentedCriteria'] },
  clarify: { required: ['questions'], arrays: ['questions'] },
  // awl-feedback(0.6.x): awl 도구 자체가 아팠던 점. gotcha(작업 코드 교훈)와 다른
  // 종류다 — records/ 에 쌓이고 gotcha 로 승격되지 않는다. area 가 모으기의 키.
  // suggestion 은 선택(개선 아이디어, 강제 아님 — 번역은 사람 몫).
  'awl-feedback': { required: ['area', 'what', 'impact', 'severity'] },
};

export const RECORD_TYPES = Object.keys(SCHEMAS) as RecordType[];

/**
 * 완료 조건에 남으면 재해석 여지가 생기는 질적 표현 (WI-T). "저위험 건 수정" 같은
 * 표현은 구현 도중 "무엇을 저위험으로 볼지"가 순수한 판단이 되어 재분류가
 * 일어난다 — awl verify 가 그 판단 자체를 검증하지 못한다. 열거 가능하거나
 * 수치화 가능한 표현으로 다시 쓰게 한다.
 */
export const BANNED_QUALITATIVE_WORDS = [
  '저위험',
  '주요한',
  '적절한',
  '가능한 만큼',
  '필요시',
] as const;

function isHangulSyllable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0xac00 && code <= 0xd7a3;
}

/**
 * text 안에 word 가 "독립된" 형태로 있는지 본다(WI-T AC-07, 리뷰 지적) — 단순
 * 부분 문자열 매칭은 "부적절한"⊃"적절한", "필요시간"⊃"필요시" 처럼 더 큰 한글
 * 단어에 낀 경우까지 오탐한다. 매칭 앞/뒤 글자가 한글 음절이면 더 큰 단어의
 * 일부로 보고 건너뛰고, 앞/뒤가 한글이 아니면(공백·문장부호·문자열 시작/끝)
 * 독립된 표현으로 보고 거부 대상으로 삼는다.
 */
function includesBannedWord(text: string, word: string): boolean {
  let idx = text.indexOf(word);
  while (idx !== -1) {
    const before = idx > 0 ? text[idx - 1] : undefined;
    const after = idx + word.length < text.length ? text[idx + word.length] : undefined;
    const attachedToHangul =
      (before !== undefined && isHangulSyllable(before)) ||
      (after !== undefined && isHangulSyllable(after));
    if (!attachedToHangul) {
      return true;
    }
    idx = text.indexOf(word, idx + 1);
  }
  return false;
}

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
 *
 * 인식하는 선택 필드(records-verify-tag) — 스키마에 넣지 않아도 spread 로 그대로 보존된다
 * (D-15: 항목 내부 구조를 강제하지 않는다). `awl record attempt` 등에 붙일 수 있다:
 *   - `manualVerify: boolean` — 기계검증(awl verify)으로 못 잡고 사람이 눈으로/브라우저로
 *     직접 재확인해야 하는 항목인가.
 *   - `verifyHow: string` — 그 방법(딥링크·화면·절차). manualVerify 가 true 일 때 의미 있다.
 * 둘 다 선택이라 없으면 무시된다(하위호환). **awl brief(별도 일감)는 이 필드를 "직접 볼
 * 검증 항목(verifyItems)"의 1차 소스로 읽고, 없을 때만 UI 파일 휴리스틱으로 폴백한다** —
 * brief 가 휴리스틱에만 의존하지 않게 하는 계약. 완료조건(criteria)도 같은 필드를 담을 수
 * 있다(setCriterion 얕은 병합이 보존 — state.ts).
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
    } else if (schema.arraysAllowEmpty?.includes(field) && !Array.isArray(v)) {
      missing.push(`${field} (배열이어야 함)`);
    }
  }

  // 질적 표현 금지 (WI-T AC-01): criteria 의 각 항목을 통째로 문자열화해 금지어를
  // 찾는다. 특정 필드 이름(조건/범위)에 의존하지 않는다 — 이 코드베이스는 항목
  // 내부 구조를 강제하지 않으므로(D-15), 어느 필드에 질적 표현이 남아도 잡는다.
  if (type === 'criteria' && Array.isArray(data.items)) {
    for (const item of data.items as Record<string, unknown>[]) {
      const text = JSON.stringify(item);
      for (const word of BANNED_QUALITATIVE_WORDS) {
        if (includesBannedWord(text, word)) {
          missing.push(
            `items(${String(item?.id ?? '?')}) 에 금지된 질적 표현 "${word}" — 열거 가능하거나 수치화 가능하게 다시 쓰세요`,
          );
        }
      }
    }
  }

  // 기록 상세도를 diff 크기에 맞춘다 (WI-U): why/how 는 result:failed 이거나
  // diffTier 가 minimal 이 아니면(brief/detailed/미측정) 필수다 — 실패한 시도는
  // gotcha 추출의 재료라 diff 크기와 무관하게 항상 전체 상세를 요구한다(정보
  // 손실 방지). diffTier 가 없는 경우(git 측정 실패 등)도 안전하게 전체 상세를
  // 요구한다. alternatives 는 diffTier 가 detailed 일 때만 필수다.
  if (type === 'attempt') {
    const tier = typeof data.diffTier === 'string' ? data.diffTier : undefined;
    const isFailed = data.result === 'failed';
    // result:'verified' — 코드 변경이 없는 가드/검증형 완료조건. 잴 diff 가 없으니
    // 직전 커밋 크기에 발목잡히지 않고 what 만으로 통과시킨다(피드백 F-3).
    const isVerified = data.result === 'verified';
    const requiresFullDetail = isFailed || (!isVerified && tier !== 'minimal');
    if (requiresFullDetail) {
      for (const field of ['why', 'how']) {
        const v = data[field];
        if (v === undefined || v === null || v === '') {
          missing.push(field);
        }
      }
    }
    if (tier === 'detailed') {
      const alt = data.alternatives;
      if (!Array.isArray(alt) || alt.length === 0) {
        missing.push(
          'alternatives (비어있지 않은 배열이어야 함 — diff 가 크면 설계 대안을 남겨야 합니다)',
        );
      }
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

  // awl-feedback.area/severity 는 정해진 값 중 하나여야 한다(narrative.kind 와 같은
  // 특수 분기, D-35). 값이 아예 없는 경우는 위 required 루프가 이미 missing 처리한다.
  if (type === 'awl-feedback') {
    const areaMissing = data.area === undefined || data.area === null || data.area === '';
    if (!areaMissing && !(AWL_FEEDBACK_AREAS as readonly unknown[]).includes(data.area)) {
      missing.push(`area (다음 중 하나여야 함: ${AWL_FEEDBACK_AREAS.join(', ')})`);
    }
    const sevMissing =
      data.severity === undefined || data.severity === null || data.severity === '';
    if (!sevMissing && !(AWL_FEEDBACK_SEVERITIES as readonly unknown[]).includes(data.severity)) {
      missing.push(`severity (다음 중 하나여야 함: ${AWL_FEEDBACK_SEVERITIES.join(', ')})`);
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

export interface DiffSize {
  files: number;
  lines: number;
}

export type AttemptDetailTier = 'minimal' | 'brief' | 'detailed';

/**
 * diff 크기로 attempt 기록에 필요한 상세도를 정한다(WI-U). 순수 함수.
 * 파일 3개 이상이거나 줄 50개 이상이면 detailed, 파일 1개 이하고 줄 10개
 * 미만이면 minimal, 나머지는 brief.
 */
export function detailTierFor(size: DiffSize): AttemptDetailTier {
  if (size.files >= 3 || size.lines >= 50) {
    return 'detailed';
  }
  if (size.files <= 1 && size.lines < 10) {
    return 'minimal';
  }
  return 'brief';
}

/**
 * git 명령을 돌려 numstat 출력(파일당 "추가\t삭제\t파일명")에서 파일 수와
 * 변경 줄 수 합을 잰다(WI-U). 명령이 실패하면(ref 없음 등) null — 호출부가
 * diffTier 를 안 넣고 안전하게 넘어간다.
 */
export async function measureDiffSize(cwd: string, args: string[]): Promise<DiffSize | null> {
  const r = await run({ cmd: 'git', args, cwd, timeoutMs: 10000 });
  if (r.exitCode !== 0) {
    return null;
  }
  const rows = r.stdout.split('\n').filter((l) => l.trim() !== '');
  let lines = 0;
  for (const row of rows) {
    const [add, del] = row.split('\t');
    lines += (Number(add) || 0) + (Number(del) || 0);
  }
  return { files: rows.length, lines };
}

export interface CoverageResult {
  auditFindingIds: string[];
  addressedIds: string[];
  excludedIds: string[];
}

/**
 * audit 기록의 findings 와 완료 조건의 addresses 를 대조해 커버리지를 계산한다
 * (WI-T AC-02/AC-04). 순수 함수(테스트 가능). id 가 없거나 문자열이 아닌 finding/
 * addresses 항목은 조용히 건너뛴다 — 이 코드베이스는 중첩 배열 항목의 내부 구조를
 * 강제하지 않으므로(D-15), 이 관례 이전에 쓰인 audit 기록도 죽지 않고 읽힌다.
 *
 * criteriaRecords(선택, awl record criteria 의 append-only 이력)는 state.criteria
 * 에 addresses 가 없는 완료조건만 보완한다(WI-T AC-06, 리뷰 지적 high) — 스킬이
 * `awl state set` 을 예시 그대로(addresses 없이) 쳐도 방금 `awl record criteria`
 * 로 남긴 addresses 가 배제 판정에서 빠지지 않는다. state.criteria 에 addresses
 * 가 이미 있으면(빈 배열이라도) 그게 최신이므로 우선한다.
 */
export function computeCoverage(
  auditRecords: Record<string, unknown>[],
  criteria: Record<string, unknown>[],
  criteriaRecords: Record<string, unknown>[] = [],
): CoverageResult {
  const findingIds = new Set<string>();
  for (const r of auditRecords) {
    const findings = Array.isArray(r.findings) ? r.findings : [];
    for (const f of findings) {
      if (f && typeof f === 'object' && typeof (f as Record<string, unknown>).id === 'string') {
        findingIds.add((f as Record<string, unknown>).id as string);
      }
    }
  }

  const addressedRefs = new Set<string>();
  const stateHasAddresses = new Set<string>();
  for (const c of criteria) {
    if (Array.isArray(c.addresses)) {
      stateHasAddresses.add(String(c.id));
      for (const a of c.addresses) {
        if (typeof a === 'string') {
          addressedRefs.add(a);
        }
      }
    }
  }
  for (const rec of criteriaRecords) {
    const items = Array.isArray(rec.items) ? rec.items : [];
    for (const item of items) {
      const id =
        item && typeof item === 'object' ? (item as Record<string, unknown>).id : undefined;
      if (typeof id !== 'string' || stateHasAddresses.has(id)) {
        continue;
      }
      const addresses = (item as Record<string, unknown>).addresses;
      if (Array.isArray(addresses)) {
        for (const a of addresses) {
          if (typeof a === 'string') {
            addressedRefs.add(a);
          }
        }
      }
    }
  }

  const auditFindingIds = [...findingIds];
  const addressedIds = auditFindingIds.filter((id) => addressedRefs.has(id));
  const excludedIds = auditFindingIds.filter((id) => !addressedRefs.has(id));
  return { auditFindingIds, addressedIds, excludedIds };
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
  /** 읽을 월 파일(YYYY-MM). 지정하면 이 월만 읽는다(하위호환: 없으면 전량). */
  months?: string[];
  /** 기간 시작(YYYY-MM, 포함). from/to 는 months 가 없을 때만 쓰인다. */
  from?: string;
  /** 기간 끝(YYYY-MM, 포함). */
  to?: string;
}

/**
 * 월 파일명 배열에서 filter 의 기간에 드는 것만 고른다(순수, I/O 없음).
 *
 * 쓰기는 monthFile 이 YYYY-MM.jsonl 로 분할하는데 읽기가 전 파일을 순회하던 걸 끊는다.
 * months(명시 목록)가 우선, 없으면 from/to(YYYY-MM 문자열 비교로 포함 범위), 둘 다 없으면
 * 전량(.jsonl 만) — 기존 호출부는 그대로 전량을 받는다(하위호환).
 *
 * months 가 배열이면 길이와 무관하게 "월로 거른다"는 뜻이다 — 빈 배열([])은 전량 폴백이
 * 아니라 매치 0개(명시적 빈 필터)다. "월로 안 거른다(전량)"는 months 를 아예 주지 않는 것
 * (undefined)으로 표현한다. 월목록을 계산해 넘기는 호출부가 빈 결과를 기대하다 전량 로드로
 * 역행하는 함정을 막는다(리뷰 지적, AC-04).
 */
export function selectMonthFiles(files: string[], filter: RecordFilter = {}): string[] {
  const jsonl = files.filter((f) => f.endsWith('.jsonl'));
  const monthOf = (f: string): string => f.slice(0, 7); // 'YYYY-MM.jsonl' → 'YYYY-MM'
  if (Array.isArray(filter.months)) {
    const set = new Set(filter.months);
    return jsonl.filter((f) => set.has(monthOf(f)));
  }
  if (filter.from !== undefined || filter.to !== undefined) {
    const from = filter.from ?? '0000-00';
    const to = filter.to ?? '9999-99';
    return jsonl.filter((f) => {
      const m = monthOf(f);
      return m >= from && m <= to;
    });
  }
  return jsonl;
}

/**
 * 월별 JSONL 을 읽어 레코드 배열을 돌려준다(파싱 실패 줄은 건너뜀).
 * filter 에 months/from/to 가 있으면 그 월 파일만 읽는다(selectMonthFiles) — 전량 로드 회피.
 */
export function readRecords(filter: RecordFilter = {}): Record<string, unknown>[] {
  const dir = recordsDir();
  let files: string[];
  try {
    files = selectMonthFiles(fs.readdirSync(dir), filter);
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

/**
 * 이 워크아이템에 "승인된" 게이트1 레코드가 있는가 (0.6.3, 적대검증 발견 수정).
 *
 * 게이트 통과 판정을 가변 phase 문자열이 아니라 append-only gate 레코드로 한다.
 * phase 는 스킬이 `awl state set` 으로 바꿀 수 있어(hidden 명령), 사람이 REJECT 한
 * 계획이나 임의 조작한 phase 로 루프 진입/게이트 전 커밋을 우회할 수 있었다.
 * decision==='approved' 만 인정한다 — `record gate` 의 loop 자동전이 조건과 일관.
 * workitem 이 falsy 면 확인할 게이트 레코드가 없다는 뜻이므로 fail-closed(false).
 */
export function hasApprovedGate1(workitem: string | undefined): boolean {
  if (typeof workitem !== 'string' || workitem === '') {
    return false;
  }
  return readRecords({ type: 'gate', workitem }).some(
    (r) => r.gate === 1 && r.decision === 'approved',
  );
}

/**
 * 한 줄 요약(what/scope/question 등 대표 필드). 줄글을 쏟지 않는다.
 *
 * review 타입은 WI-S 부터 target/verdict 대신 reviewId/findings 를 쓴다(리뷰 지적,
 * WI-S AC-06) — 마이그레이션 이전 기록(target 만 있는)은 reviewId 가 없으므로
 * 아래 fallback 체인이 그대로 target 을 집어 하위호환을 지킨다.
 */
function summaryOf(r: Record<string, unknown>): string {
  if (r.type === 'review' && typeof r.reviewId === 'string') {
    const findings = Array.isArray(r.findings) ? r.findings.length : 0;
    const cheating = Array.isArray(r.cheatingDetected) ? r.cheatingDetected.length : 0;
    const cheatingNote = cheating > 0 ? `, 부정행위 ${cheating}건` : '';
    return `${r.reviewId} — findings ${findings}건${cheatingNote}`;
  }
  const cand = r.what ?? r.scope ?? r.question ?? r.target ?? r.decision ?? '(요약 없음)';
  return String(cand);
}

/** 사람이 읽는 목록. what 만 보여주고 상세는 요청 시 펼친다. */
export function renderRecords(records: Record<string, unknown>[], c: Caps): string {
  const color = makeColors(c.color);
  if (records.length === 0) {
    return card('기록', ['기록이 없습니다.'], c);
  }
  const out: string[] = [];
  for (const r of records) {
    const type = String(r.type).padEnd(9, ' ');
    const wi = r.workitem ? `${String(r.workitem)} ` : '';
    const date = String(r.at).slice(0, 10);
    out.push(`${color.dim(date)}  ${color.bold(type)} ${color.dim(wi)}${summaryOf(r)}`);
  }
  out.push('');
  out.push(color.dim('상세는 awl records --json 또는 ~/.awl/records/ 를 보세요.'));
  return card(`기록 ${records.length}개 · 최근순`, out, c);
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
    // 리뷰 지적(WI-R): projectRoot 자체를 못 찾은 경우(state.json 을 아예 못 읽음)엔
    // "활성 워크아이템이 없다"는 말이 진짜 원인(프로젝트 미초기화)을 안 알려준다.
    const hint = projectRoot
      ? ''
      : ' (프로젝트 루트를 찾지 못했습니다 — awl init 을 실행했는지 확인하세요.)';
    process.stderr.write(
      `\n  활성 워크아이템이 없습니다.${hint} awl work new <id> [설명] 으로 시작하세요.\n  (이 기록 하나만 다른 워크아이템으로 남기려면 --workitem <id> 를 쓰세요)\n`,
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

  // attempt 의 diffTier 를 diff 크기로 잰다 (WI-U). result:passed 는 awl commit
  // 이 방금 만든 커밋(스킬 흐름상 이 직전 명령)을, result:failed 는 아직
  // 커밋 안 된 작업트리를 잰다 — state.currentFocus 같은 별도 상태에 기대지
  // 않는다(그 필드는 스킬이 채우도록 지시된 적이 없어 실사용에서 항상 비어
  // 있다). 측정에 실패하면(커밋 이력 없음 등) diffTier 를 안 넣는다 —
  // buildRecord 가 diffTier 없이도 안전하게(전체 상세 요구) 처리한다.
  // result:'verified'(무변경 가드/검증형)는 잴 변경이 없으므로 직전 커밋을 재지 않는다(F-3).
  if (
    type === 'attempt' &&
    projectRoot &&
    data.diffTier === undefined &&
    data.result !== 'verified'
  ) {
    const diffArgs =
      data.result === 'failed'
        ? ['diff', '--numstat', 'HEAD']
        : ['show', '--numstat', '--format=', 'HEAD'];
    const size = await measureDiffSize(projectRoot, diffArgs);
    if (size) {
      const tier = detailTierFor(size);
      data.diffTier = tier;
      const guidance =
        tier === 'minimal'
          ? 'what 만 있으면 됩니다.'
          : tier === 'detailed'
            ? 'what/why/how 와 alternatives(설계 대안)를 채우세요.'
            : 'what/why/how 를 채우세요.';
      process.stderr.write(`\n  이 변경은 ${size.lines}줄/${size.files}파일입니다. ${guidance}\n`);
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

  // 게이트 1 배제 목록 강제 (WI-T AC-02, 핵심) — audit findings 중 어떤 완료
  // 조건의 addresses 도 안 가리키는 게 있는데 presentedExclusions 로 명시 제시하지
  // 않으면 거부한다(파일에 안 쓴다). "배제는 판단이다. 판단은 게이트를 거쳐야
  // 한다"는 스펙 원문 그대로 — 사후 경고로는 이 구멍을 못 막는다. G-020 과 같은
  // fail-open 을 피하려고 workitem 이 string 일 때만 계산한다.
  if (type === 'gate' && data.gate === 1) {
    const workitemForCheck = typeof record.workitem === 'string' ? record.workitem : undefined;
    if (workitemForCheck) {
      const criteria = Array.isArray(state.criteria)
        ? (state.criteria as Record<string, unknown>[])
        : [];
      const auditRecords = readRecords({ type: 'audit', workitem: workitemForCheck });
      const criteriaRecords = readRecords({ type: 'criteria', workitem: workitemForCheck });
      const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
      if (coverage.excludedIds.length > 0) {
        const presented = Array.isArray(data.presentedExclusions) ? data.presentedExclusions : [];
        const presentedIds = new Set(
          presented
            .map((p) => (typeof p === 'string' ? p : (p as Record<string, unknown>)?.id))
            .filter((id): id is string => typeof id === 'string'),
        );
        const uncovered = coverage.excludedIds.filter((id) => !presentedIds.has(id));
        if (uncovered.length > 0) {
          process.stderr.write(
            `\n  게이트 1 기록을 거부했습니다. 다음 발견이 완료 조건의 addresses 에도, presentedExclusions 에도 없습니다: ${uncovered.join(', ')}\n  완료 조건에 addresses 로 연결하거나, presentedExclusions 에 담아 사람에게 제시하세요.\n`,
          );
          process.exit(1);
        }
      }
    }
  }

  const file = appendRecord(record);

  // 승인 기록 자체가 Gate 1 대기 상태를 해제한다. state set을 별도로 허용하면
  // 계획 승인 없이 phase만 바꾸는 우회 경로가 생기므로 여기서만 전이한다.
  if (projectRoot && type === 'gate' && data.gate === 1 && data.decision === 'approved') {
    writeState(projectRoot, { ...state, phase: 'loop', loop: 'loop' });
  }

  // gate:2 리뷰 누락 경고 (WI-S AC-03) — 거부하지 않는다, 안내만 한다.
  if (type === 'gate' && data.gate === 2) {
    const passedCount = Array.isArray(state.criteria)
      ? (state.criteria as Record<string, unknown>[]).filter((c) => c.status === 'passed').length
      : 0;
    // record.workitem 이 없으면(이론상 WI-R 강제로 항상 있어야 하지만) 판단을
    // 보류한다 — readRecords 에 workitem: undefined 를 넘기면 필터가 아예
    // 안 걸려 다른 워크아이템의 review 로도 "있음" 판정될 수 있다(G-020, 같은
    // 실수를 WI-Q 에서 이미 한 번 했다). 판단 불가능하면 경고도 안 준다(소프트
    // 체크라 거부는 원래 안 하므로, 잘못된 안심을 주는 것보다 조용한 게 낫다).
    const workitemForCheck = typeof record.workitem === 'string' ? record.workitem : undefined;
    if (passedCount >= 3 && workitemForCheck) {
      const hasReview = readRecords({ type: 'review', workitem: workitemForCheck }).length > 0;
      if (!hasReview) {
        process.stderr.write(
          `\n  완료 조건 ${passedCount}개가 통과했으나 리뷰 기록이 없습니다.\n  리뷰를 건너뛰었습니까?\n`,
        );
      }
    }

    // "너무 쉬웠나" 안내 (WI-T AC-03) — 강제가 아니라 질문이다. 완료 조건이
    // 하나 이상이고 전부 status:passed && attempts:0(1차 통과)이면(막힘이
    // 하나라도 있으면 그 항목은 passed 가 아니므로 이 조건 자체가 자연히 걸러진다)
    // 커버리지 수치와 함께 물어본다. 거부하지 않는다.
    const criteria = Array.isArray(state.criteria)
      ? (state.criteria as Record<string, unknown>[])
      : [];
    const allPassedFirstTry =
      criteria.length > 0 &&
      criteria.every((c) => c.status === 'passed' && (Number(c.attempts) || 0) === 0);
    if (allPassedFirstTry) {
      const auditRecords = workitemForCheck
        ? readRecords({ type: 'audit', workitem: workitemForCheck })
        : [];
      const criteriaRecords = workitemForCheck
        ? readRecords({ type: 'criteria', workitem: workitemForCheck })
        : [];
      const coverage = computeCoverage(auditRecords, criteria, criteriaRecords);
      process.stderr.write(
        `\n  완료 조건 ${criteria.length}개 전부 1차 통과. 막힘 0건.\n  조사에서 발견한 ${coverage.auditFindingIds.length}건 중 ${coverage.addressedIds.length}건을 다뤘습니다.\n  완료 조건이 충분히 야심찼습니까?\n`,
      );
    }
  }

  process.stdout.write(`${JSON.stringify({ id, at, file })}\n`);
}

/** config.json 에서 project 이름만 가볍게 읽는다(스키마 검증은 requireConfig 몫). */
export function loadProjectName(projectRoot: string): string | undefined {
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
