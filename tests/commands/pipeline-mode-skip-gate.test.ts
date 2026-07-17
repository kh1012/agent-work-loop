import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 소스 오브 트루스는 engine/(커밋·배포본)뿐이다. .claude/skills 는 awl init 이 engine/
// 에서 복사하는 gitignore 로컬 설치본이라 fresh checkout/CI 엔 없다 — 커밋되는 테스트는
// engine/ 만 읽는다(loop-refactor-checkpoint.test.ts·awl-feedback.test.ts 와 같은 원칙).
const rel = 'engine/skills/claude/awl-pipeline/SKILL.md';
const skill = (): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('pipeline-mode-skip-gate — mode 세트·기본값·축약 (AC-01)', () => {
  it('gate/skip-gate/auto 3상태를 mode 토큰으로 나열한다', () => {
    // G-061: 맨 skip-gate 부분문자열은 기존 "skip-gate-defer" 로 공허 통과한다 —
    // 모드 토큰 파이프 나열(원본엔 `critical-only` 라 부재)로 실제 리네임을 잠근다.
    expect(skill()).toMatch(/`gate`\s*\|\s*`skip-gate`\s*\|\s*`auto`/);
  });

  it('무인자 기본은 gate — "생략 시 gate", 옛 "생략 시 critical-only" 는 사라졌다', () => {
    const text = skill();
    // 새 양성 계약(G-062): 기본이 gate 임을 단언
    expect(text).toMatch(/생략 시 `?gate`?/);
    // 기본 리네임의 뮤테이션 저항: 옛 기본 문구가 되살아나면 실패
    expect(text).not.toMatch(/생략 시 `?critical-only`?/);
  });

  it('critical-only 명칭이 스킬 파일에서 완전히 사라졌다 (skip-gate 로 통일)', () => {
    // G-048: 광범위 통일은 grep 카운트가 아니라 표면(파일) 전체 부재로 확인
    expect(skill()).not.toContain('critical-only');
  });

  it('축약 --g/--sg/--a 와 유연 파싱(sg·--sg·skip-gate 인식)을 명시한다', () => {
    const text = skill();
    expect(text).toContain('--g');
    expect(text).toContain('--sg');
    expect(text).toContain('--a');
    // 유연 파싱: 접두 대시 유무·축약·전체명을 한 모드로 인식한다고 문서화
    expect(text).toContain('유연 파싱');
    expect(text).toMatch(/`sg`.*`--sg`.*`skip-gate`/);
  });
});
