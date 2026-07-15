import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGenerations, renderMetrics, renderMetricsCaveat } from '../../src/commands/metrics.js';
import { caps } from '../../src/core/tty.js';

const origHome = process.env.AWL_HOME;

function seedGeneration(project: string, workitem: string, data: Record<string, unknown>): void {
  const dir = path.join(process.env.AWL_HOME as string, 'generations', project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${workitem}.json`), JSON.stringify(data));
}

beforeEach(() => {
  process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-metrics-'));
});

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('loadGenerations (WI-P AC-04)', () => {
  it('세대 스냅샷을 시간순(at)으로 정렬해 돌려준다 — 알파벳순과 반대로 섞어 진짜 정렬을 검증한다 (WI-P 리뷰 지적)', () => {
    // WI-Z 가 알파벳으로는 뒤지만 at 은 더 이르다. 이 fixture 는 알파벳순 우연 일치로
    // 통과할 수 없다 — sort() 를 지워보면 반드시 실패해야 진짜 회귀 테스트다.
    seedGeneration('p', 'WI-Z', {
      workitem: 'WI-Z',
      at: '2026-07-14T09:00:00Z',
      criteriaTotal: 2,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
    });
    seedGeneration('p', 'WI-A', {
      workitem: 'WI-A',
      at: '2026-07-14T10:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 1,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 1,
      gotchaMissed: 0,
    });
    const gens = loadGenerations('p');
    expect(gens.map((g) => g.workitem)).toEqual(['WI-Z', 'WI-A']);
  });

  it('gotchaApplied/gotchaMissed 필드가 없는 옛 스냅샷도 크래시 없이 0으로 읽는다 (하위호환)', () => {
    seedGeneration('p', 'WI-B', {
      workitem: 'WI-B',
      at: '2026-07-14T08:00:00Z',
      criteriaTotal: 11,
      avgAttempts: 0.73,
      blockedRatio: 0,
      reviewRejects: 2,
      proceduralErrors: 4,
      // gotchaApplied/gotchaMissed 없음 — 이 필드가 생기기 전(WI-B~WI-O)의 실제 스냅샷 형태
    });
    const gens = loadGenerations('p');
    expect(gens).toHaveLength(1);
    expect(gens[0]?.gotchaApplied).toBe(0);
    expect(gens[0]?.gotchaMissed).toBe(0);
  });

  it('coverage 가 없는 옛 스냅샷도 크래시 없이 0/false 로 읽는다 (하위호환, WI-T AC-04)', () => {
    seedGeneration('p', 'WI-C', {
      workitem: 'WI-C',
      at: '2026-07-14T08:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
      // coverage 없음 — WI-T 이전 스냅샷
    });
    const gens = loadGenerations('p');
    expect(gens[0]?.coverage).toEqual({
      auditFindingsTotal: 0,
      addressed: 0,
      excluded: 0,
      excludedApprovedByHuman: false,
    });
  });

  it('coverage 가 있으면 그대로 읽는다', () => {
    seedGeneration('p', 'WI-D', {
      workitem: 'WI-D',
      at: '2026-07-14T08:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
      coverage: { auditFindingsTotal: 5, addressed: 3, excluded: 2, excludedApprovedByHuman: true },
    });
    const gens = loadGenerations('p');
    expect(gens[0]?.coverage).toEqual({
      auditFindingsTotal: 5,
      addressed: 3,
      excluded: 2,
      excludedApprovedByHuman: true,
    });
  });

  it('프로젝트에 세대 기록이 전혀 없으면 빈 배열(크래시하지 않는다)', () => {
    expect(loadGenerations('nope')).toEqual([]);
  });

  it('깨진 JSON 파일은 건너뛴다', () => {
    const dir = path.join(process.env.AWL_HOME as string, 'generations', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'WI-broken.json'), '{ 이건 JSON 이 아님');
    seedGeneration('p', 'WI-1', {
      workitem: 'WI-1',
      at: '2026-07-14T09:00:00Z',
      criteriaTotal: 1,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
    });
    const gens = loadGenerations('p');
    expect(gens).toHaveLength(1);
  });
});

describe('renderMetricsCaveat — 난이도 경고 문구', () => {
  it('워크아이템마다 난이도가 다르다는 캐비트를 담는다', () => {
    expect(renderMetricsCaveat()).toContain('난이도');
  });
});

describe('renderMetrics — 사람용 표 (WI-P 리뷰 지적: criteriaTotal 누락 수정)', () => {
  it('criteriaTotal 을 포함한 모든 지표 값을 표에 담는다', () => {
    const out = renderMetrics(
      [
        {
          workitem: 'WI-1',
          at: '2026-07-14T09:00:00Z',
          criteriaTotal: 7,
          avgAttempts: 1.5,
          blockedRatio: 0.2,
          reviewRejects: 3,
          proceduralErrors: 4,
          gotchaApplied: 5,
          gotchaMissed: 6,
          coverage: {
            auditFindingsTotal: 12,
            addressed: 5,
            excluded: 7,
            excludedApprovedByHuman: true,
          },
        },
      ],
      caps(),
    );
    expect(out).toContain('WI-1');
    expect(out).toContain('7'); // criteriaTotal — 리뷰가 지적한 누락 필드
    expect(out).toContain('1.5');
    expect(out).toContain('0.2');
    expect(out).toContain('3');
    expect(out).toContain('4');
    expect(out).toContain('5');
    expect(out).toContain('6');
    expect(out).toContain('난이도'); // 캐비트
    expect(out).toContain('5/12'); // 커버리지(addressed/auditFindingsTotal, WI-T AC-04)
  });

  it('세대가 없으면 캐비트를 포함한 안내만 보여준다', () => {
    const out = renderMetrics([], caps());
    expect(out).toContain('세대 기록이 없습니다');
    expect(out).toContain('난이도');
  });
});
