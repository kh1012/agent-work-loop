import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { filterRules, loadRules, parseRuleFile, suggestLinter } from '../../src/commands/rules.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

const GOOD = `---
id: R-001
scope: implement
applies: 무조건 (범용)
counter: 테스트가 실제로 기능을 검증하지 않는 예외적 경우
violations: 0
createdAt: 2026-07-14
---

테스트를 삭제하거나 약화시켜 통과시키지 않는다.

근거: 자율 루프의 지배적 실패 양상은 "기능 구현" 대신 "테스트 통과"다.`;

describe('parseRuleFile', () => {
  it('정상 frontmatter 를 파싱한다', () => {
    const { rule, warnings } = parseRuleFile(GOOD, 'R-001.md');
    expect(warnings).toEqual([]);
    expect(rule?.id).toBe('R-001');
    expect(rule?.scope).toBe('implement');
    expect(rule?.applies).toContain('범용');
    expect(rule?.body.split('\n')[0]).toContain('테스트를 삭제');
  });

  it('applies/counter 가 없으면 경고한다(검증 불가능한 신념 방지)', () => {
    const bad = `---
id: R-002
---

any 로 덮지 마라.`;
    const { warnings } = parseRuleFile(bad, 'R-002.md');
    expect(warnings.some((w) => w.includes('applies'))).toBe(true);
    expect(warnings.some((w) => w.includes('counter'))).toBe(true);
  });
});

describe('loadRules — 규칙 0개', () => {
  it('규칙이 없어도 크래시하지 않고 빈 배열', () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-rules-'));
    const { rules, warnings } = loadRules();
    expect(rules).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('active 에 규칙 파일이 있으면 읽고, 경고도 모은다', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-rules-'));
    process.env.AWL_HOME = home;
    const activeDir = path.join(home, 'rules', 'active');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, 'R-001.md'), GOOD);
    fs.writeFileSync(path.join(activeDir, 'R-002.md'), '---\nid: R-002\n---\n\nbody');
    const { rules, warnings } = loadRules();
    expect(rules).toHaveLength(2);
    expect(warnings.length).toBeGreaterThan(0); // R-002 에 applies/counter 없음
  });
});

describe('filterRules — scope', () => {
  const rules = [
    { id: 'A', scope: 'implement', applies: '', counter: '', violations: 0, body: 'a', file: 'a' },
    { id: 'B', applies: '', counter: '', violations: 0, body: 'b', file: 'b' }, // 무태그
  ];

  it('scope 지정 시 무태그와 일치 scope 만 남긴다', () => {
    const out = filterRules(rules, { scope: 'implement' });
    expect(out.map((r) => r.id)).toEqual(['A', 'B']); // B는 무태그라 항상 포함
  });

  it('scope 가 다르면 태그 규칙은 빠지고 무태그만', () => {
    const out = filterRules(rules, { scope: 'review' });
    expect(out.map((r) => r.id)).toEqual(['B']);
  });
});

describe('suggestLinter — 검사기 승격 안내', () => {
  it('any 규칙은 no-explicit-any 를 안내한다', () => {
    expect(suggestLinter('any 로 타입을 덮지 않는다')?.rule).toBe(
      '@typescript-eslint/no-explicit-any',
    );
  });
  it('@ts-ignore 규칙은 ban-ts-comment 를 안내한다', () => {
    expect(suggestLinter('타입 오류를 @ts-ignore 로 덮지 않는다')?.rule).toBe(
      '@typescript-eslint/ban-ts-comment',
    );
  });
  it('정적 검사로 못 만드는 교훈은 null', () => {
    expect(suggestLinter('오버레이 좌표계가 축에 의존하는지 먼저 확인한다')).toBeNull();
  });
});
