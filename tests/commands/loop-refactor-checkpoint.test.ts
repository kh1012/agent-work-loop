import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 소스 오브 트루스는 engine/(커밋·배포본)뿐이다. .claude/skills 는 awl init 이
// engine/ 에서 복사하는 gitignore 로컬 설치본이라 fresh checkout/CI 엔 없다 —
// 커밋되는 테스트는 engine/ 만 읽는다(awl-feedback.test.ts 와 같은 원칙).
const rel = 'engine/skills/claude/awl-loop/SKILL.md';
const skill = (): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('loop-refactor-checkpoint — 반복 루프 리팩토링 체크포인트 (AC-01)', () => {
  it('반복 절에 리팩토링 체크포인트 상시 단계가 있다', () => {
    const text = skill();
    expect(text).toContain('리팩토링 체크포인트');
    // verify 통과 후 상시 점검 — 3개마다 리뷰까지 미루지 않는다
    expect(text).toMatch(/verify 를 통과한 직후|상시 점검/);
  });

  it('doctor 신호(IQR)와 리뷰어 C 구조판정을 재활용하고 숫자 임계를 강제하지 않는다', () => {
    const text = skill();
    // doctor 파일 크기 이상치를 기계 신호로 재활용(강제 아닌 신호)
    expect(text).toMatch(/이상치 신호|IQR|Tukey/);
    // 리뷰어 C. 구조 판정 기준 연결
    expect(text).toContain('C. 구조 판정');
    // 숫자 임계 강제 금지 명시
    expect(text).toMatch(/숫자 임계로 리팩토링을 강제하지 않는다|강제가 아니라 신호/);
  });
});

describe('loop-refactor-checkpoint — 진행 규칙 (AC-02)', () => {
  it('작은 정리는 즉시 격리 커밋+record refactor, 큰 변경은 완료조건 편입(게이트)', () => {
    const text = skill();
    // 작은 정리 = 즉시 커밋 + record refactor
    expect(text).toContain('작은 정리');
    expect(text).toContain('awl record refactor');
    // 큰 구조 변경 = 완료 조건 편입(게이트, 절대 규칙 1)
    expect(text).toContain('큰 구조 변경');
    expect(text).toMatch(/완료 조건으로 편입|게이트를 거친다/);
    expect(text).toContain('절대 규칙 1');
  });

  it('verify 를 안전망으로 명시한다', () => {
    const text = skill();
    expect(text).toMatch(/verify 가 안전망|통과 상태가 유지되는지/);
  });
});
