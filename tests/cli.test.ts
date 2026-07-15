import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { version as pkgVersion } from '../package.json';
import { BANNER, buildProgram, versionString } from '../src/program.js';

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
    expect(program.version()).toMatch(/^awl \d+\.\d+\.\d+/);
  });

  it('배너에 핵심 문구가 담겨 있다', () => {
    expect(BANNER).toContain('Agent Work Loop');
    expect(BANNER).toContain('같은 실패를 두 번 하지 않게');
    expect(BANNER).toContain('awl 자체는 판단하지 않습니다');
    expect(BANNER).toContain('판단은 Claude Code 나 Codex 가 합니다');
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

describe('versionString — engine 버전 표시', () => {
  it('엔진이 설치 안 됐으면 패키지 버전만', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(null);
    expect(versionString()).toBe(`awl ${pkgVersion}`);
  });

  it('엔진 버전이 같으면 나란히 보여준다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(pkgVersion);
    expect(versionString()).toBe(`awl ${pkgVersion} (engine ${pkgVersion})`);
  });

  it('엔진 버전이 다르면 경고한다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString();
    expect(s).toContain('engine 0.0.1');
    expect(s).toContain('버전이 다릅니다');
    expect(s).toContain('awl init');
  });
});

// 빌드 산출물이 있을 때만 실제 CLI를 실행해 확인한다.
const distCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.runIf(existsSync(distCli))('빌드된 CLI 실행', () => {
  it('--version 이 버전을 출력한다', () => {
    const out = execFileSync('node', [distCli, '--version']).toString();
    expect(out.trim()).toMatch(/^awl \d+\.\d+\.\d+/);
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
});
