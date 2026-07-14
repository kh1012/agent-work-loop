import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadGotchas } from '../../src/commands/gotchas.js';
import { legacyDeltasDir } from '../../src/core/paths.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('loadGotchas (WI-O AC-05, 실사고 재현 방지)', () => {
  it('레거시 deltas/ 만 있어도 자동 마이그레이션을 타서 정상적으로 읽힌다', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gotchas-home-'));
    const dir = legacyDeltasDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'D-001.json'),
      JSON.stringify({ id: 'D-001', lesson: '레거시 교훈', count: 1 }),
    );

    // 실사고: gotchas.ts 가 evolve.ts 의 loadGotchaList 를 안 쓰고 자체적으로
    // fs.readdirSync 만 했을 때, 이 경로가 마이그레이션 트리거를 못 타서
    // gotchas/ 가 비어있는 채로 빈 배열을 냈다(실제 ~/.awl/deltas/ 15개로
    // 마이그레이션을 실행하다 발견됨). loadGotchaList 를 재사용하도록 고쳐
    // 이 경로에서도 마이그레이션이 자동으로 일어남을 확인한다.
    const gotchas = loadGotchas();
    expect(gotchas).toHaveLength(1);
    expect(gotchas[0]?.id).toBe('G-001');
    expect(gotchas[0]?.lesson).toBe('레거시 교훈');
  });

  it('gotchas/ 가 이미 있으면 그대로 읽는다', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gotchas-home2-'));
    const dir = path.join(process.env.AWL_HOME, 'gotchas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'G-001.json'),
      JSON.stringify({ id: 'G-001', lesson: '새 교훈', count: 1 }),
    );

    const gotchas = loadGotchas();
    expect(gotchas).toHaveLength(1);
    expect(gotchas[0]?.lesson).toBe('새 교훈');
  });

  it('아무것도 없으면 빈 배열(크래시하지 않는다)', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gotchas-home3-'));
    expect(loadGotchas()).toEqual([]);
  });
});
