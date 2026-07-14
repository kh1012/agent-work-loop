import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BANNER, buildProgram } from '../src/program.js';

describe('awl 프로그램 구성', () => {
  it('버전 정보를 노출한다', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
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

// 빌드 산출물이 있을 때만 실제 CLI를 실행해 확인한다.
const distCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.runIf(existsSync(distCli))('빌드된 CLI 실행', () => {
  it('--version 이 버전을 출력한다', () => {
    const out = execFileSync('node', [distCli, '--version']).toString();
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('--help 가 배너를 출력한다', () => {
    const out = execFileSync('node', [distCli, '--help']).toString();
    expect(out).toContain('Agent Work Loop');
    expect(out).toContain('같은 실패를 두 번 하지 않게');
  });
});
