import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { version as pkgVersion } from '../package.json';
import type { Caps } from '../src/core/tty.js';
import { BANNER, buildProgram, renderBanner, versionString } from '../src/program.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmpHomeWithEngine(engineVersion: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-ver-'));
  if (engineVersion !== null) {
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(home, 'engine', 'version.json'), JSON.stringify({ engineVersion }));
  }
  return home;
}

describe('awl 프로그램 구성', () => {
  it('버전 정보를 노출한다', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/^awl v\d+\.\d+\.\d+/);
  });

  it('배너에 핵심 문구가 담겨 있다', () => {
    expect(BANNER).toContain('Agent Work Loop');
    expect(BANNER).toContain('같은 실패를 두 번 하지 않게');
    expect(BANNER).toContain('awl 자체는 판단하지 않습니다');
    expect(BANNER).toContain('판단은 Claude Code 나 Codex 가 합니다');
  });

  it('유니코드 TTY 배너는 조밀한 AWL 워드마크와 색상을 쓴다', () => {
    const banner = renderBanner({ unicode: true, color: true, tty: true });
    expect(banner).toContain('███████');
    expect(banner).toContain('\x1b[');
  });

  it('배너는 좌측 워드마크와 우측 안내를 같은 행에 배치한다', () => {
    const banner = renderBanner({ unicode: false, color: false, tty: false });
    expect(banner.split('\n')[0]).toContain('Agent Work Loop');
    expect(banner.startsWith('\n')).toBe(false);
  });

  it('evolve 는 스킬 전용(숨김)이라 최상위 도움말에 안 보인다', () => {
    const program = buildProgram();
    // 'evolve' 를 부분 문자열로 포함하는 다른 명령이 없어 안전하게 단독 검사할 수 있다.
    expect(program.helpInformation()).not.toContain('evolve');
  });

  it('rules promote 는 사람이 치는 명령이라 rules 도움말에 보인다', () => {
    const program = buildProgram();
    const rulesCmd = program.commands.find((c) => c.name() === 'rules');
    expect(rulesCmd?.helpInformation()).toContain('promote');
  });

  it('gotchas 는 도움말에 보이고 deltas 는 폐기 예정이라 숨겨진다 (WI-O AC-01/03)', () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain('gotchas');
    // deltas 는 등록은 돼 있지만(하위호환) hidden:true 라 최상위 도움말엔 안 보인다.
    expect(program.helpInformation()).not.toContain('deltas');
    const deltasCmd = program.commands.find((c) => c.name() === 'deltas');
    expect(deltasCmd).toBeDefined();
  });

  it('metrics 는 사람이 치는 명령이라 도움말에 보인다 (WI-P AC-04)', () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain('metrics');
  });
});

const NO_COLOR: Caps = { unicode: false, color: false, tty: false };
const COLOR: Caps = { unicode: true, color: true, tty: true };

describe('versionString — engine 버전 표시', () => {
  it('엔진이 설치 안 됐으면 템플릿 미설치 경고를 보여준다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(null);
    const s = versionString(NO_COLOR);
    expect(s).toContain(`awl v${pkgVersion}`);
    expect(s).toContain('Engine Template: (설치되지 않음)');
    expect(s).toContain('[!]');
    expect(s).toContain('awl init');
  });

  it('엔진 버전이 같으면 CLI와 템플릿을 위계로 보여준다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(pkgVersion);
    expect(versionString(NO_COLOR)).toBe(
      `awl v${pkgVersion}\n    └── Engine Template: v${pkgVersion}`,
    );
  });

  it('엔진 버전이 다르면 경고와 awl init 안내를 보여준다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString(NO_COLOR);
    expect(s).toContain('Engine Template: v0.0.1');
    expect(s).toContain('[!]');
    expect(s).toContain('awl init');
  });

  it('색 미지원이면 ANSI 코드 없이 마커만 나온다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString(NO_COLOR);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 부재 확인용
    expect(/\x1b\[/.test(s)).toBe(false);
  });

  it('색 지원이면 ANSI 코드가 포함된다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString(COLOR);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 존재 확인용
    expect(/\x1b\[/.test(s)).toBe(true);
  });

  it('인자를 안 주면 현재 프로세스 능력을 기본값으로 쓴다(크래시 없음)', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(null);
    expect(() => versionString()).not.toThrow();
  });
});

