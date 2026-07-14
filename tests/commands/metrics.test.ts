import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadGenerations, renderMetricsCaveat } from '../../src/commands/metrics.js';

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
  it('세대 스냅샷을 시간순(at)으로 정렬해 돌려준다', () => {
    seedGeneration('p', 'WI-2', {
      workitem: 'WI-2',
      at: '2026-07-14T10:00:00Z',
      criteriaTotal: 3,
      avgAttempts: 1,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 1,
      gotchaMissed: 0,
    });
    seedGeneration('p', 'WI-1', {
      workitem: 'WI-1',
      at: '2026-07-14T09:00:00Z',
      criteriaTotal: 2,
      avgAttempts: 0,
      blockedRatio: 0,
      reviewRejects: 0,
      proceduralErrors: 0,
      gotchaApplied: 0,
      gotchaMissed: 0,
    });
    const gens = loadGenerations('p');
    expect(gens.map((g) => g.workitem)).toEqual(['WI-1', 'WI-2']);
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
