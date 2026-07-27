import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/core/uuid.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('표준 8-4-4-4-12 형식을 따른다', () => {
    expect(uuidv7()).toMatch(UUID_RE);
  });

  it('버전 니블이 항상 7이다', () => {
    for (let i = 0; i < 20; i++) {
      const id = uuidv7();
      expect(id[14]).toBe('7');
    }
  });

  it('variant 상위 2비트가 항상 10이다 (17번째 문자가 8/9/a/b)', () => {
    for (let i = 0; i < 20; i++) {
      const id = uuidv7();
      expect(['8', '9', 'a', 'b']).toContain(id[19]);
    }
  });

  it('같은 now 값을 넣으면 상위 48비트(타임스탬프)가 동일하다', () => {
    const now = 1_800_000_000_000;
    const a = uuidv7(now);
    const b = uuidv7(now);
    expect(a.slice(0, 13)).toBe(b.slice(0, 13));
  });

  it('now 값이 증가하면 타임스탬프 구간도 단조 비감소한다', () => {
    const a = uuidv7(1_000_000_000_000);
    const b = uuidv7(2_000_000_000_000);
    expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
  });

  it('같은 밀리초 안에서도 랜덤 비트로 값이 달라진다', () => {
    const now = 1_800_000_000_000;
    const ids = new Set(Array.from({ length: 10 }, () => uuidv7(now)));
    expect(ids.size).toBe(10);
  });
});
