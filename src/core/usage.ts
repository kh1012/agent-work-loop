import fs from 'node:fs';

/**
 * statusline 이 /tmp/cc-usage.json 에 남기는 실측 사용량 스냅샷(loop-completion-stats F-03).
 * raw 토큰은 없다 — 창 사용률(%)과 누적 비용($)만 있다. 필드는 전부 선택이다(부분적일
 * 수 있다). awl 은 이 파일을 쓰지 않는다 — 읽기만 한다.
 */
export interface CostSnapshot {
  /** 누적 비용($). */
  cost?: number;
  five_h_pct?: number;
  seven_d_pct?: number;
  /** 스냅샷 epoch(초). */
  ts?: number;
}

/** statusline 이 남기는 실측 사용량 스냅샷의 표준 경로. */
export const DEFAULT_USAGE_PATH = '/tmp/cc-usage.json';

/**
 * cc-usage.json 을 읽어 CostSnapshot 으로 파싱한다. 파일이 없거나(statusline 미설치)
 * JSON 이 깨졌으면 undefined — 크래시하지 않는다(AC-03 부재 graceful). 숫자 아닌
 * 필드는 버린다(수기편집/오염 방어).
 */
export function readCostSnapshot(file: string = DEFAULT_USAGE_PATH): CostSnapshot | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const snap: CostSnapshot = {};
  const cost = num(raw.cost);
  if (cost !== undefined) {
    snap.cost = cost;
  }
  const fiveH = num(raw.five_h_pct);
  if (fiveH !== undefined) {
    snap.five_h_pct = fiveH;
  }
  const sevenD = num(raw.seven_d_pct);
  if (sevenD !== undefined) {
    snap.seven_d_pct = sevenD;
  }
  const ts = num(raw.ts);
  if (ts !== undefined) {
    snap.ts = ts;
  }
  return snap;
}

/**
 * 루프 경계 두 스냅샷의 cost 차이($, 소수 2자리)를 낸다(순수, AC-03). 어느 쪽이든
 * 없거나 cost 필드가 없으면 undefined(발명 금지 — 없는 값으로 지표를 만들지 않는다).
 * end<start(누적 카운터 역전)면 신뢰 못 하는 값이라 undefined — computeDurationMs 의
 * 음수 처리와 같은 원칙.
 */
export function computeCostDelta(
  start: CostSnapshot | undefined,
  end: CostSnapshot | undefined,
): number | undefined {
  if (!start || !end || typeof start.cost !== 'number' || typeof end.cost !== 'number') {
    return undefined;
  }
  const d = end.cost - start.cost;
  if (d < 0) {
    return undefined;
  }
  return Math.round(d * 100) / 100;
}
