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
  runInit,
  scaffoldGlobal,
  selectMulti,
  selectSingle,
  skillsVersionPath,
  splitEnv,
  syncExistingInstall,
  verifyStepLines,
  writeSkillsVersionStamp,
} from '../../src/commands/init.js';
import { type Caps, type Colors, makeColors, stringWidth } from '../../src/core/tty.js';

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

describe('scaffoldGlobal', () => {
  it('awl init 재실행은 기존 홈 엔진 템플릿도 최신으로 갱신한다', () => {
    const home = path.join(tmp('awl-init-engine-'), 'home');
    process.env.AWL_HOME = home;
    expect(scaffoldGlobal().created).toBe(true);

    fs.writeFileSync(path.join(home, 'engine', 'version.json'), '{"engineVersion":"0.0.1"}\n');
    const refreshed = scaffoldGlobal();

    expect(refreshed.created).toBe(false);
    expect(refreshed.engineVersion).not.toBe('0.0.1');
  });
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

  it('순수 함수가 아니다 — 인자를 그 자리에서 바꾸고 같은 참조를 돌려준다 (리뷰 지적 AC-11, 서술 정확성)', () => {
    const verify: VerifyMap = { typecheck: { cmd: 'tsc' }, lint: null, test: null, e2e: null };
    const returned = applyVerifyCwd(verify, 'packages/app');
    expect(returned).toBe(verify); // 새 객체가 아니라 같은 참조
    expect(verify.typecheck?.cwd).toBe('packages/app'); // 원본 인자가 실제로 바뀜
  });
});

