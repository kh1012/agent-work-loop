import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveTempLoopContent,
  runSyncSkills,
  syncPipelineSkills,
} from '../../src/commands/sync-skills.js';
import { buildProgram } from '../../src/program.js';

// AC-02 — 재생성 메커니즘 (fixture 대상 · 멱등 · 격리). 실제 ~/.claude 는 안 건드린다.
const CANONICAL_DIR = path.join(process.cwd(), 'engine', 'skills', 'claude');
const ROLES = ['plan', 'exec', 'review'] as const;
const readCanonical = (role: string): string =>
  fs.readFileSync(path.join(CANONICAL_DIR, `awl-pipeline-${role}`, 'SKILL.md'), 'utf8');

const tmpDirs: string[] = [];
const mkTmp = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  }
});

/** stdout 을 캡처해 문자열로 돌려주며 콜백을 실행한다. */
function captureStdout(fn: () => void): string {
  let buf = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    buf += String(c);
    return true;
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return buf;
}

/** 엔진 소스 흉내 fixture: 역할스킬 3개 + 오케스트레이터 + 구현코어(제외 대상) */
function seedEngineFixture(from: string): void {
  const write = (name: string, body: string): void => {
    fs.mkdirSync(path.join(from, name), { recursive: true });
    fs.writeFileSync(path.join(from, name, 'SKILL.md'), body);
  };
  for (const role of ROLES) {
    write(
      `awl-pipeline-${role}`,
      `name: awl-pipeline-${role}\n트리거 /awl-pipeline-${role}. 코어 /awl-loop.\n마커 .taken 단일 진실.\n`,
    );
  }
  write('awl-pipeline', 'name: awl-pipeline\n오케스트레이터. autolane unknown-lane-N. graded.\n');
  write('awl-loop', 'name: awl-loop\n구현 코어.\n');
}

describe('syncPipelineSkills — 엔진→글로벌 파생 (AC-02)', () => {
  it('역할스킬 3개만 파생하고 오케스트레이터·awl-loop 는 건너뛴다', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    const res = syncPipelineSkills({ from, to });

    const derivedNames = res.skills.map((s) => s.derivedName).sort();
    expect(derivedNames).toEqual(['temp-loop-exec', 'temp-loop-plan', 'temp-loop-review']);
    for (const role of ROLES) {
      const out = fs.readFileSync(path.join(to, `temp-loop-${role}`, 'SKILL.md'), 'utf8');
      expect(out).toContain(`/temp-loop-${role}`);
      expect(out).toContain('/awl-loop'); // 코어 보존
      expect(out).toContain('.taken'); // 마커 보존
      expect(out.includes('awl-pipeline')).toBe(false);
    }
    // 제외 대상은 대상 디렉토리에 생기지 않는다
    expect(fs.existsSync(path.join(to, 'temp-loop'))).toBe(false);
    expect(fs.existsSync(path.join(to, 'awl-loop'))).toBe(false);
  });

  it('재실행 멱등: 두 번째 실행은 전부 changed:false + 파일 바이트 동일', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);

    const first = syncPipelineSkills({ from, to });
    expect(first.skills.every((s) => s.changed)).toBe(true); // 최초엔 전부 새로 씀
    const afterFirst = ROLES.map((r) =>
      fs.readFileSync(path.join(to, `temp-loop-${r}`, 'SKILL.md'), 'utf8'),
    );

    const second = syncPipelineSkills({ from, to });
    expect(second.skills.every((s) => !s.changed)).toBe(true); // 재실행은 변화 없음
    expect(second.skills.every((s) => s.action === 'unchanged')).toBe(true);
    const afterSecond = ROLES.map((r) =>
      fs.readFileSync(path.join(to, `temp-loop-${r}`, 'SKILL.md'), 'utf8'),
    );
    expect(afterSecond).toEqual(afterFirst); // 바이트 동일
  });

  it('낡은 글로벌(fixture)을 엔진 최신으로 덮는다 → 재실행 멱등', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    // 낡은 글로벌: 테스트베드 프레이밍 잔재
    fs.mkdirSync(path.join(to, 'temp-loop-exec'), { recursive: true });
    fs.writeFileSync(
      path.join(to, 'temp-loop-exec', 'SKILL.md'),
      '낡음: awl 정식 탑재 전 테스트베드.\n',
    );

    const res = syncPipelineSkills({ from, to });
    const exec = res.skills.find((s) => s.derivedName === 'temp-loop-exec');
    expect(exec?.changed).toBe(true); // 낡은 걸 덮었다
    const out = fs.readFileSync(path.join(to, 'temp-loop-exec', 'SKILL.md'), 'utf8');
    expect(out).toContain('/temp-loop-exec');
    expect(out.includes('테스트베드')).toBe(false); // 잔재 제거됨

    const again = syncPipelineSkills({ from, to });
    expect(again.skills.every((s) => !s.changed)).toBe(true); // 덮은 뒤 멱등
  });

  it('dryRun: 파일을 쓰지 않고 갱신 예정만 보고한다', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    const res = syncPipelineSkills({ from, to, dryRun: true });
    expect(res.skills.every((s) => s.changed)).toBe(true); // 변경 예정
    expect(res.skills.every((s) => s.action === 'would-change')).toBe(true);
    expect(fs.existsSync(path.join(to, 'temp-loop-exec'))).toBe(false); // 실제로 안 씀
  });

  it('없는 소스 디렉토리는 조용히 빈 결과', () => {
    const to = mkTmp('awl-sync-to-');
    const res = syncPipelineSkills({ from: path.join(to, 'does-not-exist'), to });
    expect(res.skills).toEqual([]);
  });

  it('실제 엔진 정본에서 정확히 temp-loop-{plan,exec,review} 3개를 파생한다', () => {
    const to = mkTmp('awl-sync-real-');
    const res = syncPipelineSkills({ from: CANONICAL_DIR, to });
    expect(res.skills.map((s) => s.derivedName).sort()).toEqual([
      'temp-loop-exec',
      'temp-loop-plan',
      'temp-loop-review',
    ]);
    for (const role of ROLES) {
      const out = fs.readFileSync(path.join(to, `temp-loop-${role}`, 'SKILL.md'), 'utf8');
      expect(out).toBe(deriveTempLoopContent(readCanonical(role))); // 정본에서 파생된 그대로
    }
  });
});

