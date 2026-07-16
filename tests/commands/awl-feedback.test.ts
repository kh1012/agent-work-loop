import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRecord } from '../../src/commands/record.js';
import { gotchasDir, recordsDir } from '../../src/core/paths.js';

/**
 * awl-feedback(0.6.x) 저장 분리와 스킬 문서 검증.
 *
 * awl-feedback 은 awl 도구 자체가 아팠던 점이다 — gotcha(작업 코드 교훈)와 다른
 * 종류다. records/ 에 쌓이고 gotchas/ 와 섞이지 않으며 gotcha 로 승격되지 않는다.
 */

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('awl-feedback — records/ 에 저장, gotchas/ 와 분리 (AC-03)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-fb-'));
  });

  it('appendRecord(awl-feedback) 는 records/ 에 쓰고 gotchas/ 는 안 건드린다', () => {
    appendRecord({
      id: 'x1',
      at: '2026-07-16T00:00:00Z',
      project: 'p',
      type: 'awl-feedback',
      area: 'commit',
      what: 'a',
      impact: 'b',
      severity: 'high',
    });
    // records/ 에 type:awl-feedback 가 있다.
    const files = fs.readdirSync(recordsDir()).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(recordsDir(), files[0] as string), 'utf8');
    expect(content).toContain('"type":"awl-feedback"');
    // gotchas/ 는 안 만들어졌거나 비어있다(승격되지 않는다).
    const gDir = gotchasDir();
    const gEntries = fs.existsSync(gDir) ? fs.readdirSync(gDir) : [];
    expect(gEntries).toEqual([]);
  });
});

describe('awl-feedback — 스킬 문서에 gotcha 와의 구분 명시 (AC-04)', () => {
  // 소스 오브 트루스는 engine/(커밋·배포본)뿐이다. 프로젝트의 .claude/skills 는
  // awl init 이 engine/ 에서 복사하는 gitignore 된 로컬 설치본이라, fresh checkout/CI
  // 에는 없다 — 커밋되는 테스트가 하드코딩해 읽으면 안 된다.
  it('engine/skills/claude/awl-loop/SKILL.md evolve 섹션에 awl-feedback 구분이 있다', () => {
    const rel = 'engine/skills/claude/awl-loop/SKILL.md';
    const text = fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
    expect(text).toContain('record awl-feedback');
    // gotcha 와 다른 종류임을 명시한다.
    expect(text).toMatch(/gotcha 와 다르다|gotcha 로 승격되지 않는다/);
  });
});