describe('verifyStepLines (리뷰 지적 AC-09 — buildScreens/interactiveInputs 가 리터럴 배열을 중복하던 것을 분리)', () => {
  it('검증 명령어 화면 본문을 만든다(안내문 + 각 항목 + 마무리 문구)', () => {
    const lines = verifyStepLines({
      typecheck: { cmd: 'tsc --noEmit' },
      lint: null,
      test: null,
      e2e: null,
    });
    expect(lines[0]).toBe('package.json 등에서 찾았습니다. 맞으면 Enter, 고치려면 새로 입력.');
    expect(lines.some((l) => l.includes('tsc --noEmit'))).toBe(true);
    expect(lines.at(-2)).toBe('이 명령어들이 유일한 심판입니다.');
    expect(lines.at(-1)).toBe('AI 가 "다 했습니다"라고 말할 수 없게 만드는 장치입니다.');
  });

  it('buildScreens.verify 가 이 함수로 만든 내용을 그대로 담는다(단일 출처 확인)', () => {
    const verify: VerifyMap = { typecheck: { cmd: 'tsc' }, lint: null, test: null, e2e: null };
    const screens = buildScreens(tmp('awl-init-screens-'), false, {
      unicode: false,
      color: false,
      tty: false,
    });
    for (const line of verifyStepLines(verify)) {
      // buildScreens 는 detectVerify 결과를 쓰므로 값 자체는 다를 수 있다 —
      // 여기서는 두 화면이 "같은 함수로" 만들어졌는지, 즉 고정 문구가 그대로인지만 확인한다.
      if (!line.includes('tsc')) {
        expect(screens.verify).toContain(line);
      }
    }
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

  it('.awl-worktrees/ 도 함께 무시한다 (F-1 근원 차단)', () => {
    const p = tmp('awl-gi-');
    ensureGitignore(p);
    const content = fs.readFileSync(path.join(p, '.gitignore'), 'utf8');
    expect(content).toContain('.awl/state.json');
    expect(content).toContain('.awl-worktrees/');
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
    for (const box of [s.lang, s.verify, s.character, s.skills]) {
      expect(box.startsWith('+')).toBe(true);
      // 각 본문 줄은 세로선 | 로 시작(오른쪽 열린 L자 박스).
      const bodyLines = box.split('\n').slice(1);
      expect(bodyLines.every((l) => l === '' || l.startsWith('|') || l.startsWith('+'))).toBe(true);
    }
    // 이모지가 없어야 한다.
    const all = [s.welcome, s.lang, s.verify, s.character, s.skills].join('\n');
    expect(all).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
  });

  it('[보고용] 대화형 전체 흐름 화면을 출력한다', () => {
    const s = buildScreens(screenProject(), false, { unicode: false, color: false, tty: false });
    const flow = [s.welcome, s.lang, s.verify, s.character, s.skills].join('\n\n');
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

    // 스킬 버전 스탬프 (WI-X AC-01)
    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBe(result.engineVersion);
    expect(stamp.codex).toBe(result.engineVersion);

    // 프로젝트 등록
    expect(result.projectCount).toBe(1);
  });

  it('스킬을 하나만 설치하면 스탬프에도 그 키만 생긴다', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBeDefined();
    expect(stamp.codex).toBeUndefined();
  });

  it('스킬을 하나도 설치하지 않으면 스탬프 파일 자체를 만들지 않는다', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    expect(fs.existsSync(skillsVersionPath(proj))).toBe(false);
  });

  it('writeSkillsVersionStamp — claude 만 다시 설치해도 기존 codex 값은 보존된다 (WI-X AC-07, 리뷰 지적)', () => {
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(skillsVersionPath(proj), JSON.stringify({ claude: '0.3.0', codex: '0.3.0' }));

    writeSkillsVersionStamp(proj, { claude: true, codex: false }, '0.5.0');

    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBe('0.5.0'); // 새로 설치한 것만 갱신
    expect(stamp.codex).toBe('0.3.0'); // 안 건드린 것은 보존
  });

  it('writeSkillsVersionStamp — 손상된 JSON 이어도 크래시 없이 새로 만든다 (WI-X AC-07, 리뷰 지적)', () => {
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(skillsVersionPath(proj), '{ 이건 JSON 이 아님');

    expect(() =>
      writeSkillsVersionStamp(proj, { claude: true, codex: true }, '0.5.0'),
    ).not.toThrow();

    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBe('0.5.0');
    expect(stamp.codex).toBe('0.5.0');
  });

  it('Codex 스킬을 두 번 설치해도 AGENTS.md 에 중복 추가하지 않는다', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: true };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const agents = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');
    expect(agents.split('awl-loop:start').length - 1).toBe(1);
  });

  it('syncExistingInstall — 옛 마커(config·skills-version)를 설치된 엔진 버전으로 끌어올린다 (F-2)', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: true };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const engineVersion = result.engineVersion;

    // 마커만 옛 버전으로 되돌린다(내용은 최신, 선언 마커만 낡은 상태 — F-2 관측 재현).
    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.0.1' }));
    fs.writeFileSync(skillsVersionPath(proj), JSON.stringify({ claude: '0.0.1', codex: '0.0.1' }));

    const synced = syncExistingInstall(proj, engineVersion);

    expect(synced.configUpdated).toBe(true);
    expect(synced.skills.sort()).toEqual(['claude', 'codex']);
    expect((readJson(configPath) as Record<string, unknown>).engineVersion).toBe(engineVersion);
    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBe(engineVersion);
    expect(stamp.codex).toBe(engineVersion);
  });

  it('syncExistingInstall — 설치 안 된 스킬은 새로 깔지 않는다 (F-2)', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const synced = syncExistingInstall(proj, result.engineVersion);

    expect(synced.skills).toEqual([]);
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop'))).toBe(false);
  });

  it('syncExistingInstall — 이미 최신이면 config 를 다시 쓰지 않는다 (F-2)', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const synced = syncExistingInstall(proj, result.engineVersion);

    expect(synced.configUpdated).toBe(false);
  });

  it('runInit --yes 재실행이 낡은 마커를 설치 엔진으로 동기화한다 (F-2 CLI 배선)', async () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    // 마커만 낡게 되돌린다(선언 마커만 옛 버전 — F-2 관측 재현).
    const configPath = path.join(proj, '.awl', 'config.json');
    const cfg = readJson(configPath) as Record<string, unknown>;
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, engineVersion: '0.0.1' }));
    fs.writeFileSync(skillsVersionPath(proj), JSON.stringify({ claude: '0.0.1' }));

    // proj 가 cwd(beforeEach 에서 chdir)이고 config 가 있으므로 --yes 재실행 경로를 탄다.
    await runInit({ yes: true });

    expect((readJson(configPath) as Record<string, unknown>).engineVersion).toBe(
      result.engineVersion,
    );
    expect((readJson(skillsVersionPath(proj)) as Record<string, unknown>).claude).toBe(
      result.engineVersion,
    );
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

