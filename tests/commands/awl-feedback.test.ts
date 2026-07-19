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
  //
  // awl-loop SKILL.md 는 progressive disclosure 로 분할됐다(조건부/저빈도 섹션은
  // reference.md 로 이동, 본문엔 링크 스텁만 남는다) — evolve 의 awl-feedback
  // 서브섹션은 그 6개 이동 대상 중 하나라 실제 본문은 reference.md 에 있다.
  it('engine/skills/claude/awl-loop 스킬 문서(SKILL.md 본문 또는 reference.md)에 awl-feedback 구분이 있다', () => {
    const skillText = fs.readFileSync(
      path.join(process.cwd(), 'engine/skills/claude/awl-loop/SKILL.md'),
      'utf8',
    );
    const referenceText = fs.readFileSync(
      path.join(process.cwd(), 'engine/skills/claude/awl-loop/reference.md'),
      'utf8',
    );
    // 토큰이 파일 어디에나 있으면 통과하는 약한 단언을 피한다(G-059) — "awl 도구 자체
    // 피드백" 섹션 헤더로 reference.md 를 슬라이스해, 그 섹션 범위 안에서 요소가
    // 공존하는지 확인한다. 다음 "## "/"### " 헤더 전까지가 그 섹션 범위다.
    const sectionStart = referenceText.indexOf('### awl 도구 자체 피드백');
    expect(sectionStart).toBeGreaterThanOrEqual(0);
    const afterHeader = referenceText.slice(sectionStart);
    const nextHeaderRel = afterHeader.slice(1).search(/\n#{2,3} /);
    const feedbackSection =
      nextHeaderRel === -1 ? afterHeader : afterHeader.slice(0, nextHeaderRel + 1);
    expect(feedbackSection).toContain('record awl-feedback');
    // gotcha 와 다른 종류임을 명시한다.
    expect(feedbackSection).toMatch(/gotcha 와 다르다|gotcha 로 승격되지 않는다/);
    // SKILL.md 본문의 evolve 섹션 자리에는 언제 참조해야 하는지 트리거 조건과
    // reference.md 링크(스텁)가 남아있어야 한다.
    const evolveStart = skillText.indexOf('## evolve');
    expect(evolveStart).toBeGreaterThanOrEqual(0);
    const evolveStub = skillText.slice(evolveStart, evolveStart + 400);
    expect(evolveStub).toContain('reference.md');
  });
});
