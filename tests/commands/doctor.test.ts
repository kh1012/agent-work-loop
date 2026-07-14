import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Check, collectChecks, renderText } from '../../src/commands/doctor.js';
import { stringWidth } from '../../src/core/tty.js';

const ASCII = { unicode: false, color: false, tty: false };
const UNICODE = { unicode: true, color: true, tty: true };

const origCwd = process.cwd();
const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** engine/version.json, 규칙, 교훈, 프로젝트 목록을 갖춘 "설치됨" AWL_HOME */
function makeInstalledHome(): string {
  const home = tmp('awl-home-');
  fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'engine', 'version.json'),
    JSON.stringify({ engineVersion: '0.0.0' }),
  );
  fs.mkdirSync(path.join(home, 'rules', 'active'), { recursive: true });
  fs.writeFileSync(path.join(home, 'rules', 'active', 'r1.md'), 'x');
  fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify(['a', 'b']));
  return home;
}

/** .git + .awl/config.json(verify 포함)을 갖춘 "설치됨" 프로젝트 */
function makeInstalledProject(): string {
  const proj = tmp('awl-proj-');
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
  fs.writeFileSync(
    path.join(proj, '.awl', 'config.json'),
    JSON.stringify({
      engineVersion: '0.0.0',
      verify: {
        test: { cmd: 'node --version', env: { NODE_ENV: 'test' } },
        lint: { cmd: 'nonexistent_tool_zzz .' },
        // 설정하지 않은 검증(null)이 있어도 doctor 는 크래시하지 않아야 한다.
        e2e: null,
      },
    }),
  );
  return proj;
}

function find(checks: Check[], name: string): Check | undefined {
  return checks.find((c) => c.name === name);
}

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('collectChecks — 아무것도 없는 상태', () => {
  beforeEach(() => {
    process.env.AWL_HOME = path.join(os.tmpdir(), `awl-none-${process.pid}-${Date.now()}`);
    process.chdir(tmp('awl-lonely-')); // .git/.awl 없는 고립 디렉토리
  });

  it('크래시 없이 없음들을 보여주고 ok=false', async () => {
    const report = await collectChecks();
    expect(report.ok).toBe(false);
    expect(find(report.checks, '~/.awl')?.status).toBe('missing');
    // 프로젝트 루트를 못 찾아도 크래시하지 않는다.
    expect(find(report.checks, '프로젝트 루트')?.status).toBe('info');
    // 에이전트 그룹은 항상 존재한다.
    expect(find(report.checks, 'awl 스킬')).toBeDefined();
  });
});

describe('collectChecks — 설치됨 흉내', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
    process.chdir(makeInstalledProject());
  });

  it('전역/프로젝트가 정상으로 잡히고, 없는 검증 명령만 문제로 남는다', async () => {
    const report = await collectChecks();

    expect(find(report.checks, '~/.awl')?.status).toBe('ok');
    expect(find(report.checks, '엔진 버전')?.value).toBe('0.0.0');
    expect(find(report.checks, '규칙')?.value).toBe('1개');
    expect(find(report.checks, '프로젝트')?.value).toBe('2개');
    expect(find(report.checks, 'config.json')?.status).toBe('ok');
    expect(find(report.checks, '엔진 버전 일치')?.status).toBe('ok');

    // 검증 명령: node 는 존재(ok), 없는 명령은 missing 으로 구분
    expect(find(report.checks, '검증: test')?.status).toBe('ok');
    expect(find(report.checks, '검증: lint')?.status).toBe('missing');

    // 없는 검증 명령 하나 때문에 ok=false
    expect(report.ok).toBe(false);
  });

  it('검증 명령 확인은 빠르다(전체 테스트를 돌리지 않는다)', async () => {
    const start = Date.now();
    await collectChecks();
    // --version 만 확인하므로 넉넉히 잡아도 빨라야 한다.
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe('collectChecks — verify.*.cwd 점검 (WI-B, 모노레포)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
  });

  it('cwd 디렉토리가 실제로 있으면 ok', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        engineVersion: '0.0.0',
        verify: { test: { cmd: 'node --version', cwd: 'packages/app' }, lint: null, e2e: null },
      }),
    );
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, '검증: test')?.status).toBe('ok');
  });

  it('cwd 디렉토리가 없으면 missing 으로 표시하고 안내한다', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        engineVersion: '0.0.0',
        verify: { test: { cmd: 'node --version', cwd: 'no/such/dir' }, lint: null, e2e: null },
      }),
    );
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '검증: test');
    expect(check?.status).toBe('missing');
    expect(check?.hint).toContain('no/such/dir');
    expect(report.ok).toBe(false);
  });

  it('cwd 가 디렉토리가 아니라 파일이면 missing 으로 표시한다 (AC-07, 리뷰 지적 — verify.ts/config.ts 와 판정 기준 일치)', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'not-a-dir.txt'), 'x'); // 파일(디렉토리 아님)
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        engineVersion: '0.0.0',
        verify: { test: { cmd: 'node --version', cwd: 'not-a-dir.txt' }, lint: null, e2e: null },
      }),
    );
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '검증: test');
    expect(check?.status).toBe('missing');
    expect(report.ok).toBe(false);
  });
});

describe('renderText — 정렬과 출력', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
    process.chdir(makeInstalledProject());
  });

  it('ASCII 모드에서 status 마커가 같은 표시폭 컬럼에서 시작한다(한글 섞여도 정렬)', async () => {
    const report = await collectChecks();
    const text = renderText(report, ASCII);

    const statusCol = (line: string): number | null => {
      let idx = line.lastIndexOf('-> ');
      if (idx === -1) {
        if (/ ok$/.test(line)) {
          idx = line.length - 2;
        } else {
          return null;
        }
      }
      return stringWidth(line.slice(0, idx));
    };

    const cols = text
      .split('\n')
      .map(statusCol)
      .filter((x): x is number => x !== null);

    expect(cols.length).toBeGreaterThan(1);
    // 모든 status 마커가 같은 컬럼에서 시작해야 정렬이 안 깨진 것이다.
    expect(new Set(cols).size).toBe(1);
  });

  it('ASCII 모드는 ANSI 색 코드를 넣지 않는다', async () => {
    const report = await collectChecks();
    const text = renderText(report, ASCII);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape 검출 목적
    expect(/\x1b\[/.test(text)).toBe(false);
    expect(text).toContain('Agent Work Loop');
  });

  it('유니코드+색 모드는 ANSI 색 코드를 넣는다', async () => {
    const report = await collectChecks();
    const text = renderText(report, UNICODE);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape 검출 목적
    expect(/\x1b\[/.test(text)).toBe(true);
  });
});

describe('--json 출력', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
    process.chdir(makeInstalledProject());
  });

  it('report 는 유효한 JSON으로 직렬화/역직렬화된다', async () => {
    const report = await collectChecks();
    const json = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(report.ok);
    expect(Array.isArray(parsed.checks)).toBe(true);
    // 명세 형태: group/name/status 필수, value/hint 선택
    for (const c of parsed.checks) {
      expect(typeof c.group).toBe('string');
      expect(typeof c.name).toBe('string');
      expect(typeof c.status).toBe('string');
    }
  });
});