// 빌드 산출물이 있을 때만 실제 CLI를 실행해 확인한다.
const distCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.runIf(existsSync(distCli))('빌드된 CLI 실행', () => {
  it('--version 이 버전을 출력한다', () => {
    const out = execFileSync('node', [distCli, '--version']).toString();
    expect(out.trim()).toMatch(/^awl v\d+\.\d+\.\d+/);
  });

  it('--help 가 배너를 출력한다', () => {
    const out = execFileSync('node', [distCli, '--help']).toString();
    expect(out).toContain('Agent Work Loop');
    expect(out).toContain('같은 실패를 두 번 하지 않게');
  });

  it('deltas 는 경고를 찍고 gotchas 와 동일한 내용을 보여준다 (WI-O AC-03, 하위호환)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-deltas-alias-'));
    fs.mkdirSync(path.join(home, 'gotchas'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'gotchas', 'G-001.json'),
      JSON.stringify({ id: 'G-001', lesson: '테스트 교훈', count: 1 }),
    );
    const result = spawnSync('node', [distCli, 'deltas', '--json'], {
      env: { ...process.env, AWL_HOME: home },
      encoding: 'utf8',
    });
    expect(result.stderr).toContain('폐기 예정');
    expect(result.stderr).toContain('awl gotchas');
    expect(JSON.parse(result.stdout)[0].lesson).toBe('테스트 교훈');
  });

  it('state set phase:loop 이 gate:1 기록 없이는 거부되고, 기록 후엔 통과한다 (WI-Q AC-02, program.ts 배선 확인)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-loop-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-loop-proj-'));
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    fs.writeFileSync(
      path.join(proj, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-Q', workitems: {} }),
    );
    const env = { ...process.env, AWL_HOME: home };

    const denied = spawnSync('node', [distCli, 'state', 'set', '--json', '{"phase":"loop"}'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('게이트 1');

    const gateRecord = spawnSync(
      'node',
      [
        distCli,
        'record',
        'gate',
        '--json',
        '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
      ],
      { cwd: proj, env, encoding: 'utf8' },
    );
    expect(gateRecord.status).toBe(0);

    const allowed = spawnSync('node', [distCli, 'state', 'set', '--json', '{"phase":"loop"}'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    });
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout).phase).toBe('loop');
  });

  it('현재 워크아이템이 없으면 다른 워크아이템의 gate:1 기록으로도 통과하지 않는다 (WI-Q 리뷰 지적 — fail-open 방지)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-noworkitem-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-noworkitem-proj-'));
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    // 현재 워크아이템(workitem 필드) 없이 state.json 만 있다.
    fs.writeFileSync(path.join(proj, '.awl', 'state.json'), JSON.stringify({ workitems: {} }));
    const env = { ...process.env, AWL_HOME: home };

    // 다른(과거) 워크아이템의 gate:1 은 기록해둔다 — 이게 새어 들어가면 안 된다.
    const gateRecord = spawnSync(
      'node',
      [
        distCli,
        'record',
        'gate',
        '--json',
        '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"],"workitem":"WI-OTHER"}',
      ],
      { cwd: proj, env, encoding: 'utf8' },
    );
    expect(gateRecord.status).toBe(0);

    const denied = spawnSync('node', [distCli, 'state', 'set', '--json', '{"phase":"loop"}'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('게이트 1');
  });

  it.each([
    ['CI=true', { CI: 'true' }],
    ['CI 없음', {}],
  ])(
    'stdin 파이프에서 init --yes 는 %s 여부와 무관하게 크래시 없이 끝난다 (WI-Y AC-05/AC-08, 회귀)',
    (_label, extraEnv) => {
      // 리뷰(rev_b9f3bb4b93ede055f5 finding #1) 지적 — 이 테스트는 raw-mode "회피"를
      // 검증하지 않는다. runInit 은 opts.yes===true 면 readline 조차 안 만들고 곧장
      // nonInteractiveInputs(순수 함수, stdin 미접근)로 직행해 selectSingle/
      // rawModeCapable 자체를 호출하지 않는다(src/commands/init.ts:1134-1143) —
      // CI 유무는 이 경로에 아무 영향이 없다. 그래서 CI 있음/없음 두 케이스를 나란히
      // 돌려 "둘 다 안전하게 끝난다"만 정직하게 확인한다. raw-mode 분기 자체의
      // true/false 커버리지는 AC-01~03(select.test.ts)과 AC-08(init.test.ts,
      // selectSingle/selectMulti 직접 단위테스트)의 몫이다.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-init-ci-home-'));
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-init-ci-proj-'));
      const env = { ...process.env, ...extraEnv, AWL_HOME: home };

      const result = spawnSync('node', [distCli, 'init', '--yes'], {
        cwd: proj,
        env,
        encoding: 'utf8',
        input: '', // stdin 을 파이프로 연결한다(TTY 아님)
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      const configPath = path.join(proj, '.awl', 'config.json');
      expect(existsSync(configPath)).toBe(true);
    },
  );
});
