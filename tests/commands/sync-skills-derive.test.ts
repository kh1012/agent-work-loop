import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveTempLoopContent, derivedSkillName } from '../../src/commands/sync-skills.js';

// AC-01 — 파생 규칙 정의·검증 (엔진 정본 확인 + diff 가 트리거·역할명 줄에 국한).
// 정본 = 저장소 엔진 스킬(engine/skills/claude/awl-pipeline-*). vitest cwd = repo root.
const CANONICAL_DIR = path.join(process.cwd(), 'engine', 'skills', 'claude');
const ROLES = ['plan', 'exec', 'review'] as const;
const readCanonical = (role: string): string =>
  fs.readFileSync(path.join(CANONICAL_DIR, `awl-pipeline-${role}`, 'SKILL.md'), 'utf8');

describe('deriveTempLoopContent — 파생 규칙 (AC-01)', () => {
  it('awl-pipeline → temp-loop 치환, 구현 코어 awl-loop 는 보존', () => {
    const input = '트리거 /awl-pipeline-exec. 코어 /awl-loop. # awl-pipeline exec watcher';
    const out = deriveTempLoopContent(input);
    expect(out).toBe('트리거 /temp-loop-exec. 코어 /awl-loop. # temp-loop exec watcher');
    expect(out).not.toContain('awl-pipeline');
    expect(out).toContain('/awl-loop'); // 구현 코어 트리거는 안 바뀐다
  });

  it('실제 엔진 3역할: 파생 출력엔 awl-pipeline 토큰이 하나도 없다', () => {
    for (const role of ROLES) {
      const derived = deriveTempLoopContent(readCanonical(role));
      expect(derived.includes('awl-pipeline')).toBe(false);
    }
  });
});

describe('파생 diff 는 트리거·역할명 줄에만 국한된다 (AC-01 핵심 속성)', () => {
  it.each(ROLES)('awl-pipeline-%s: 엔진과 다른 모든 줄은 awl-pipeline 토큰을 담은 줄뿐', (role) => {
    const canonical = readCanonical(role);
    const derived = deriveTempLoopContent(canonical);
    const cLines = canonical.split('\n');
    const dLines = derived.split('\n');
    expect(dLines.length).toBe(cLines.length); // 줄 추가/삭제 없음
    const changedButNoToken: number[] = [];
    for (let i = 0; i < cLines.length; i++) {
      const c = cLines[i] ?? '';
      if (c !== (dLines[i] ?? '') && !c.includes('awl-pipeline')) {
        changedButNoToken.push(i + 1);
      }
    }
    expect(changedButNoToken).toEqual([]); // 트리거·역할명 아닌 줄은 안 바뀐다
  });
});

describe('lane·mode·marker 정본 콘텐츠 위치와 보존 (AC-01)', () => {
  it('marker(.taken): 역할스킬 3개가 담고, 파생 후에도 그대로 보존', () => {
    for (const role of ROLES) {
      const canonical = readCanonical(role);
      expect(canonical).toContain('.taken'); // 정본이 마커를 담는다
      const derived = deriveTempLoopContent(canonical);
      for (const line of canonical.split('\n').filter((l) => l.includes('.taken'))) {
        const expected = line.includes('awl-pipeline') ? deriveTempLoopContent(line) : line;
        expect(derived).toContain(expected);
      }
    }
  });

  it('lane(autolane unknown-lane)·mode(graded gate-*)는 오케스트레이터가 담고 역할스킬엔 없다', () => {
    const orch = fs.readFileSync(path.join(CANONICAL_DIR, 'awl-pipeline', 'SKILL.md'), 'utf8');
    expect(orch).toContain('unknown-lane-'); // autolane
    expect(orch).toContain('gate-high');
    expect(orch).toContain('gate-medium');
    expect(orch).toContain('gate-low');
    for (const role of ROLES) {
      const canonical = readCanonical(role);
      expect(canonical.includes('unknown-lane-')).toBe(false);
      expect(canonical.includes('gate-high')).toBe(false);
    }
  });
});

describe('derivedSkillName — 역할스킬만 매핑 (AC-01/02 경계)', () => {
  it('awl-pipeline-<role> → temp-loop-<role>', () => {
    expect(derivedSkillName('awl-pipeline-plan')).toBe('temp-loop-plan');
    expect(derivedSkillName('awl-pipeline-exec')).toBe('temp-loop-exec');
    expect(derivedSkillName('awl-pipeline-review')).toBe('temp-loop-review');
  });
  it('오케스트레이터 bare awl-pipeline·구현코어 awl-loop 는 제외(null)', () => {
    expect(derivedSkillName('awl-pipeline')).toBeNull();
    expect(derivedSkillName('awl-loop')).toBeNull();
    expect(derivedSkillName('unrelated')).toBeNull();
  });
});
