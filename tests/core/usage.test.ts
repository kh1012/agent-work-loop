import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type CostSnapshot, computeCostDelta, readCostSnapshot } from '../../src/core/usage.js';

describe('computeCostDelta (loop-completion-stats AC-03)', () => {
  it('두 스냅샷의 cost 차이($)를 소수 2자리로 낸다', () => {
    const start: CostSnapshot = { cost: 100.5, ts: 1 };
    const end: CostSnapshot = { cost: 102.9, ts: 2 };
    expect(computeCostDelta(start, end)).toBe(2.4);
  });

  it('시작 스냅샷이 없으면 undefined (부재 graceful)', () => {
    expect(computeCostDelta(undefined, { cost: 10 })).toBeUndefined();
  });

  it('끝 스냅샷이 없으면 undefined', () => {
    expect(computeCostDelta({ cost: 10 }, undefined)).toBeUndefined();
  });

  it('어느 쪽이든 cost 필드가 없으면 undefined (발명 금지 — 없는 값으로 지표를 만들지 않는다)', () => {
    expect(computeCostDelta({ ts: 1 }, { cost: 10 })).toBeUndefined();
    expect(computeCostDelta({ cost: 10 }, { ts: 2 })).toBeUndefined();
  });

  it('cost 가 줄었으면(누적 카운터 역전) undefined — 신뢰 못 하는 값을 만들지 않는다', () => {
    expect(computeCostDelta({ cost: 100 }, { cost: 90 })).toBeUndefined();
  });
});

describe('readCostSnapshot (loop-completion-stats AC-03)', () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp) {
      fs.rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it('실제 cc-usage.json 형식을 파싱한다', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-usage-'));
    const f = path.join(tmp, 'cc-usage.json');
    fs.writeFileSync(
      f,
      JSON.stringify({ ts: 1784350682, five_h_pct: 35, seven_d_pct: 91, cost: 110.55 }),
    );
    expect(readCostSnapshot(f)).toEqual({
      ts: 1784350682,
      five_h_pct: 35,
      seven_d_pct: 91,
      cost: 110.55,
    });
  });

  it('파일이 없으면 undefined (크래시 금지)', () => {
    const missing = path.join(os.tmpdir(), 'awl-usage-does-not-exist-9f8e7d.json');
    expect(readCostSnapshot(missing)).toBeUndefined();
  });

  it('깨진 JSON 이면 undefined', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-usage-'));
    const f = path.join(tmp, 'bad.json');
    fs.writeFileSync(f, '{not json');
    expect(readCostSnapshot(f)).toBeUndefined();
  });

  it('숫자 아닌 필드는 버린다 (오염 방어)', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-usage-'));
    const f = path.join(tmp, 'cc-usage.json');
    fs.writeFileSync(f, JSON.stringify({ cost: '110.55', ts: 1784350682 }));
    expect(readCostSnapshot(f)).toEqual({ ts: 1784350682 });
  });
});
