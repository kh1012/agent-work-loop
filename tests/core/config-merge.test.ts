import { describe, expect, it } from 'vitest';
import { mergeByName, mergeSlots } from '../../src/core/config-merge.js';

interface V {
  name: string;
  cmd: string;
  skip?: boolean;
}

describe('mergeByName — name 키 병합(reference.md:1313-1324)', () => {
  it('local 이 없으면 base 를 그대로(복제해) 돌려준다', () => {
    const base: V[] = [{ name: 'typecheck', cmd: 'tsc' }];
    expect(mergeByName(base, undefined)).toEqual(base);
    expect(mergeByName(base, [])).toEqual(base);
  });

  it('e2e 하나만 skip 해도 나머지는 그대로다(배열 통째 교체 아님)', () => {
    const base: V[] = [
      { name: 'typecheck', cmd: 'tsc' },
      { name: 'e2e', cmd: 'playwright test' },
    ];
    const merged = mergeByName(base, [{ name: 'e2e', skip: true }]);
    expect(merged).toEqual([
      { name: 'typecheck', cmd: 'tsc' },
      { name: 'e2e', cmd: 'playwright test', skip: true },
    ]);
  });

  it('local 필드가 base 필드를 덮는다(cmd 교체 — 누구는 pnpm, 누구는 npm)', () => {
    const base: V[] = [{ name: 'test', cmd: 'vitest run' }];
    const merged = mergeByName(base, [{ name: 'test', cmd: 'npx vitest run' }]);
    expect(merged).toEqual([{ name: 'test', cmd: 'npx vitest run' }]);
  });

  it('base 에 없는 이름을 local 이 가리키면 무시한다(로컬이 새 검증을 몰래 추가 못함)', () => {
    const base: V[] = [{ name: 'typecheck', cmd: 'tsc' }];
    const merged = mergeByName(base, [{ name: 'ghost', cmd: 'x' }]);
    expect(merged).toEqual(base);
  });

  it('원본 base 배열/객체를 변형하지 않는다', () => {
    const base: V[] = [{ name: 'e2e', cmd: 'playwright test' }];
    const snapshot = JSON.parse(JSON.stringify(base));
    mergeByName(base, [{ name: 'e2e', skip: true }]);
    expect(base).toEqual(snapshot);
  });
});

describe('mergeSlots — 고정 슬롯 객체 깊은 병합', () => {
  it('local 이 없으면 base 를 그대로 돌려준다', () => {
    const base = { a: 1, b: 2 };
    expect(mergeSlots(base, undefined)).toEqual(base);
  });

  it('local 에 있는 슬롯만 덮고 나머지는 base 그대로', () => {
    const base = { implement: 'x', review: 'y', spec: null };
    const merged = mergeSlots(base, { implement: 'z' });
    expect(merged).toEqual({ implement: 'z', review: 'y', spec: null });
  });

  it('원본 base 를 변형하지 않는다', () => {
    const base = { a: 1 };
    const snapshot = { ...base };
    mergeSlots(base, { a: 2 });
    expect(base).toEqual(snapshot);
  });
});
