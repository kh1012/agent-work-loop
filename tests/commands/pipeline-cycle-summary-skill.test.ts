import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// 소스 오브 트루스는 engine/(커밋·배포본)뿐이다 — pipeline-mode-skip-gate.test.ts 와 같은 원칙.
// .claude/skills 는 awl init 이 engine/ 에서 복사하는 gitignore 로컬 설치본이라 fresh
// checkout/CI 엔 없다.
const orchestratorRel = 'engine/skills/claude/awl-pipeline/SKILL.md';
const orchestrator = (): string =>
  fs.readFileSync(path.join(process.cwd(), orchestratorRel), 'utf8');

describe('pipeline-cycle-summary — 오케스트레이터 사이클 경계 추적·보고 (AC-04)', () => {
  it('(a) 유휴→스폰시작 시 사이클 시작시각 기록을 지시한다', () => {
    const text = orchestrator();
    expect(text).toContain('시작 기록');
    expect(text).toMatch(/사이클 시작 시각.*기록/);
    expect(text).toContain('cycleStartedAt');
  });

  it('(b) exec·review 스폰마다 에이전트 카운트 +1 을 지시한다(스폰 계약 근처)', () => {
    const text = orchestrator();
    expect(text).toContain('카운트');
    expect(text).toContain('cycleAgentCount');
    expect(text).toMatch(/스폰할 때마다.*1씩 늘린다|스폰 1건당.*1씩 늘린다/);
  });

  it('(c) 큐 재유휴 시 사이클종료→loop-summary 배치모드 호출→항목별+집계+wall-clock·에이전트수 최종보고를 지시한다', () => {
    const text = orchestrator();
    expect(text).toContain('종료 보고');
    expect(text).toContain('사이클 종료');
    expect(text).toContain('awl loop-summary --workitems');
    expect(text).toContain('배치모드');
    expect(text).toMatch(/총 소요시간.*에이전트.*스폰.*루프.*처리/);
    expect(text).toContain('항목별');
    expect(text).toContain('엔진 집계');
  });

  it('F-05 원칙: wall-clock ≠ 개별 합/평균, 섞지 않는다는 문장이 명시돼 있다', () => {
    const text = orchestrator();
    expect(text).toMatch(/wall-clock\s*≠\s*개별\s*합/);
    expect(text).toContain('섞지 않는다');
    expect(text).toContain('efficiency.durationMs');
    expect(text).toContain('참고용');
  });

  it('awl-pipeline-exec/review SKILL.md 는 이 워크아이템에서 안 건드린다(범위 밖 가드)', () => {
    const execText = fs.readFileSync(
      path.join(process.cwd(), 'engine/skills/claude/awl-pipeline-exec/SKILL.md'),
      'utf8',
    );
    const reviewText = fs.readFileSync(
      path.join(process.cwd(), 'engine/skills/claude/awl-pipeline-review/SKILL.md'),
      'utf8',
    );
    expect(execText).not.toContain('cycleStartedAt');
    expect(execText).not.toContain('cycleAgentCount');
    expect(reviewText).not.toContain('cycleStartedAt');
    expect(reviewText).not.toContain('cycleAgentCount');
  });
});
