import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKLOG_THRESHOLD,
  REPEAT_THRESHOLD,
  collectBacklogCandidates,
  computeBacklogReport,
  promotedGotchaIds,
  readBacklogCursor,
  runBacklog,
  writeBacklogCursor,
} from '../../src/commands/backlog.js';
import type { Gotcha } from '../../src/commands/evolve.js';
import type { Rule } from '../../src/commands/rules.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function gotcha(id: string, count: number, historyAt: string[]): Gotcha {
  return {
    id,
    lesson: `lesson-${id}`,
    count,
    history: historyAt.map((at) => ({ at })),
  };
}

function rule(id: string, hits: number, source?: string): Rule {
  return { id, applies: 'a', counter: 'c', hits, source, body: 'b', file: `${id}.md` };
}

describe('promotedGotchaIds — 순수 함수', () => {
  it('rule.source 가 가리키는 gotcha id 만 모은다', () => {
    const ids = promotedGotchaIds([rule('R-001', 0, 'G-001'), rule('R-002', 0)]);
    expect(ids.has('G-001')).toBe(true);
    expect(ids.size).toBe(1);
  });
});

describe('collectBacklogCandidates — 순수 함수', () => {
  it(`count < ${REPEAT_THRESHOLD} 인 gotcha 는 후보에서 뺀다`, () => {
    const out = collectBacklogCandidates(
      [gotcha('G-001', 2, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'])],
      new Set(),
      '',
    );
    expect(out).toEqual([]);
  });

  it('이미 승격된 gotcha 는 후보에서 뺀다', () => {
    const out = collectBacklogCandidates(
      [gotcha('G-001', 3, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'])],
      new Set(['G-001']),
      '',
    );
    expect(out).toEqual([]);
  });

  it('커서 이후 활동이 없으면(이미 이전 정리 때 봤던 것) 후보에서 뺀다', () => {
    const out = collectBacklogCandidates(
      [gotcha('G-001', 3, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z'])],
      new Set(),
      '2026-01-04T00:00:00Z',
    );
    expect(out).toEqual([]);
  });

  it('커서 이후 활동이 있고 미승격이면 후보다', () => {
    const g = gotcha('G-001', 3, [
      '2026-01-01T00:00:00Z',
      '2026-01-02T00:00:00Z',
      '2026-01-05T00:00:00Z',
    ]);
    const out = collectBacklogCandidates([g], new Set(), '2026-01-04T00:00:00Z');
    expect(out.map((x) => x.id)).toEqual(['G-001']);
  });

  it('커서가 없으면(최초 실행) 그동안 전부를 후보로 본다', () => {
    const g = gotcha('G-001', 3, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z']);
    const out = collectBacklogCandidates([g], new Set(), '');
    expect(out).toHaveLength(1);
  });
});

describe('computeBacklogReport — 순수 함수', () => {
  it('후보/제로히트 규칙/임계 초과 여부를 계산한다', () => {
    const gotchas = [
      gotcha('G-001', 3, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z']),
      gotcha('G-002', 1, ['2026-01-01T00:00:00Z']),
    ];
    const rules = [rule('R-001', 0), rule('R-002', 5)];
    const report = computeBacklogReport(gotchas, rules, {});
    expect(report.candidateCount).toBe(1);
    expect(report.candidates[0]?.id).toBe('G-001');
    expect(report.zeroHitRuleCount).toBe(1);
    expect(report.overThreshold).toBe(false);
  });

  it(`후보가 ${BACKLOG_THRESHOLD}건을 넘으면 overThreshold 가 true 다`, () => {
    const many = Array.from({ length: BACKLOG_THRESHOLD + 1 }, (_, i) =>
      gotcha(`G-${i}`, 3, ['2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:02Z']),
    );
    const report = computeBacklogReport(many, [], {});
    expect(report.overThreshold).toBe(true);
    expect(report.candidateCount).toBe(BACKLOG_THRESHOLD + 1);
  });

  it('신호가 아예 없으면 candidateCount/zeroHitRuleCount 모두 0', () => {
    const report = computeBacklogReport([], [], {});
    expect(report.candidateCount).toBe(0);
    expect(report.zeroHitRuleCount).toBe(0);
    expect(report.overThreshold).toBe(false);
  });
});

describe('readBacklogCursor/writeBacklogCursor — 파일 왕복', () => {
  beforeEach(() => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-backlog-cursor-'));
  });

  it('파일이 없으면 빈 커서(그동안 전부로 취급)', () => {
    expect(readBacklogCursor()).toEqual({});
  });

  it('쓰고 다시 읽으면 그대로', () => {
    writeBacklogCursor({ lastCleanupAt: '2026-07-20T00:00:00.000Z' });
    expect(readBacklogCursor()).toEqual({ lastCleanupAt: '2026-07-20T00:00:00.000Z' });
  });

  it('깨진 파일은 크래시 없이 빈 커서', () => {
    fs.writeFileSync(path.join(process.env.AWL_HOME as string, 'backlog-cursor.json'), 'not json');
    expect(readBacklogCursor()).toEqual({});
  });
});

describe('runBacklog — CLI', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-backlog-cli-'));
    process.env.AWL_HOME = home;
  });

  function writeGotchaFile(g: Gotcha): void {
    const dir = path.join(home, 'gotchas');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${g.id}.json`), JSON.stringify(g));
  }

  it('신호가 없으면 크래시 없이 안내만 한다', () => {
    const stdoutSpy = spyStdout();
    runBacklog({});
    expect(stdoutSpy.text()).toContain('정리할 신호가 없습니다');
    stdoutSpy.restore();
  });

  it('--json 은 기계가 읽을 수 있는 리포트를 낸다', () => {
    writeGotchaFile(
      gotcha('G-001', 3, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z']),
    );
    const stdoutSpy = spyStdout();
    runBacklog({ json: true });
    const parsed = JSON.parse(stdoutSpy.text());
    expect(parsed.candidateCount).toBe(1);
    stdoutSpy.restore();
  });

  it(`후보가 ${BACKLOG_THRESHOLD}건을 넘으면 "누구든 회의를 소집할 수 있습니다" 를 함께 보여준다(WI-G11)`, () => {
    for (let i = 0; i < BACKLOG_THRESHOLD + 1; i += 1) {
      writeGotchaFile(gotcha(`G-${i}`, REPEAT_THRESHOLD, ['2026-01-01T00:00:00Z']));
    }
    const stdoutSpy = spyStdout();
    runBacklog({});
    expect(stdoutSpy.text()).toContain('누구든 회의를 소집할 수 있습니다');
    stdoutSpy.restore();
  });

  it('--reset 은 커서를 갱신하고 이후 실행에서 그 gotcha 가 후보에서 빠진다', () => {
    writeGotchaFile(
      gotcha('G-001', 3, ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00Z']),
    );
    let stdoutSpy = spyStdout();
    runBacklog({ json: true });
    expect(JSON.parse(stdoutSpy.text()).candidateCount).toBe(1);
    stdoutSpy.restore();

    stdoutSpy = spyStdout();
    runBacklog({ reset: true });
    stdoutSpy.restore();

    stdoutSpy = spyStdout();
    runBacklog({ json: true });
    expect(JSON.parse(stdoutSpy.text()).candidateCount).toBe(0);
    stdoutSpy.restore();
  });
});

/** process.stdout.write 를 스파이해 누적 텍스트를 돌려주는 최소 헬퍼. */
function spyStdout() {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    buf += String(chunk);
    return true;
  });
  return {
    text: () => buf,
    restore: () => spy.mockRestore(),
  };
}
