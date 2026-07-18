import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Check,
  collectChecks,
  computeFileSizeOutliers,
  detectNamingConvention,
  detectRecordTrailGap,
  renderText,
} from '../../src/commands/doctor.js';
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
    // 에이전트 그룹은 항상 존재한다 (WI-X: claude/codex 각각 독립 체크로 분리).
    expect(find(report.checks, 'Claude 스킬 버전')).toBeDefined();
    expect(find(report.checks, 'Codex 스킬 버전')).toBeDefined();
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

  it('교훈 카운트를 gotchas/ 에서 센다 (B1: 예전엔 lessons/ 를 봐서 늘 0개로 오보)', async () => {
    const home = process.env.AWL_HOME as string;
    fs.mkdirSync(path.join(home, 'gotchas'), { recursive: true });
    fs.writeFileSync(path.join(home, 'gotchas', 'G-001.json'), '{}');
    fs.writeFileSync(path.join(home, 'gotchas', 'G-002.json'), '{}');
    fs.writeFileSync(path.join(home, 'gotchas', 'G-003.json'), '{}');
    const report = await collectChecks();
    expect(find(report.checks, '교훈')?.value).toBe('3개');
  });

  it('교훈은 .json 만 센다 — 비-json 아티팩트는 제외해 awl gotchas 와 카운트가 일치 (검증 세션 후속)', async () => {
    const home = process.env.AWL_HOME as string;
    fs.mkdirSync(path.join(home, 'gotchas'), { recursive: true });
    fs.writeFileSync(path.join(home, 'gotchas', 'G-001.json'), '{}');
    fs.writeFileSync(path.join(home, 'gotchas', 'G-002.json'), '{}');
    // gotchasDir 에 섞일 수 있는 비-json 아티팩트(백업/메모 등)는 세지 않는다.
    fs.writeFileSync(path.join(home, 'gotchas', 'notes.txt'), 'x');
    fs.writeFileSync(path.join(home, 'gotchas', 'G-001.json.bak'), '{}');
    const report = await collectChecks();
    expect(find(report.checks, '교훈')?.value).toBe('2개');
  });

  it('최근 활동(records 시각 + state mtime)을 info 로 표시한다 (concurrency-1 AC-02)', async () => {
    const home = process.env.AWL_HOME as string;
    fs.mkdirSync(path.join(home, 'records'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'records', '2026-07.jsonl'),
      `${JSON.stringify({ id: 'rec_x', at: '2026-07-16T10:30:00.000Z', type: 'audit' })}\n`,
    );
    fs.writeFileSync(
      path.join(process.cwd(), '.awl', 'state.json'),
      JSON.stringify({ phase: 'loop' }),
    );

    const report = await collectChecks();
    const check = find(report.checks, '최근 활동');
    expect(check?.status).toBe('info'); // 사실만 — warn 이 아니라 종료코드 불변
    expect(check?.value).toContain('2026-07-16 10:30'); // 최근 기록 시각
  });

  it('records·state 가 없으면 최근 활동 check 를 만들지 않는다 (concurrency-1 AC-02)', async () => {
    // beforeEach 의 makeInstalledHome 은 records/ 가 없고 makeInstalledProject 는 state.json 이 없다.
    const report = await collectChecks();
    expect(find(report.checks, '최근 활동')).toBeUndefined();
  });

  it('live state.lock 이 있으면 다른 세션 토큰을 warn 으로 표시한다 (concurrency-3 AC-03)', async () => {
    fs.writeFileSync(
      path.join(process.cwd(), '.awl', 'state.lock'),
      JSON.stringify({ token: 'proc-999', at: new Date().toISOString() }),
    );
    const report = await collectChecks();
    const check = find(report.checks, '최근 활동');
    expect(check?.status).toBe('warn'); // live 락 = 다른 세션이 지금 쓰는 중
    expect(check?.value).toContain('다른 세션이 state 쓰는 중');
    expect(check?.value).toContain('proc-999');
    // warn 이어도 doctor 종료코드(problems)에는 안 걸린다.
    const problems = report.checks.filter((c) => c.status === 'missing' || c.status === 'fail');
    expect(problems.some((c) => c.name === '최근 활동')).toBe(false);
  });
});

