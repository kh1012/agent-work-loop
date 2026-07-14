import { execFileSync } from 'node:child_process';
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
});
