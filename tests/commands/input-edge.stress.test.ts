// 입력/엣지 스트레스 (stress-input-edge).
//
// record/state set 의 입력 검증·거부 경계가 이상 입력에서 견고한지 검증한다:
// 빈값·null·타입오류·거대 payload·BANNED 질적표현·깨진/비객체/거대 JSON.
// 발굴만 — 크래시·조용한 손상·검증 우회를 찾는다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildRecord } from '../../src/commands/record.js';
import { runStateSet, writeState } from '../../src/commands/state.js';

const DEFAULTS = { project: 'p', at: '2026-01-01T00:00:00.000Z', id: 'rec_x' };

describe('buildRecord 입력 엣지 (stress-input-edge AC-01/02)', () => {
  it('필수 필드 누락·null·빈문자열을 크래시 없이 missing 으로 거부한다', () => {
    // audit 는 scope/findings 필수(스키마).
    expect(buildRecord('audit', {}, DEFAULTS).missing.length).toBeGreaterThan(0);
    expect(
      buildRecord('audit', { scope: null, findings: null }, DEFAULTS).missing.length,
    ).toBeGreaterThan(0);
    expect(
      buildRecord('audit', { scope: '', findings: [] }, DEFAULTS).missing.length,
    ).toBeGreaterThan(0);
  });

  it('배열이어야 하는 필드에 비배열/빈배열을 주면 거부한다(검증 우회 없음)', () => {
    const r = buildRecord('audit', { scope: 's', findings: 'not-an-array' }, DEFAULTS);
    expect(r.missing.some((m) => m.includes('findings'))).toBe(true);
  });

  it('거대 payload(1MB 문자열)를 크래시 없이 처리한다', () => {
    const big = 'x'.repeat(1024 * 1024);
    const r = buildRecord(
      'audit',
      { scope: big, findings: [{ id: 'F', what: big, severity: 'low' }] },
      DEFAULTS,
    );
    // 유효한 구조면 missing 없음(거대해도 크래시/손상 없이 빌드).
    expect(r.missing).toEqual([]);
    expect(typeof r.record).toBe('object');
  });

  it('criteria 에 BANNED 질적표현이 있으면 거부한다(우회 없음)', () => {
    const r = buildRecord(
      'criteria',
      { items: [{ id: 'AC-1', 조건: '저위험 항목 수정', 범위: 'x', 검증: 'awl verify' }] },
      DEFAULTS,
    );
    expect(r.missing.some((m) => m.includes('금지') || m.includes('저위험'))).toBe(true);
  });

  it('깊은 중첩 payload 를 크래시 없이 처리한다', () => {
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 500; i++) {
      deep = { nested: deep };
    }
    const r = buildRecord(
      'audit',
      { scope: 's', findings: [{ id: 'F', what: 'w', severity: 'low', extra: deep }] },
      DEFAULTS,
    );
    expect(r.missing).toEqual([]);
  });
});

describe('runStateSet 입력 엣지 (stress-input-edge AC-01/02)', () => {
  const origCwd = process.cwd();
  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
  });

  function project(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-input-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    writeState(root, { workitem: 'W' });
    process.chdir(root);
    return root;
  }

  function expectExit(fn: () => void): string[] {
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errs: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    expect(fn).toThrow('exit:1');
    return errs;
  }

  it('깨진 JSON 을 크래시 없이 거부한다(exit:1)', () => {
    project();
    const errs = expectExit(() => runStateSet('{"a": '));
    expect(errs.join('')).toContain('읽지 못했습니다');
  });

  it('비객체(배열·숫자·문자열) JSON 을 거부한다', () => {
    project();
    expectExit(() => runStateSet('[1,2,3]'));
    project();
    expectExit(() => runStateSet('42'));
  });

  it('거대 유효 JSON(1MB) 을 크래시 없이 적용한다', () => {
    const root = project();
    const bigVal = 'y'.repeat(1024 * 1024);
    runStateSet(JSON.stringify({ note: bigVal }));
    const state = JSON.parse(fs.readFileSync(path.join(root, '.awl', 'state.json'), 'utf8'));
    expect(state.note).toHaveLength(1024 * 1024);
  });
});