describe('collectChecks — 프로젝트 루트/브랜치 표시 (WI-C)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
  });

  it('프로젝트 루트를 찾았을 때 실제 경로를 보여준다 (AC-01, 지금은 못 찾았을 때만 보였다)', async () => {
    const proj = fs.realpathSync(makeInstalledProject());
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '프로젝트 루트');
    expect(check?.status).toBe('info');
    expect(check?.value).toBe(proj);
  });

  it('실제 git 저장소면 현재 브랜치명을 보여준다 (AC-02)', async () => {
    const proj = fs.realpathSync(tmp('awl-proj-git-'));
    execFileSync('git', ['init', '-q', '-b', 'feature/wi-c-test'], { cwd: proj });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        engineVersion: '0.0.0',
        verify: { typecheck: null, lint: null, test: null, e2e: null },
      }),
    );
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '브랜치');
    expect(check?.status).toBe('info');
    expect(check?.value).toBe('feature/wi-c-test');
  });

  it('git 저장소가 아니면(.awl 만 있는 프로젝트) 크래시 없이 안내한다 (AC-02)', async () => {
    // makeInstalledProject 의 .git 은 findProjectRoot 용 가짜 빈 디렉토리라 실제 git 저장소가 아니다.
    const proj = fs.realpathSync(makeInstalledProject());
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '브랜치');
    expect(check?.status).toBe('info');
    expect(check?.value).toMatch(/알 수 없음/);
  });

  it('브랜치 조회 실패 안내 문구가 특정 원인(git 아님)으로 단정하지 않는다 (AC-03, 리뷰 지적 — detached HEAD 등 다른 원인도 있다)', async () => {
    const proj = fs.realpathSync(makeInstalledProject());
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '브랜치');
    // "git 저장소가 아니거나" 처럼 하나의 원인으로 단정하지 않는다 — detached HEAD 등도
    // 같은 경로로 떨어지므로 원인을 특정하지 않는 문구여야 한다.
    expect(check?.value).not.toMatch(/저장소가 아니거나/);
    expect(check?.value).toBe('알 수 없음 (확인 실패)');
  });

  it('projectRoot 는 찾았지만 config.json 은 없을 때(awl init 이전)도 두 체크가 안전하다 (AC-04, 리뷰 지적 — 전용 회귀 테스트 부재)', async () => {
    const proj = fs.realpathSync(tmp('awl-proj-noconfig-'));
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true }); // config.json 은 안 만든다
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, '프로젝트 루트')).toEqual({
      group: '이 프로젝트',
      name: '프로젝트 루트',
      status: 'info',
      value: proj,
    });
    expect(find(report.checks, '브랜치')?.status).toBe('info');
    expect(find(report.checks, 'config.json')?.status).toBe('missing');
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

    const rows = text.split('\n');
    // 이제 표 형식이 아니라 트리 형식이다. 긴 경로 하나가 카드 전체 폭을
    // 키우지 않도록 모든 행을 고정 상한 안에 넣는다.
    expect(rows.every((line) => stringWidth(line) <= 100)).toBe(true);
    // 트리 글리프도 ASCII 로 degrade 한다(예전엔 테두리만 ASCII, 트리는 유니코드 잔존).
    expect(text).toContain('|--');
    expect(text).not.toContain('├──');
  });

  it('ASCII 모드는 ANSI 색 코드를 넣지 않는다', async () => {
    const report = await collectChecks();
    const text = renderText(report, ASCII);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape 검출 목적
    expect(/\x1b\[/.test(text)).toBe(false);
    expect(text).toContain('Agent Work Loop');
  });

  it('색 모드에서 체크 값(value)을 emphasis(bold)로 강조한다 (cli-visual-consistency AC-07, 리뷰)', () => {
    const report = {
      ok: true,
      checks: [{ group: '환경', name: '항목', status: 'ok', value: '테스트값' } as Check],
    };
    const text = renderText(report, UNICODE);
    // 값이 bold 로 감싸진다 — clipToWidth 가 색을 보존하므로 emphasis 가 살아남는다.
    expect(text).toContain('\x1b[1m테스트값\x1b[0m');
    // 색 없음이면 emphasis 는 no-op(평문).
    expect(renderText(report, ASCII)).toContain('테스트값');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 부재 확인
    expect(/\x1b\[/.test(renderText(report, ASCII))).toBe(false);
  });

  it('유니코드+색 모드는 ANSI 색 코드를 넣는다', async () => {
    const report = await collectChecks();
    const text = renderText(report, UNICODE);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape 검출 목적
    expect(/\x1b\[/.test(text)).toBe(true);
  });

  it('warn 은 [!], fail/missing 은 [x] 로 색 없이도 구분된다', async () => {
    const report = await collectChecks();
    const text = renderText(report, ASCII);
    // makeInstalledProject 는 lint 검증 명령이 없어(missing) [x] 가 반드시 하나 있다.
    expect(text).toContain('[x]');
  });
});

describe('collectChecks — 버전 4쌍 (WI-X)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome(); // engine 0.0.0
  });

  it('프로젝트 config.engineVersion 이 설치된 엔진과 다르면 엔진 버전 일치가 warn 이고 [!] 힌트에 awl init --yes 를 안내한다', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({ engineVersion: '0.0.1', verify: {} }),
    );
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '엔진 버전 일치');
    expect(check?.status).toBe('warn');
    expect(check?.hint).toContain('awl init --yes');
  });

  it('스킬 미설치면 Claude/Codex 스킬 버전 둘 다 warn', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, 'Claude 스킬 버전')?.status).toBe('warn');
    expect(find(report.checks, 'Codex 스킬 버전')?.status).toBe('warn');
  });

  it('설치된 스킬 버전이 엔진과 다르면 warn, 같으면 ok', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'awl-loop'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'skills-version.json'),
      JSON.stringify({ claude: '0.0.1' }), // 설치된 엔진(0.0.0)과 다름
    );
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, 'Claude 스킬 버전')?.status).toBe('warn');
  });

  it('스킬 버전이 엔진과 같으면 ok', async () => {
    const proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.claude', 'skills', 'awl-loop'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'skills-version.json'),
      JSON.stringify({ claude: '0.0.0' }), // 설치된 엔진(0.0.0)과 일치
    );
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, 'Claude 스킬 버전')?.status).toBe('ok');
  });
});

