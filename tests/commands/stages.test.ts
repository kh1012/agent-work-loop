import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyProfileSkills } from '../../src/commands/profile.js';
import { renderStagesFull, renderStagesShort, runStages } from '../../src/commands/stages.js';
import { caps } from '../../src/core/tty.js';

const origCwd = process.cwd();

afterEach(() => {
  process.chdir(origCwd);
});

function project(skills: Partial<Record<string, unknown>> = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-stages-')));
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.awl', 'profile.json'),
    JSON.stringify({ name: 'p', skills: { ...emptyProfileSkills(), ...skills } }),
  );
  return root;
}

describe('renderStagesShort — 다섯 줄(WI-G14)', () => {
  it('정확히 다섯 줄이고 말할 때 쓰는 이름(setup·spec·tickets·implement·verify)을 담는다', () => {
    const lines = renderStagesShort().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain('setup');
    expect(lines[1]).toContain('spec');
    expect(lines[2]).toContain('tickets');
    expect(lines[3]).toContain('implement');
    expect(lines[4]).toContain('verify');
  });
});

describe('renderStagesFull — 요청 층/티켓 층 분리(WI-G14)', () => {
  it('요청 층과 티켓 층이 나뉘어 나오고 게이트 1~4 가 모두 표시된다', () => {
    const profile = { name: 'p', skills: emptyProfileSkills() };
    const out = renderStagesFull(profile, caps());
    expect(out).toContain('요청 층');
    expect(out).toContain('티켓 층');
    expect(out).toContain('게이트 1');
    expect(out).toContain('게이트 2');
    expect(out).toContain('게이트 3');
    expect(out).toContain('게이트 4');
  });

  it('프로파일에 꽂힌 스킬 이름이 해당 자리에 나온다', () => {
    const profile = {
      name: 'p',
      skills: {
        ...emptyProfileSkills(),
        implement: { type: 'external' as const, url: 'https://example.com/tdd', name: 'tdd' },
      },
    };
    const out = renderStagesFull(profile, caps());
    expect(out).toContain('external: https://example.com/tdd');
  });

  it('스킬이 없는 자리는 (없음)으로 나온다', () => {
    const profile = { name: 'p', skills: emptyProfileSkills() };
    const out = renderStagesFull(profile, caps());
    expect(out).toContain('(없음)');
  });
});

describe('runStages — CLI', () => {
  it('--short 는 renderStagesShort 와 같은 다섯 줄을 stdout 에 낸다', async () => {
    const root = project();
    process.chdir(root);
    let stdout = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    await runStages({ short: true });
    spy.mockRestore();
    expect(stdout.trim().split('\n')).toHaveLength(5);
  });

  it('--json 은 기계가 읽을 수 있는 형태를 낸다', async () => {
    const root = project();
    process.chdir(root);
    let stdout = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });
    await runStages({ json: true });
    spy.mockRestore();
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('profile.json 이 없으면 에러로 거부한다', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-stages-noprofile-')));
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    process.chdir(root);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(runStages({})).rejects.toThrow('exit:1');
    exitSpy.mockRestore();
  });
});
