import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildFeedbackReport,
  loadAwlFeedback,
  renderFeedback,
} from '../../src/commands/feedback.js';

const origHome = process.env.AWL_HOME;
const ASCII = { unicode: false, color: false, tty: false };

function seedRecords(records: Record<string, unknown>[]): void {
  const dir = path.join(process.env.AWL_HOME as string, 'records');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '2026-07.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
}

/** awl-feedback 레코드 하나(기본값에 override). */
const fb = (over: Record<string, unknown>): Record<string, unknown> => ({
  type: 'awl-feedback',
  area: 'commit',
  what: 'x',
  impact: 'y',
  severity: 'high',
  workitem: 'WI-1',
  at: '2026-07-14T10:00:00Z',
  ...over,
});

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('buildFeedbackReport — area 별 묶기/정렬 (BC-01/BC-02/BC-03)', () => {
  it('area 별로 묶고 count 를 낸다 (BC-01)', () => {
    const rep = buildFeedbackReport([
      fb({ area: 'commit' }),
      fb({ area: 'commit' }),
      fb({ area: 'gate' }),
    ]);
    expect(rep.areas.commit?.count).toBe(2);
    expect(rep.areas.gate?.count).toBe(1);
  });

  it('count 2 이상 area 를 repeated + prioritized 로 표시한다 (BC-02)', () => {
    const rep = buildFeedbackReport([
      fb({ area: 'commit' }),
      fb({ area: 'commit' }),
      fb({ area: 'gate' }),
    ]);
    expect(rep.areas.commit?.repeated).toBe(true);
    expect(rep.areas.gate?.repeated).toBe(false);
    expect(rep.prioritized).toEqual(['commit']);
  });

  it('area 안 items 는 severity 순(high 먼저)으로 정렬한다 (BC-01)', () => {
    const rep = buildFeedbackReport([
      fb({ area: 'commit', severity: 'low', what: 'L' }),
      fb({ area: 'commit', severity: 'high', what: 'H' }),
    ]);
    expect(rep.areas.commit?.items[0]?.what).toBe('H');
    expect(rep.areas.commit?.items[1]?.what).toBe('L');
  });

  it('collectedFrom 은 서로 다른 워크아이템 수다 (BC-03)', () => {
    const rep = buildFeedbackReport([
      fb({ workitem: 'A' }),
      fb({ workitem: 'A' }),
      fb({ workitem: 'B' }),
    ]);
    expect(rep.collectedFrom).toBe(2);
  });

  it('구조는 collectedFrom/areas/prioritized 이고 fix/solution 필드는 없다 (BC-03/BC-05)', () => {
    const json = JSON.parse(JSON.stringify(buildFeedbackReport([fb({}), fb({})])));
    expect(json).toHaveProperty('collectedFrom');
    expect(json).toHaveProperty('areas');
    expect(json).toHaveProperty('prioritized');
    expect(json).not.toHaveProperty('fix');
    expect(json).not.toHaveProperty('solution');
  });
});

describe('loadAwlFeedback — 필터 (BC-04)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-fbcmd-'));
  });

  it('type awl-feedback 만 읽는다 (다른 기록은 무시)', () => {
    seedRecords([
      fb({}),
      { type: 'blocked', at: '2026-07-14T10:00:00Z', workitem: 'WI-1', what: 'x' },
    ]);
    expect(loadAwlFeedback()).toHaveLength(1);
  });

  it('--area 로 거른다', () => {
    seedRecords([fb({ area: 'commit' }), fb({ area: 'gate' })]);
    const r = loadAwlFeedback({ area: 'gate' });
    expect(r).toHaveLength(1);
    expect(r[0]?.area).toBe('gate');
  });

  it('--severity 로 거른다', () => {
    seedRecords([fb({ severity: 'high' }), fb({ severity: 'low' })]);
    expect(loadAwlFeedback({ severity: 'low' })).toHaveLength(1);
  });

  it('--since 로 그 이후 수집분만 거른다', () => {
    seedRecords([fb({ at: '2026-06-01T00:00:00Z' }), fb({ at: '2026-07-10T00:00:00Z' })]);
    const r = loadAwlFeedback({ since: '2026-07-01' });
    expect(r).toHaveLength(1);
    expect(r[0]?.at).toBe('2026-07-10T00:00:00Z');
  });
});

describe('renderFeedback — 해법 미제시 (BC-05)', () => {
  it('반복 area 에 우선 검토 안내는 하되 에이전트 suggestion 을 해법으로 노출하지 않는다', () => {
    const rep = buildFeedbackReport([
      fb({ area: 'commit', suggestion: '특정해법XYZ' }),
      fb({ area: 'commit' }),
    ]);
    const text = renderFeedback(rep, ASCII);
    expect(text).toContain('우선 검토'); // surfacing(안내)은 한다
    expect(text).not.toContain('특정해법XYZ'); // suggestion 을 awl 권고로 노출하지 않는다
  });

  it('수집된 게 없으면 빈 안내를 준다', () => {
    const text = renderFeedback(buildFeedbackReport([]), ASCII);
    expect(text).toContain('아직 수집된 awl-feedback 이 없습니다');
  });
});