describe('selectSingle/selectMulti — useRawMode:true 배선 (WI-Y AC-08, 리뷰 rev_b9f3bb4b93ede055f5 finding #2)', () => {
  // select.test.ts 의 stdin 모킹 패턴을 그대로 재사용한다 — 여기서 확인하려는 건
  // 방향키 상태전이(그건 select.test.ts 가 이미 21개 테스트로 검증)가 아니라,
  // selectSingle/selectMulti 가 runInteractiveSelect 의 결과를 자기 반환값으로
  // 제대로 배선하는지(index/checked 매핑, null 병합 기본값)다.
  const originalSetRawMode = process.stdin.setRawMode;
  const ASCII: Caps = { unicode: false, color: false, tty: false };

  afterEach(() => {
    process.stdin.setRawMode = originalSetRawMode;
    vi.restoreAllMocks();
    expect(process.stdin.listenerCount('data')).toBe(0);
  });

  function mockStdin() {
    process.stdin.setRawMode = vi
      .fn()
      .mockReturnValue(process.stdin) as typeof process.stdin.setRawMode;
    vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
    vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
    const onceSpy = vi.spyOn(process.stdin, 'once').mockImplementation(() => process.stdin);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    return onceSpy;
  }

  function lastDataListener(onceSpy: { mock: { calls: unknown[][] } }): (buf: Buffer) => void {
    const calls = onceSpy.mock.calls.filter((c) => c[0] === 'data');
    const last = calls[calls.length - 1];
    if (!last) {
      throw new Error('data 리스너가 등록되지 않았습니다');
    }
    return last[1] as (buf: Buffer) => void;
  }

  async function pressKey(onceSpy: { mock: { calls: unknown[][] } }, bytes: string): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    lastDataListener(onceSpy)(Buffer.from(bytes));
  }

  it('selectSingle(..., true) 는 방향키로 고른 인덱스를 그대로 돌려준다', async () => {
    const onceSpy = mockStdin();
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const promise = selectSingle(rl, ['a', 'b', 'c'], 0, ASCII, true);
    await pressKey(onceSpy, '\x1b[B'); // down
    await pressKey(onceSpy, '\r'); // enter
    const idx = await promise;
    rl.close();
    expect(idx).toBe(1);
  });

  it('selectSingle(..., true) 는 escape 로 취소되면 defaultIndex 로 돌아간다', async () => {
    const onceSpy = mockStdin();
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const promise = selectSingle(rl, ['a', 'b', 'c'], 2, ASCII, true);
    await pressKey(onceSpy, '\x1b'); // escape
    const idx = await promise;
    rl.close();
    expect(idx).toBe(2);
  });

  it('selectMulti(..., true) 는 space 로 토글한 체크 목록을 그대로 돌려준다', async () => {
    const onceSpy = mockStdin();
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const promise = selectMulti(rl, ['a', 'b'], [], ASCII, true);
    await pressKey(onceSpy, ' '); // index 0 토글
    await pressKey(onceSpy, '\r'); // enter
    const checked = await promise;
    rl.close();
    expect(checked).toEqual([0]);
  });

  it('selectMulti(..., true) 는 escape 로 취소되면 defaultChecked 로 돌아간다', async () => {
    const onceSpy = mockStdin();
    const rl = readline.createInterface({ input: new PassThrough(), output: new PassThrough() });
    const promise = selectMulti(rl, ['a', 'b'], [1], ASCII, true);
    await pressKey(onceSpy, '\x1b'); // escape
    const checked = await promise;
    rl.close();
    expect(checked).toEqual([1]);
  });
});