describe('collectChecks — 워킹트리 더러움 점검 (WI-F, 환경이 준 git 요약을 안 믿는다)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
  });

  function realGitProject(): string {
    const proj = fs.realpathSync(tmp('awl-proj-git-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        engineVersion: '0.0.0',
        verify: { typecheck: null, lint: null, test: null, e2e: null },
      }),
    );
    // 실제 awl init 처럼 .awl/config.json 은 커밋 대상, .awl/state.json 은 무시 대상이다.
    fs.writeFileSync(path.join(proj, '.gitignore'), '.awl/state.json\n');
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    return proj;
  }

  it('클린한 워킹트리는 ok', async () => {
    const proj = realGitProject();
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '워킹트리');
    expect(check?.status).toBe('ok');
  });

  it('더러운 워킹트리(수정+untracked)는 warn 으로 파일 수를 알린다', async () => {
    const proj = realGitProject();
    fs.appendFileSync(path.join(proj, 'f.txt'), 'dirty\n');
    fs.writeFileSync(path.join(proj, 'new.txt'), 'new\n');
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '워킹트리');
    expect(check?.status).toBe('warn');
    expect(check?.value).toContain('2');
    expect(check?.hint).toContain('f.txt');
  });

  it('git 저장소가 아니면 크래시 없이 info 로 넘어간다', async () => {
    const proj = fs.realpathSync(makeInstalledProject()); // .git 이 가짜 빈 디렉토리
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '워킹트리');
    expect(check?.status).toBe('info');
  });

  it('한글 등 비ASCII 파일명이 이스케이프 없이 그대로 힌트에 나온다 (AC-07, 리뷰 지적)', async () => {
    const proj = realGitProject();
    fs.writeFileSync(path.join(proj, '새파일.txt'), '새 파일\n');
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '워킹트리');
    expect(check?.status).toBe('warn');
    expect(check?.hint).toContain('새파일.txt');
    expect(check?.hint).not.toContain('\\');
  });

  it('rename 된 파일도 원래 경로가 끼어들지 않고 새 경로만 하나로 잡힌다 (AC-07, -z 포맷의 두-경로 레코드)', async () => {
    const proj = realGitProject();
    execFileSync('git', ['mv', 'f.txt', 'renamed.txt'], { cwd: proj });
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '워킹트리');
    expect(check?.status).toBe('warn');
    expect(check?.value).toContain('1');
    expect(check?.hint).toContain('renamed.txt');
    expect(check?.hint).not.toContain('f.txt');
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

describe('detectNamingConvention (WI-I AC-01) — 세어서 감지, 강제 안 함', () => {
  it('kebab-case 가 뚜렷한 다수면 감지한다', () => {
    const r = detectNamingConvention([
      'foo-bar.ts',
      'baz-qux.ts',
      'a-b-c.ts',
      'single.ts', // ambiguous, decisiveTotal 에 안 들어감
    ]);
    expect(r.convention).toBe('kebab-case');
    expect(r.reason).toBe('detected');
  });

  it('camelCase 가 뚜렷한 다수면 감지한다', () => {
    const r = detectNamingConvention(['fooBar.ts', 'bazQux.ts', 'aBC.ts']);
    expect(r.convention).toBe('camelCase');
  });

  it('snake_case 가 뚜렷한 다수면 감지한다', () => {
    const r = detectNamingConvention(['foo_bar.ts', 'baz_qux.py', 'a_b_c.go']);
    expect(r.convention).toBe('snake_case');
  });

  it('PascalCase 가 뚜렷한 다수면 감지한다', () => {
    const r = detectNamingConvention(['FooBar.tsx', 'BazQux.tsx', 'ABC.tsx']);
    expect(r.convention).toBe('PascalCase');
  });

  it('컨벤션이 섞여 있으면(뚜렷한 다수 없음) 혼재로 보고하고 강제로 하나를 고르지 않는다', () => {
    const r = detectNamingConvention(['foo-bar.ts', 'baz_qux.ts', 'fooBar.ts', 'FooBar.ts']);
    expect(r.convention).toBeNull();
    expect(r.reason).toBe('mixed');
  });

  it('판단할 파일이 너무 적으면(단일 단어뿐 등) 판단을 보류한다', () => {
    const r = detectNamingConvention(['index.ts', 'main.ts']);
    expect(r.convention).toBeNull();
    expect(r.reason).toBe('insufficient_data');
  });

  it('기존 이름이 컨벤션에 맞는지는 검사/거부하지 않는다 — 사실만 센다(lint 중복 금지)', () => {
    const r = detectNamingConvention([
      'foo-bar.ts',
      'baz-qux.ts',
      'a-b.ts',
      'c-d.ts',
      'oops_snake.ts', // 컨벤션에 안 맞는 파일이 하나 섞여 있어도 에러/경고 없음.
    ]);
    // 위반이라고 에러/경고를 내지 않는다. 그냥 다수결로 감지만 한다.
    expect(r.convention).toBe('kebab-case');
    expect(r).not.toHaveProperty('violations');
  });
});

describe('computeFileSizeOutliers (WI-I AC-02) — 임계값은 실제 분포에서 도출, warn only', () => {
  it('임계값을 실행 시점 분포에서 계산해, 그보다 큰 파일만 outlier 로 잡는다(하드코딩 매직넘버 없음)', () => {
    const files = [
      { path: 'a.ts', lines: 10 },
      { path: 'b.ts', lines: 20 },
      { path: 'c.ts', lines: 30 },
      { path: 'd.ts', lines: 40 },
      { path: 'e.ts', lines: 50 },
      { path: 'f.ts', lines: 60 },
      { path: 'g.ts', lines: 70 },
      { path: 'h.ts', lines: 80 },
      { path: 'i.ts', lines: 90 },
      { path: 'huge.ts', lines: 10000 }, // 압도적으로 큰 이상치 하나.
    ];
    const r = computeFileSizeOutliers(files);
    expect(r.threshold).not.toBeNull();
    expect(r.outliers.map((o) => o.path)).toEqual(['huge.ts']);
  });

  it('전부 비슷한 크기면 outlier 가 없다 — 실패시키지 않는다(warn only 이므로 outlier 0 이 정상)', () => {
    const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, lines: 100 + i }));
    const r = computeFileSizeOutliers(files);
    expect(r.outliers).toEqual([]);
  });

  it('판단할 파일이 너무 적으면 threshold 를 계산하지 않는다(판단 보류)', () => {
    const files = [
      { path: 'a.ts', lines: 10 },
      { path: 'b.ts', lines: 2000 },
    ];
    const r = computeFileSizeOutliers(files);
    expect(r.threshold).toBeNull();
    expect(r.outliers).toEqual([]);
  });
});

