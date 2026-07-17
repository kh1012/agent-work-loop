import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gatherVersionInputs, renderVersionCheck } from '../../src/commands/version-check.js';
import { caps } from '../../src/core/tty.js';

const origCwd = process.cwd();
const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('gatherVersionInputs — 실제 값 수집 (WI-X AC-03)', () => {
  it('projectRoot 가 null 이면(프로젝트 밖) 프로젝트/스킬 값은 전부 null', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const inputs = gatherVersionInputs(null);
    expect(inputs.projectEngineVersion).toBeNull();
    expect(inputs.installedSkillVersions).toEqual({ claude: null, codex: null });
  });

  it('프로젝트 config.json 의 engineVersion 을 읽는다', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const proj = tmp('awl-vc-proj-');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({ engineVersion: '0.3.1' }),
    );
    const inputs = gatherVersionInputs(proj);
    expect(inputs.projectEngineVersion).toBe('0.3.1');
  });

  it('config.json 이 없으면 projectEngineVersion 은 null(크래시 없음)', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const proj = tmp('awl-vc-proj-');
    const inputs = gatherVersionInputs(proj);
    expect(inputs.projectEngineVersion).toBeNull();
  });

  it('.awl/skills-version.json 을 읽어 claude/codex 각각의 버전을 돌려준다', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const proj = tmp('awl-vc-proj-');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'skills-version.json'),
      JSON.stringify({ claude: '0.4.5' }),
    );
    const inputs = gatherVersionInputs(proj);
    expect(inputs.installedSkillVersions.claude).toBe('0.4.5');
    expect(inputs.installedSkillVersions.codex).toBeNull();
  });

  it('skills-version.json 이 없으면 둘 다 null(크래시 없음)', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const proj = tmp('awl-vc-proj-');
    const inputs = gatherVersionInputs(proj);
    expect(inputs.installedSkillVersions).toEqual({ claude: null, codex: null });
  });

  it('설치된 엔진(AWL_HOME/engine/version.json)을 읽는다', () => {
    const home = tmp('awl-vc-home-');
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'engine', 'version.json'),
      JSON.stringify({ engineVersion: '0.9.9' }),
    );
    process.env.AWL_HOME = home;
    const inputs = gatherVersionInputs(null);
    expect(inputs.installedEngineVersion).toBe('0.9.9');
  });

  it('설치된 엔진이 없으면(scaffoldGlobal 전) installedEngineVersion 은 null', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const inputs = gatherVersionInputs(null);
    expect(inputs.installedEngineVersion).toBeNull();
  });

  it('packageVersion 은 실제 package.json 의 버전 문자열이다', () => {
    process.env.AWL_HOME = tmp('awl-vc-home-');
    const inputs = gatherVersionInputs(null);
    expect(inputs.packageVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('renderVersionCheck — 사람용 출력 (WI-X AC-03)', () => {
  it('전부 일치하면 초록색 안내만 보여준다', () => {
    const text = renderVersionCheck(
      { ok: true, mismatches: [] },
      { unicode: false, color: false, tty: false },
    );
    expect(text).toContain('일치');
  });

  it('불일치가 있으면 [!] 마커와 hint 를 보여준다', () => {
    const text = renderVersionCheck(
      {
        ok: false,
        mismatches: [
          { kind: 'project-vs-engine', a: '0.3.1', b: '0.5.0', hint: 'awl update 를 실행하세요' },
        ],
      },
      { unicode: false, color: false, tty: false },
    );
    expect(text).toContain('[!]');
    expect(text).toContain('project-vs-engine');
    expect(text).toContain('awl update 를 실행하세요');
  });

  it('색 미지원(caps.color=false)이면 ANSI 코드 없이 마커만 나온다', () => {
    const text = renderVersionCheck(
      { ok: false, mismatches: [{ kind: 'build', a: 'x', b: 'y', hint: 'h' }] },
      { unicode: false, color: false, tty: false },
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 부재 확인용
    expect(/\x1b\[/.test(text)).toBe(false);
    expect(text).toContain('[!]');
  });

  it('색 지원이면 불일치 버전 값(a/b)을 emphasis(bold)로 감싼다 (cli-visual-consistency AC-08, 리뷰)', () => {
    const text = renderVersionCheck(
      { ok: false, mismatches: [{ kind: 'build', a: 'x', b: 'y', hint: 'h' }] },
      { unicode: true, color: true, tty: true },
    );
    // 값 강조가 실효하는지 — signal(warn)만으론 만족 못 하는 특정 emphasis 단언(emphasis 제거 시 실패).
    expect(text).toContain('\x1b[1mx\x1b[0m'); // a=bold
    expect(text).toContain('\x1b[1my\x1b[0m'); // b=bold
  });

  it('현재 프로세스 caps() 로도 크래시 없이 렌더된다', () => {
    expect(() => renderVersionCheck({ ok: true, mismatches: [] }, caps())).not.toThrow();
  });
});
