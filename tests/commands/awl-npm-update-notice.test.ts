import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 소스 오브 트루스는 engine/(커밋·배포본)뿐이다. .claude/skills 는 awl init 이
// engine/ 에서 복사하는 gitignore 로컬 설치본이라 fresh checkout/CI 엔 없다 —
// 커밋되는 테스트는 engine/ 만 읽는다(loop-refactor-checkpoint.test.ts 와 같은 원칙).
const rel = 'engine/skills/claude/awl-loop/SKILL.md';
const skill = (): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('awl-npm-update-notice — SKILL.md 가 updateAvailable 을 mismatches 와 다르게 취급한다 (AC-04)', () => {
  it('버전 확인 절에 updateAvailable 은 정보성 한 줄만 보여준다는 문장이 있다', () => {
    const text = skill();
    expect(text).toContain('updateAvailable');
    // "계속할지 묻거나 audit 기록을 요구하지 않는다" — mismatches 의 처리(계속할지 묻고 audit
    // 기록 요구)와 대비되는 문장이 명시돼 있어야 한다.
    expect(text).toMatch(/묻거나.*audit.*요구하지 않는다|계속할지 묻지 않는다/);
  });

  it('기존 mismatches 처리(hint 를 보여주고 계속할지 묻고 audit 기록) 문장은 그대로 남아있다(회귀 없음)', () => {
    const text = skill();
    expect(text).toContain('hint');
    expect(text).toContain('계속할지 묻는다');
    expect(text).toContain('awl record audit');
  });

  it('버전 확인 절 안에 있다(워킹트리 확인보다 먼저 오는 절)', () => {
    const text = skill();
    const versionSectionStart = text.indexOf('### 버전 확인');
    const workingTreeSectionStart = text.indexOf('### 워킹트리 확인');
    const updateAvailableIdx = text.indexOf('updateAvailable');
    expect(versionSectionStart).toBeGreaterThan(-1);
    expect(workingTreeSectionStart).toBeGreaterThan(versionSectionStart);
    expect(updateAvailableIdx).toBeGreaterThan(versionSectionStart);
    expect(updateAvailableIdx).toBeLessThan(workingTreeSectionStart);
  });
});