describe('collectChecks — 파일 크기 통합 (WI-I AC-02)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
  });

  it('실제 프로젝트에서 유난히 큰 파일 하나를 warn 으로 잡는다(다른 파일은 안 건드림)', async () => {
    const proj = makeInstalledProject();
    const src = path.join(proj, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(src, `f${i}.ts`), `${'line\n'.repeat(20 + i)}`);
    }
    fs.writeFileSync(path.join(src, 'huge.ts'), 'line\n'.repeat(5000));
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '파일 크기');
    expect(check?.status).toBe('warn');
    expect(check?.hint).toContain('huge.ts');
  });

  it('전부 작은 파일이면 이상치 없음(ok)', async () => {
    const proj = makeInstalledProject();
    const src = path.join(proj, 'src');
    fs.mkdirSync(src, { recursive: true });
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(src, `f${i}.ts`), `${'line\n'.repeat(20 + i)}`);
    }
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '파일 크기');
    expect(check?.status).toBe('ok');
  });
});

describe('collectChecks — state.json 비대·워크트리 잔존 경고 (피드백 F-1/F-5)', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeInstalledHome();
  });

  it('state.json 이 1MB 를 넘으면 warn 으로 잡는다', async () => {
    const proj = makeInstalledProject();
    // 형식은 유효 JSON 을 유지한 채로 1MB 를 넘긴다.
    const big = { phase: 'loop', junk: 'x'.repeat(1024 * 1024 + 16) };
    fs.writeFileSync(path.join(proj, '.awl', 'state.json'), JSON.stringify(big));
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, 'state.json 크기');
    expect(check?.status).toBe('warn');
    expect(check?.value).toContain('MB');
  });

  it('정상 크기 state.json 은 크기 경고를 내지 않는다', async () => {
    const proj = makeInstalledProject();
    fs.writeFileSync(path.join(proj, '.awl', 'state.json'), JSON.stringify({ phase: 'loop' }));
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, 'state.json 크기')).toBeUndefined();
  });

  it('.awl-worktrees/ 에 워크트리가 남아 있으면 warn 으로 잡는다', async () => {
    const proj = makeInstalledProject();
    fs.mkdirSync(path.join(proj, '.awl-worktrees', 'WI8'), { recursive: true });
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, '워크트리 잔존');
    expect(check?.status).toBe('warn');
    expect(check?.value).toContain('1');
  });
});

