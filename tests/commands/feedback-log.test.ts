import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildFeedbackReport,
  isInvalidSince,
  loadAwlFeedback,
  renderFeedbackLog,
  runFeedback,
} from '../../src/commands/feedback-log.js';

const origHome = process.env.AWL_HOME;
const ASCII = { unicode: false, color: false, tty: false };

/**
 * awl-feedback 은 프로젝트 무관 집계라(WI-G17a 후속) records 를 project-local 로
 * 쓰고 그 프로젝트를 ~/.awl/projects.json 에 등록해야 loadAwlFeedback 이 찾는다.
 */
function seedRecords(records: Record<string, unknown>[]): void {
  const home = process.env.AWL_HOME as string;
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-fb-proj-'));
  fs.writeFileSync(
    path.join(home, 'projects.json'),
    JSON.stringify([{ name: 'p', path: proj }]),
  );
  const dir = path.join(proj, '.awl', 'records');
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

  it('--since 가 밀리초 없는 표기여도 밀리초 있는 at 을 올바로 포함한다 (적대검증: 사전식이면 틀렸을 케이스)', () => {
    // 사전식 비교면 '.'(0x2E) < 'Z'(0x5A) 라 .500Z 가 since 이전으로 오판돼 제외됐다.
    seedRecords([
      fb({ at: '2026-07-01T00:00:00.500Z' }), // since 직후 — 포함돼야
      fb({ at: '2026-06-30T23:00:00Z' }), // since 이전 — 제외
    ]);
    const r = loadAwlFeedback({ since: '2026-07-01T00:00:00Z' });
    expect(r).toHaveLength(1);
    expect(r[0]?.at).toBe('2026-07-01T00:00:00.500Z');
  });

  it('--since 가 날짜로 안 읽히면 필터를 무시하고 전체를 준다 (+ isInvalidSince)', () => {
    seedRecords([fb({}), fb({})]);
    expect(loadAwlFeedback({ since: '이상한값' })).toHaveLength(2);
    expect(isInvalidSince('이상한값')).toBe(true);
    expect(isInvalidSince('2026-07-01')).toBe(false);
    expect(isInvalidSince(undefined)).toBe(false);
  });
});

describe('runFeedback — awl feedback "<text>" (WI-G18)', () => {
  const origCwd = process.cwd();
  const origHome = process.env.AWL_HOME;

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  function project(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-feedback-cli-')));
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-feedback-cli-home-'));
    return root;
  }

  function mockExit() {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return { exitSpy, stderrSpy };
  }

  function readFeedbackRecords(root: string): Record<string, unknown>[] {
    const dir = path.join(root, '.awl', 'records');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const out: Record<string, unknown>[] = [];
    for (const f of files) {
      const lines = fs
        .readFileSync(path.join(dir, f), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const l of lines) {
        out.push(JSON.parse(l));
      }
    }
    return out;
  }

  it('빈 text 는 거부한다', async () => {
    project();
    const { exitSpy } = mockExit();
    await expect(runFeedback('  ')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('허용되지 않은 --area 는 거부한다', async () => {
    project();
    const { exitSpy } = mockExit();
    await expect(runFeedback('x', { area: '없는area' })).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('허용되지 않은 --severity 는 거부한다', async () => {
    project();
    const { exitSpy } = mockExit();
    await expect(runFeedback('x', { severity: '없는sev' })).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('프로젝트 루트를 못 찾으면 거부한다', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-feedback-noproj-')));
    process.chdir(root);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-feedback-noproj-home-'));
    const { exitSpy } = mockExit();
    await expect(runFeedback('x')).rejects.toThrow('exit:1');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('기본값(area:기타, severity:low, source:manual)으로 project-local records 에 남긴다', async () => {
    const root = project();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFeedback('버튼이 안 눌려요');
    stdoutSpy.mockRestore();
    const records = readFeedbackRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0]?.type).toBe('awl-feedback');
    expect(records[0]?.area).toBe('기타');
    expect(records[0]?.severity).toBe('low');
    expect(records[0]?.source).toBe('manual');
    expect(records[0]?.what).toBe('버튼이 안 눌려요');
  });

  it('--area/--impact/--severity 를 그대로 반영한다', async () => {
    const root = project();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFeedback('커밋 메시지가 이상해요', {
      area: 'commit',
      impact: '리뷰가 헷갈림',
      severity: 'high',
    });
    stdoutSpy.mockRestore();
    const records = readFeedbackRecords(root);
    expect(records[0]?.area).toBe('commit');
    expect(records[0]?.impact).toBe('리뷰가 헷갈림');
    expect(records[0]?.severity).toBe('high');
  });

  it('활성 워크아이템(state.json) 없이도 남길 수 있다 (awl record 의 일반 강제와 다름)', async () => {
    const root = project();
    expect(fs.existsSync(path.join(root, '.awl', 'state.json'))).toBe(false);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFeedback('워크아이템 밖에서도 됨');
    stdoutSpy.mockRestore();
    expect(readFeedbackRecords(root)).toHaveLength(1);
  });

  it('자동수집(source:auto)과 사람 입력(source:manual)이 구분된다', async () => {
    const root = project();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await runFeedback('사람이 남김');
    stdoutSpy.mockRestore();
    const records = readFeedbackRecords(root);
    expect(records[0]?.source).toBe('manual');
    expect(records[0]?.source).not.toBe('auto');
  });
});

describe('renderFeedbackLog — 해법 미제시 (BC-05)', () => {
  it('반복 area 에 우선 검토 안내는 하되 에이전트 suggestion 을 해법으로 노출하지 않는다', () => {
    const rep = buildFeedbackReport([
      fb({ area: 'commit', suggestion: '특정해법XYZ' }),
      fb({ area: 'commit' }),
    ]);
    const text = renderFeedbackLog(rep, ASCII);
    expect(text).toContain('우선 검토'); // surfacing(안내)은 한다
    expect(text).not.toContain('특정해법XYZ'); // suggestion 을 awl 권고로 노출하지 않는다
  });

  it('수집된 게 없으면 빈 안내를 준다', () => {
    const text = renderFeedbackLog(buildFeedbackReport([]), ASCII);
    expect(text).toContain('아직 수집된 awl-feedback 이 없습니다');
  });

  it('반복 태그가 하드코딩이 아니라 signal(warn) 로 caps 폴백한다 (cli-visual-consistency AC-05)', () => {
    const rep = buildFeedbackReport([fb({ area: 'commit' }), fb({ area: 'commit' })]);
    expect(renderFeedbackLog(rep, ASCII)).toContain('[!] 반복'); // ASCII 폴백
    // signal() 이 유니코드 여부와 무관하게 텍스트 마커를 쓰므로(이모지 폐지) 동일하게 [!].
    expect(renderFeedbackLog(rep, { unicode: true, color: false, tty: true })).toContain(
      '[!] 반복',
    );
  });
});
