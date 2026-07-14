import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type InitInputs,
  type VerifyMap,
  applyInit,
  applyVerifyCwd,
  buildConfig,
  buildScreens,
  detectLanguage,
  detectVerify,
  detectWorkspacePackages,
  ensureGitignore,
  nonInteractiveInputs,
  promptVerifyLocation,
  registerProject,
  splitEnv,
} from '../../src/commands/init.js';
import { type Colors, makeColors, stringWidth } from '../../src/core/tty.js';

const origCwd = process.cwd();
const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readJson(p: string): unknown {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

afterEach(() => {
  process.chdir(origCwd);
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('detectLanguage', () => {
  it('tsconfig.json 이 있으면 typescript (AC-01)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('package.json 만 있고 TS 신호가 전혀 없으면 javascript (AC-04, 순수 JS 회귀)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), '{}');
    expect(detectLanguage(p)).toBe('javascript');
  });

  it('pyproject.toml 이 있으면 python', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'pyproject.toml'), '');
    expect(detectLanguage(p)).toBe('python');
  });

  it('아무것도 없으면 null', () => {
    expect(detectLanguage(tmp('awl-lang-'))).toBeNull();
  });

  it('루트 tsconfig 없어도 devDependencies 에 typescript 있으면 typescript (AC-02)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(
      path.join(p, 'package.json'),
      JSON.stringify({ devDependencies: { typescript: '^5.0.0' } }),
    );
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('dependencies 에 typescript 있어도 typescript', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(
      path.join(p, 'package.json'),
      JSON.stringify({ dependencies: { typescript: '^5.0.0' } }),
    );
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('npm/yarn workspaces 필드의 멤버 패키지에 tsconfig.json 있으면 typescript (AC-03, 모노레포 핵심 버그)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    fs.mkdirSync(path.join(p, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'app', 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('pnpm-workspace.yaml 의 멤버 패키지에 tsconfig.json 있으면 typescript (AC-03)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(p, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
    fs.mkdirSync(path.join(p, 'packages', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'lib', 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('워크스페이스 멤버 중 어느 것도 tsconfig 가 없으면 여전히 javascript', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    fs.mkdirSync(path.join(p, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'app', 'package.json'), '{}');
    expect(detectLanguage(p)).toBe('javascript');
  });

  // 리뷰어(서브에이전트)가 실제로 재현해 지적한 결함들 (AC-06, AC-07). 리뷰는
  // awl review 로 조립한 diff/provenance 만 보고 진행됐고, 구현자 맥락은 없었다.
  it('pnpm-workspace.yaml 항목에 인라인 # 주석이 있어도 인식한다 (AC-06, 리뷰 지적)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(
      path.join(p, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'  # 워크스페이스 패키지\n",
    );
    fs.mkdirSync(path.join(p, 'packages', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'lib', 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('pnpm-workspace.yaml 이 flow-style 배열이어도 인식한다 (AC-06, 리뷰 지적)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({}));
    fs.writeFileSync(path.join(p, 'pnpm-workspace.yaml'), "packages: ['packages/*']\n");
    fs.mkdirSync(path.join(p, 'packages', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'lib', 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('워크스페이스 글롭의 ** 가 2단계 이상 중첩된 tsconfig 도 찾는다 (AC-07, 리뷰 지적)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['apps/**'] }));
    fs.mkdirSync(path.join(p, 'apps', 'team1', 'service1'), { recursive: true });
    fs.writeFileSync(path.join(p, 'apps', 'team1', 'service1', 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });

  it('** 는 1단계 중첩(apps/service1)도 여전히 찾는다 (회귀)', () => {
    const p = tmp('awl-lang-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['apps/**'] }));
    fs.mkdirSync(path.join(p, 'apps', 'service1'), { recursive: true });
    fs.writeFileSync(path.join(p, 'apps', 'service1', 'tsconfig.json'), '{}');
    expect(detectLanguage(p)).toBe('typescript');
  });
});

describe('splitEnv — 인라인 env 분리', () => {
  it('선행 KEY=VAL 을 env 로 분리한다', () => {
    expect(splitEnv('NODE_ENV=test vitest run')).toEqual({
      cmd: 'vitest run',
      env: { NODE_ENV: 'test' },
    });
  });
  it('env 가 없으면 cmd 만', () => {
    expect(splitEnv('vitest run')).toEqual({ cmd: 'vitest run' });
  });
});

describe('detectVerify', () => {
  it('package.json scripts 에서 검증 명령을 뽑고 인라인 env 를 분리한다', () => {
    const p = tmp('awl-verify-');
    fs.writeFileSync(path.join(p, 'tsconfig.json'), '{}');
    fs.writeFileSync(
      path.join(p, 'package.json'),
      JSON.stringify({
        scripts: { lint: 'eslint .', test: 'NODE_ENV=test vitest run' },
      }),
    );
    const v = detectVerify(p);
    expect(v.typecheck).toEqual({ cmd: 'tsc --noEmit' }); // tsconfig 로 유추
    expect(v.lint).toEqual({ cmd: 'eslint .' });
    expect(v.test).toEqual({ cmd: 'vitest run', env: { NODE_ENV: 'test' } });
    expect(v.e2e).toBeNull();
  });
});

describe('detectWorkspacePackages (WI-B, 모노레포 검증 위치)', () => {
  it('모노레포가 아니면 빈 배열', () => {
    const p = tmp('awl-ws-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({}));
    expect(detectWorkspacePackages(p)).toEqual([]);
  });

  it('workspaces 필드의 멤버(package.json 있는 것만) 를 상대경로로 돌려준다', () => {
    const p = tmp('awl-ws-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    fs.mkdirSync(path.join(p, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'app', 'package.json'), '{}');
    fs.mkdirSync(path.join(p, 'packages', 'not-a-package'), { recursive: true }); // package.json 없음
    expect(detectWorkspacePackages(p)).toEqual([path.join('packages', 'app')]);
  });
});

describe('promptVerifyLocation (WI-B, readline 직접 구동 — D-23 패턴)', () => {
  const COLOR: Colors = makeColors(false);

  function makeScriptedRL(answers: string[]): readline.Interface {
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {});
    const rl = readline.createInterface({ input, output });
    const queue = [...answers];
    const originalQuestion = rl.question.bind(rl);
    rl.question = ((query: string, cb: (answer: string) => void) => {
      originalQuestion(query, cb);
      const next = queue.shift() ?? '';
      process.nextTick(() => input.write(`${next}\n`));
    }) as typeof rl.question;
    return rl;
  }

  it('모노레포가 아니면 묻지 않고 루트 verify 그대로 돌려준다', async () => {
    const p = tmp('awl-ws-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({}));
    const rootVerify = detectVerify(p);
    const rl = makeScriptedRL([]);
    const result = await promptVerifyLocation(rl, p, rootVerify, COLOR);
    rl.close();
    expect(result.cwd).toBeUndefined();
    expect(result.verify).toEqual(rootVerify);
  });

  it('모노레포인데 루트에 이미 검증 명령이 있으면 묻지 않고 안내만 한다(판단 쉬움)', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const p = tmp('awl-ws-');
    fs.writeFileSync(
      path.join(p, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'], scripts: { test: 'vitest run' } }),
    );
    fs.mkdirSync(path.join(p, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(path.join(p, 'packages', 'app', 'package.json'), '{}');
    const rootVerify = detectVerify(p);
    const rl = makeScriptedRL([]); // 아무 것도 안 물어봐야 함(답 없어도 통과해야 함)
    const result = await promptVerifyLocation(rl, p, rootVerify, COLOR);
    rl.close();
    stdoutSpy.mockRestore();
    expect(result.cwd).toBeUndefined();
    expect(result.verify.test).toEqual({ cmd: 'vitest run' });
  });

  it('모노레포이고 루트에 검증 명령이 없으면 패키지를 물어본다 — "1"(루트) 을 고르면 루트를 유지한다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const p = tmp('awl-ws-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    fs.mkdirSync(path.join(p, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(p, 'packages', 'app', 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    const rootVerify = detectVerify(p); // 루트엔 아무 신호 없음(전부 null) — 판단 애매함
    // 옵션 목록: 1=루트(전체), 2=packages/app. "1" 을 고르면 루트를 유지한다.
    const rl = makeScriptedRL(['1']);
    const result = await promptVerifyLocation(rl, p, rootVerify, COLOR);
    rl.close();
    stdoutSpy.mockRestore();
    expect(result.cwd).toBeUndefined();
  });

  it('패키지 번호(2)를 고르면 그 패키지 기준으로 재감지하고 cwd 를 돌려준다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const p = tmp('awl-ws-');
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    fs.mkdirSync(path.join(p, 'packages', 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(p, 'packages', 'app', 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest run' } }),
    );
    const rootVerify = detectVerify(p);
    const rl = makeScriptedRL(['2']); // 옵션: 1=루트, 2=packages/app
    const result = await promptVerifyLocation(rl, p, rootVerify, COLOR);
    rl.close();
    stdoutSpy.mockRestore();
    expect(result.cwd).toBe(path.join('packages', 'app'));
    expect(result.verify.test).toEqual({ cmd: 'vitest run' });
  });
});

describe('applyVerifyCwd (WI-B, 리뷰 지적 AC-06 — 예전엔 어떤 테스트도 안 걸림)', () => {
  it('cwd 가 있으면 null 아닌 모든 항목에 적용한다', () => {
    const verify: VerifyMap = {
      typecheck: { cmd: 'tsc --noEmit' },
      lint: { cmd: 'eslint .' },
      test: null,
      e2e: null,
    };
    applyVerifyCwd(verify, 'packages/app');
    expect(verify.typecheck?.cwd).toBe('packages/app');
    expect(verify.lint?.cwd).toBe('packages/app');
    expect(verify.test).toBeNull(); // null 은 그대로
  });

  it('사용자가 프롬프트에서 값을 새로 입력해 바꾼 뒤에도(순서 무관) cwd 가 정확히 적용된다', () => {
    // interactiveInputs 의 실제 순서를 흉내낸다: 사용자가 typecheck 를 새로 입력해
    // 바꾼 다음에 applyVerifyCwd 를 호출한다.
    const verify: VerifyMap = { typecheck: null, lint: null, test: null, e2e: null };
    verify.typecheck = { cmd: '../../node_modules/.bin/tsc --noEmit' }; // 사용자가 새로 입력
    applyVerifyCwd(verify, 'packages/app');
    expect(verify.typecheck?.cwd).toBe('packages/app');
  });

  it('cwd 가 없으면 아무것도 바꾸지 않는다', () => {
    const verify: VerifyMap = { typecheck: { cmd: 'tsc' }, lint: null, test: null, e2e: null };
    applyVerifyCwd(verify, undefined);
    expect(verify.typecheck?.cwd).toBeUndefined();
  });
});

describe('buildConfig', () => {
  it('입력과 엔진버전으로 config 객체를 만든다', () => {
    const inputs: InitInputs = {
      project: 'proj',
      mainLanguage: 'typescript',
      character: '디자인 토큰 강제',
      verify: { typecheck: { cmd: 'tsc --noEmit' }, lint: null, test: null, e2e: null },
      skills: { claude: true, codex: false },
    };
    const config = buildConfig(inputs, '0.0.0');
    expect(config.project).toBe('proj');
    expect(config.engineVersion).toBe('0.0.0');
    expect(config.verify.typecheck).toEqual({ cmd: 'tsc --noEmit' });
    expect(config.verify.e2e).toBeNull();
  });
});

describe('ensureGitignore — 중복 방지', () => {
  it('.awl/state.json 을 추가하고, 두 번째는 중복하지 않는다', () => {
    const p = tmp('awl-gi-');
    expect(ensureGitignore(p)).toBe('added');
    expect(ensureGitignore(p)).toBe('exists');
    const content = fs.readFileSync(path.join(p, '.gitignore'), 'utf8');
    const occurrences = content.split('\n').filter((l) => l.trim() === '.awl/state.json').length;
    expect(occurrences).toBe(1);
  });

  it('기존 .gitignore 내용을 보존한다', () => {
    const p = tmp('awl-gi-');
    fs.writeFileSync(path.join(p, '.gitignore'), 'node_modules/\n');
    ensureGitignore(p);
    const content = fs.readFileSync(path.join(p, '.gitignore'), 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.awl/state.json');
  });
});

describe('대화형 화면 렌더 (ASCII)', () => {
  function screenProject(): string {
    const proj = tmp('awl-screen-');
    fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'tsconfig.json'), '{}');
    fs.writeFileSync(
      path.join(proj, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }),
    );
    return proj;
  }

  it('한글이 섞여도 stepBox 가 깨지지 않고 이모지가 없다', () => {
    const s = buildScreens(screenProject(), false, { unicode: false, color: false, tty: false });
    // ASCII 박스 상단은 + 로 시작한다.
    for (const box of [s.lang, s.verify, s.rules, s.character, s.skills]) {
      expect(box.startsWith('+')).toBe(true);
      // 각 본문 줄은 세로선 | 로 시작(오른쪽 열린 L자 박스).
      const bodyLines = box.split('\n').slice(1);
      expect(bodyLines.every((l) => l === '' || l.startsWith('|') || l.startsWith('+'))).toBe(true);
    }
    // 이모지가 없어야 한다.
    const all = [s.welcome, s.lang, s.verify, s.rules, s.character, s.skills].join('\n');
    expect(all).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
  });

  it('[보고용] 대화형 전체 흐름 화면을 출력한다', () => {
    const s = buildScreens(screenProject(), false, { unicode: false, color: false, tty: false });
    const flow = [s.welcome, s.lang, s.verify, s.rules, s.character, s.skills].join('\n\n');
    process.stdout.write(`\n##### 대화형 흐름 (ASCII) 시작 #####\n${flow}\n##### 끝 #####\n`);
    expect(stringWidth('한글')).toBe(4); // 폭 계산이 살아있음을 확인
  });
});

describe('applyInit — 전체 산출물', () => {
  let home: string;
  let proj: string;

  beforeEach(() => {
    home = tmp('awl-home-');
    fs.rmSync(home, { recursive: true, force: true }); // 없는 상태에서 시작(scaffold 가 생성)
    process.env.AWL_HOME = home;
    proj = tmp('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'tsconfig.json'), '{}');
    fs.writeFileSync(
      path.join(proj, 'package.json'),
      JSON.stringify({ scripts: { lint: 'eslint .', test: 'vitest run' } }),
    );
    process.chdir(proj);
  });

  it('전역 골격/engine 복사/config/state/gitignore/스킬/등록을 모두 수행한다', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: true };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    // 전역 골격
    expect(result.globalCreated).toBe(true);
    expect(fs.existsSync(path.join(home, 'rules', 'active'))).toBe(true);
    expect(readJson(path.join(home, 'rules', 'index.json'))).toEqual([]);
    // engine 복사 (version.json + 스킬 자리표시자)
    expect(fs.existsSync(path.join(home, 'engine', 'version.json'))).toBe(true);
    expect(
      fs.existsSync(path.join(home, 'engine', 'skills', 'claude', 'awl-loop', 'SKILL.md')),
    ).toBe(true);

    // config
    const config = readJson(result.configPath) as Record<string, unknown>;
    expect(config.project).toBe(path.basename(proj));
    expect(config.mainLanguage).toBe('typescript');
    expect((config.verify as Record<string, unknown>).lint).toEqual({ cmd: 'eslint .' });

    // state + gitignore
    expect(fs.existsSync(result.statePath)).toBe(true);
    expect(result.gitignore).toBe('added');
    expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toContain('.awl/state.json');

    // 스킬 설치
    expect(result.skills).toEqual(['claude', 'codex']);
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8')).toContain('awl-loop:start');

    // 프로젝트 등록
    expect(result.projectCount).toBe(1);
  });

  it('Codex 스킬을 두 번 설치해도 AGENTS.md 에 중복 추가하지 않는다', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: true };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const agents = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');
    expect(agents.split('awl-loop:start').length - 1).toBe(1);
  });

  it('같은 프로젝트를 다시 등록해도 프로젝트 수가 늘지 않는다', () => {
    const inputs = nonInteractiveInputs(proj);
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const count = registerProject({
      name: 'x',
      path: proj,
      mainLanguage: 'typescript',
      character: '',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(count).toBe(1);
  });
});