describe('detectRecordTrailGap (record-trail-guard AC-01) — 순수 판정', () => {
  it('커밋 이력 있음 + 활성 워크아이템 없음 + gate/attempt record 0건 = 공백(true)', () => {
    expect(
      detectRecordTrailGap({ hasCommits: true, activeWorkitem: null, gateAttemptRecords: 0 }),
    ).toBe(true);
  });

  it('커밋이 없으면 공백 아님(false) — 빈 저장소 오탐 방지', () => {
    expect(
      detectRecordTrailGap({ hasCommits: false, activeWorkitem: null, gateAttemptRecords: 0 }),
    ).toBe(false);
  });

  it('활성 워크아이템이 있으면 공백 아님(false) — 정상 흐름', () => {
    expect(
      detectRecordTrailGap({ hasCommits: true, activeWorkitem: 'WI-1', gateAttemptRecords: 0 }),
    ).toBe(false);
  });

  it('대응 record(gate/attempt)가 하나라도 있으면 공백 아님(false)', () => {
    expect(
      detectRecordTrailGap({ hasCommits: true, activeWorkitem: null, gateAttemptRecords: 3 }),
    ).toBe(false);
  });
});

describe('collectChecks — record 트레일 공백 표면화 (record-trail-guard AC-01 글루)', () => {
  beforeEach(() => {
    // engine/rules/projects 는 있지만 records/ 는 없는 홈 = gate/attempt record 0건.
    process.env.AWL_HOME = makeInstalledHome();
  });

  // 실제 git 저장소(커밋 있음) + project 필드가 있는 config. 워크아이템은 등록하지 않는다.
  function realGitProjectNoWorkitem(): string {
    const proj = fs.realpathSync(tmp('awl-trail-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({
        project: 'trailproj',
        engineVersion: '0.0.0',
        verify: { typecheck: null, lint: null, test: null, e2e: null },
      }),
    );
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'work without record'], { cwd: proj });
    return proj;
  }

  it('커밋은 있는데 활성 워크아이템·record 가 없으면 record 트레일 warn 을 낸다', async () => {
    const proj = realGitProjectNoWorkitem();
    process.chdir(proj);

    const report = await collectChecks();
    const check = find(report.checks, 'record 트레일');
    expect(check?.status).toBe('warn');
    expect(check?.value).toContain('공백');
    // warn 이라 doctor 종료코드(problems=missing/fail)에는 안 걸린다.
    const problems = report.checks.filter((c) => c.status === 'missing' || c.status === 'fail');
    expect(problems.some((c) => c.name === 'record 트레일')).toBe(false);
  });

  it('활성 워크아이템이 있으면 record 트레일 경고를 내지 않는다 (정상 흐름, AC-03)', async () => {
    const proj = realGitProjectNoWorkitem();
    fs.writeFileSync(
      path.join(proj, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-live', phase: 'loop' }),
    );
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, 'record 트레일')).toBeUndefined();
  });

  it('이 프로젝트의 gate/attempt record 가 있으면 경고를 내지 않는다 (트레일 존재)', async () => {
    const proj = realGitProjectNoWorkitem();
    const home = process.env.AWL_HOME as string;
    fs.mkdirSync(path.join(home, 'records'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'records', '2026-07.jsonl'),
      `${JSON.stringify({ id: 'r1', at: '2026-07-18T00:00:00.000Z', type: 'gate', gate: 1, project: 'trailproj' })}\n`,
    );
    process.chdir(proj);

    const report = await collectChecks();
    expect(find(report.checks, 'record 트레일')).toBeUndefined();
  });
});