describe('runSyncSkills — 핸들러 glue (AC-02)', () => {
  it('--json: 동기화 결과를 JSON 으로 출력하고 파일을 쓴다', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    const out = captureStdout(() => runSyncSkills({ from, to, json: true }));
    const parsed = JSON.parse(out) as { from: string; to: string; skills: unknown[] };
    expect(parsed.to).toBe(to);
    expect(parsed.skills).toHaveLength(3);
    expect(fs.existsSync(path.join(to, 'temp-loop-exec', 'SKILL.md'))).toBe(true);
  });

  it('사람 출력: from/to 와 파생 스킬명을 보여준다', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    const out = captureStdout(() => runSyncSkills({ from, to }));
    expect(out).toContain(from);
    expect(out).toContain(to);
    expect(out).toContain('temp-loop-exec');
  });
});

describe('program 등록 (AC-02/04)', () => {
  it('awl sync-skills 명령이 등록돼 있고 --from/--to/--dry-run/--yes 옵션을 갖는다', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'sync-skills');
    expect(cmd).toBeDefined();
    const help = cmd?.helpInformation() ?? '';
    expect(help).toContain('--from');
    expect(help).toContain('--to');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--yes');
  });
});

// ---------------------------------------------------------------------------
// AC-04 — 리뷰 finding 반영: 바레 실행 라이브 글로벌 안전장치(F-A) + write-skip 스파이(F-B)
// ---------------------------------------------------------------------------

describe('바레 sync-skills 라이브 글로벌 안전장치 (AC-04 / 리뷰 F-A)', () => {
  it('대상 미지정 + --yes/--dry-run 없음: 실제로 쓰지 않고 guarded=true, --yes 안내', () => {
    // fs 쓰기를 막아 실제 ~/.claude 는 절대 안 건드린다(테스트 안전망).
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const out = captureStdout(() => runSyncSkills({ json: true }));
    expect(writeSpy).not.toHaveBeenCalled(); // 라이브 글로벌 무쓰기
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
    const parsed = JSON.parse(out) as { guarded: boolean; skills: { action: string }[] };
    expect(parsed.guarded).toBe(true);
    expect(parsed.skills.every((s) => s.action !== 'written')).toBe(true); // 미리보기라 written 없음
  });

  it('대상 미지정 + --yes: 안전장치 해제(guarded=false)', () => {
    // --yes 면 실제로 쓰려 하므로 fs 쓰기를 막아 ~/.claude 를 보호한다.
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const out = captureStdout(() => runSyncSkills({ yes: true, json: true }));
    writeSpy.mockRestore();
    mkdirSpy.mockRestore();
    const parsed = JSON.parse(out) as { guarded: boolean };
    expect(parsed.guarded).toBe(false);
  });

  it('명시 --to: 안전장치와 무관하게 실제로 쓴다(guarded=false)', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    const out = captureStdout(() => runSyncSkills({ from, to, json: true }));
    const parsed = JSON.parse(out) as { guarded: boolean; skills: { action: string }[] };
    expect(parsed.guarded).toBe(false);
    expect(parsed.skills.some((s) => s.action === 'written')).toBe(true);
  });
});

describe('멱등 write-skip 스파이 (AC-04 / 리뷰 F-B)', () => {
  it('unchanged 재실행은 SKILL.md 에 writeFileSync 를 부르지 않는다', () => {
    const from = mkTmp('awl-sync-from-');
    const to = mkTmp('awl-sync-to-');
    seedEngineFixture(from);
    syncPipelineSkills({ from, to }); // 1회차: 쓴다
    const writeSpy = vi.spyOn(fs, 'writeFileSync');
    syncPipelineSkills({ from, to }); // 2회차: unchanged
    const wroteSkill = writeSpy.mock.calls.some((c) => String(c[0]).endsWith('SKILL.md'));
    writeSpy.mockRestore();
    expect(wroteSkill).toBe(false); // 항상-쓰기 뮤테이션이면 여기서 깨진다
  });
});
