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
  claudeSkillLabel,
  codexSkillLabel,
  codexSkillNames,
  detectLanguage,
  detectLanguages,
  detectVerify,
  detectWorkspacePackages,
  ensureGitignore,
  excludeRegisteredProjects,
  installClaudeSkill,
  installCodexSkill,
  installSafetyHook,
  listRegisteredProjects,
  nonInteractiveInputs,
  promptVerifyLocation,
  registerProject,
  registeredProjectPaths,
  renderResult,
  resolveProjectChoice,
  runInit,
  scaffoldGlobal,
  scanGitProjects,
  selectMulti,
  selectSingle,
  skillsVersionPath,
  splitEnv,
  syncExistingInstall,
  verifyStepLines,
  writeSkillsVersionStamp,
} from '../../src/commands/init.js';
import { projectsFile } from '../../src/core/paths.js';
import { type Caps, type Colors, makeColors, stringWidth } from '../../src/core/tty.js';

const origCwd = process.cwd();
const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeGitMetadata(gitDir: string): void {
  fs.mkdirSync(path.join(gitDir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
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

describe('detectLanguages — 여러 언어 동시 감지 (awl-init-multi-lang)', () => {
  it('TS 프론트 + Python 백엔드 같은 폴리글랏 프로젝트는 둘 다 돌려준다', () => {
    const p = tmp('awl-langs-');
    fs.writeFileSync(path.join(p, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(p, 'requirements.txt'), 'flask\n');
    expect(detectLanguages(p).sort()).toEqual(['python', 'typescript']);
  });

  it('JS/TS 만 있으면 하나만(Python 마커 없음)', () => {
    const p = tmp('awl-langs-');
    fs.writeFileSync(path.join(p, 'tsconfig.json'), '{}');
    expect(detectLanguages(p)).toEqual(['typescript']);
  });

  it('아무 신호도 없으면 빈 배열', () => {
    expect(detectLanguages(tmp('awl-langs-'))).toEqual([]);
  });

  it('detectLanguage(단일) 는 그대로 JS/TS 우선, 없으면 Python 폴백 동작을 유지한다(회귀)', () => {
    const p = tmp('awl-langs-');
    fs.writeFileSync(path.join(p, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(p, 'requirements.txt'), 'flask\n');
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
      mainLanguage: ['typescript'],
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

  it('verify-baseline.json 도 init 시점에 무시한다 (B4: work new 가 나중에 만들어 첫 commit 이 오귀속하는 것 차단)', () => {
    const p = tmp('awl-gi-');
    ensureGitignore(p);
    const content = fs.readFileSync(path.join(p, '.gitignore'), 'utf8');
    expect(content).toContain('.awl/verify-baseline.json');
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

describe('nonInteractiveInputs — 스킬 기본값 (B3)', () => {
  it('빈 프로젝트(감지 0)면 Claude 스킬을 기본으로 켠다 — 예전엔 아무것도 안 깔려 /awl-loop 를 못 썼다', () => {
    const p = tmp('awl-fresh-');
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    const inputs = nonInteractiveInputs(p);
    expect(inputs.skills.claude).toBe(true);
    expect(inputs.skills.codex).toBe(false);
  });

  it('.claude/ 가 이미 있으면 그대로 감지해 존중한다', () => {
    const p = tmp('awl-hasclaude-');
    fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
    const inputs = nonInteractiveInputs(p);
    expect(inputs.skills.claude).toBe(true);
    expect(inputs.skills.codex).toBe(false);
  });

  it('AGENTS.md 만 있으면 codex 만 존중하고 claude 를 억지로 켜지 않는다 (감지되면 기본값 미적용)', () => {
    const p = tmp('awl-hascodex-');
    fs.mkdirSync(path.join(p, '.git'), { recursive: true });
    fs.writeFileSync(path.join(p, 'AGENTS.md'), '# agents\n');
    const inputs = nonInteractiveInputs(p);
    expect(inputs.skills.codex).toBe(true);
    expect(inputs.skills.claude).toBe(false);
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
    makeGitMetadata(path.join(proj, '.git'));
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
    expect(config.mainLanguage).toEqual(['typescript']);
    expect((config.verify as Record<string, unknown>).lint).toEqual({ cmd: 'eslint .' });

    // state + gitignore
    expect(fs.existsSync(result.statePath)).toBe(true);
    expect(result.gitignore).toBe('added');
    expect(fs.readFileSync(path.join(proj, '.gitignore'), 'utf8')).toContain('.awl/state.json');

    // 스킬 설치
    expect(result.skills).toEqual(['claude', 'codex']);
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(proj, '.agents', 'skills', 'awl-loop', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(proj, '.agents', 'skills', 'awl-pipeline', 'SKILL.md'))).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8')).toContain('awl-loop:start');

    // 스킬 버전 스탬프 (WI-X AC-01)
    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBe(result.engineVersion);
    expect(stamp.codex).toBe(result.engineVersion);

    // 프로젝트 등록
    expect(result.projectCount).toBe(1);
  });

  it('Codex와 Claude pipeline 계약을 review와 runner provenance까지 설치 surface로 그대로 복사한다', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: true };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    for (const surface of ['codex', 'claude']) {
      const installedRoot =
        surface === 'codex'
          ? path.join(proj, '.agents', 'skills')
          : path.join(proj, '.claude', 'skills');
      for (const skill of [
        'awl-pipeline',
        'awl-pipeline-exec',
        'awl-pipeline-review',
        'awl-loop',
      ]) {
        const engineSkill = fs.readFileSync(
          path.join(home, 'engine', 'skills', surface, skill, 'SKILL.md'),
          'utf8',
        );
        const installedSkill = fs.readFileSync(path.join(installedRoot, skill, 'SKILL.md'), 'utf8');
        expect(installedSkill).toBe(engineSkill);
      }

      const installedExec = fs.readFileSync(
        path.join(installedRoot, 'awl-pipeline-exec', 'SKILL.md'),
        'utf8',
      );
      const installedReview = fs.readFileSync(
        path.join(installedRoot, 'awl-pipeline-review', 'SKILL.md'),
        'utf8',
      );
      expect(installedExec).toContain('package-owned-runner-resolution:');
      expect(installedExec).toContain('## Test runner provenance');
      expect(installedExec).toContain('port-lease-run-contract:');
      expect(installedExec).toContain('## Service port lease provenance');
      expect(installedReview).toContain(
        'package-owned-runner-review: independently-resolve-and-rerun; provenance-missing=fail',
      );
      expect(installedReview).toContain(
        'port-lease-provenance-review: independently-reproduce-and-inspect; provenance-missing=fail',
      );
    }
  });

  it('일반 프로젝트의 .git/hooks 에 pre-push 안전 훅을 설치한다', () => {
    const result = applyInit(proj, nonInteractiveInputs(proj), '2026-01-01T00:00:00.000Z');

    expect(result.safetyHook).toEqual({ installed: true });
    expect(fs.existsSync(path.join(proj, '.git', 'hooks', 'pre-push'))).toBe(true);
  });

  it('linked worktree의 gitdir/commondir를 따라 공용 hooks에 설치하고 config를 완성한다', () => {
    const commonGitDir = path.join(tmp('awl-common-git-'), '.git');
    const worktreeGitDir = path.join(commonGitDir, 'worktrees', 'lane');
    makeGitMetadata(commonGitDir);
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/lane\n');
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    fs.rmSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git'), `gitdir: ${worktreeGitDir}\n`);

    const result = applyInit(proj, nonInteractiveInputs(proj), '2026-01-01T00:00:00.000Z');

    expect(result.safetyHook).toEqual({ installed: true });
    expect(fs.existsSync(path.join(commonGitDir, 'hooks', 'pre-push'))).toBe(true);
    expect(readJson(path.join(proj, '.awl', 'config.json'))).toMatchObject({
      project: path.basename(proj),
    });
  });

  it('모노레포 하위 프로젝트에서는 상위 저장소의 hooks에 안전 훅을 설치한다', () => {
    const nestedProject = path.join(proj, 'packages', 'maxflow');
    fs.mkdirSync(nestedProject, { recursive: true });

    const result = installSafetyHook(nestedProject);

    expect(result).toEqual({ installed: true });
    expect(fs.existsSync(path.join(proj, '.git', 'hooks', 'pre-push'))).toBe(true);
  });

  it('훅 경로를 해석하지 못해도 config 생성은 계속한다', () => {
    fs.rmSync(path.join(proj, '.git'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.git'), 'not a gitdir file\n');

    const result = applyInit(proj, nonInteractiveInputs(proj), '2026-01-01T00:00:00.000Z');

    expect(result.safetyHook.installed).toBe(false);
    expect(result.safetyHook.warning).toContain('push 차단 훅을 설치하지 못했습니다');
    expect(fs.existsSync(path.join(proj, '.awl', 'config.json'))).toBe(true);
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

  it('Codex 기존 AGENTS 블록을 최신 라우팅 블록으로 교체하고 5개 repo 스킬을 설치한다', () => {
    scaffoldGlobal();
    fs.writeFileSync(
      path.join(proj, 'AGENTS.md'),
      '# project\n\n<!-- awl-loop:start -->\nlegacy claude-shaped instructions\n<!-- awl-loop:end -->\n',
    );

    expect(installCodexSkill(proj)).toBe(true);

    const agents = fs.readFileSync(path.join(proj, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# project');
    expect(agents).not.toContain('legacy claude-shaped instructions');
    expect(agents).toContain('$awl-pipeline');
    expect(agents).toContain('AUTO-EXCLUDE-FIRST');
    expect(agents).toContain('AUTO-INCLUDE-AFTER-EXCLUSIONS');
    expect(agents).toContain('PRE-SELECTION-AWL=none');
    expect(agents).toContain('POST-SELECTION-FIRST-AWL=awl version-check --json');
    expect(agents.split('awl-loop:start').length - 1).toBe(1);
    expect(codexSkillNames()).toEqual([
      'awl-loop',
      'awl-pipeline',
      'awl-pipeline-exec',
      'awl-pipeline-plan',
      'awl-pipeline-review',
    ]);
    for (const name of codexSkillNames()) {
      expect(fs.existsSync(path.join(proj, '.agents', 'skills', name, 'SKILL.md'))).toBe(true);
    }
  });

  it('Codex의 옛 Claude 스킬 symlink를 실제 repo 스킬 디렉터리로 마이그레이션한다', () => {
    scaffoldGlobal();
    const claudeSkill = path.join(proj, '.claude', 'skills', 'awl-loop');
    const codexSkill = path.join(proj, '.agents', 'skills', 'awl-loop');
    fs.mkdirSync(claudeSkill, { recursive: true });
    fs.writeFileSync(path.join(claudeSkill, 'sentinel.txt'), 'keep the Claude target\n');
    fs.mkdirSync(path.dirname(codexSkill), { recursive: true });
    fs.symlinkSync(path.relative(path.dirname(codexSkill), claudeSkill), codexSkill, 'dir');

    expect(installCodexSkill(proj)).toBe(true);

    expect(fs.lstatSync(codexSkill).isSymbolicLink()).toBe(false);
    expect(fs.statSync(codexSkill).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(codexSkill, 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(claudeSkill, 'sentinel.txt'), 'utf8')).toBe(
      'keep the Claude target\n',
    );
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

    const synced = syncExistingInstall(proj, engineVersion, '2026-01-02T00:00:00.000Z');

    expect(synced.configUpdated).toBe(true);
    expect(synced.skills.sort()).toEqual(['claude', 'codex']);
    expect((readJson(configPath) as Record<string, unknown>).engineVersion).toBe(engineVersion);
    const stamp = readJson(skillsVersionPath(proj)) as Record<string, unknown>;
    expect(stamp.claude).toBe(engineVersion);
    expect(stamp.codex).toBe(engineVersion);
    expect(fs.existsSync(path.join(proj, '.agents', 'skills', 'awl-pipeline', 'SKILL.md'))).toBe(
      true,
    );
  });

  it('syncExistingInstall — 설치 안 된 스킬은 새로 깔지 않는다 (F-2)', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const synced = syncExistingInstall(proj, result.engineVersion, '2026-01-02T00:00:00.000Z');

    expect(synced.skills).toEqual([]);
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop'))).toBe(false);
  });

  it('syncExistingInstall — 이미 최신이면 config 를 다시 쓰지 않는다 (F-2)', () => {
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: false, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    const synced = syncExistingInstall(proj, result.engineVersion, '2026-01-02T00:00:00.000Z');

    expect(synced.configUpdated).toBe(false);
  });

  it('syncExistingInstall — awl remove --all 등으로 registry 가 비워진 뒤에도 "그대로 쓴다" 재실행이 재등록한다 (F-1)', () => {
    const inputs = nonInteractiveInputs(proj);
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    expect(listRegisteredProjects().map((p) => p.path)).toContain(proj);

    // awl remove --all 이 ~/.awl/projects.json 을 비웠다고 가정한다.
    fs.writeFileSync(projectsFile(), '[]\n');
    expect(listRegisteredProjects()).toEqual([]);

    syncExistingInstall(proj, result.engineVersion, '2026-01-02T00:00:00.000Z');

    const registered = listRegisteredProjects();
    expect(registered.map((p) => p.path)).toContain(proj);
  });

  it('syncExistingInstall — 이미 등록돼 있으면 중복 추가하지 않고 upsert 한다 (F-1)', () => {
    const inputs = nonInteractiveInputs(proj);
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    syncExistingInstall(proj, result.engineVersion, '2026-01-02T00:00:00.000Z');
    syncExistingInstall(proj, result.engineVersion, '2026-01-03T00:00:00.000Z');

    const registered = listRegisteredProjects().filter((p) => p.path === proj);
    expect(registered).toHaveLength(1);
  });

  it('runInit --yes 재실행(config 이미 있음)도 비워진 registry 를 재등록한다 (F-1 CLI 배선)', async () => {
    const inputs = nonInteractiveInputs(proj);
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');

    fs.writeFileSync(projectsFile(), '[]\n');

    // proj 가 cwd(beforeEach 에서 chdir)이고 config 가 있으므로 --yes 재실행 경로를 탄다.
    // runInit 내부는 process.cwd()(macOS 에서 심링크가 realpath 로 풀린 값)를 쓰므로
    // 비교도 realpath 로 맞춘다(remove.test.ts fixtureProject 와 같은 패턴).
    await runInit({ yes: true });

    expect(listRegisteredProjects().map((p) => p.path)).toContain(fs.realpathSync(proj));
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
    const result = registerProject({
      name: 'x',
      path: proj,
      mainLanguage: ['typescript'],
      character: '',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.count).toBe(1);
    expect(result.skipped).toBe(false);
  });

  it('레인 워크트리(.awl-worktrees 하위) 경로는 등록을 거부한다(registerProject-worktree-guard)', () => {
    const before = registerProject({
      name: 'sentinel',
      path: path.join(proj, '__sentinel__'),
      mainLanguage: [],
      character: '',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    const worktreePath = path.join(proj, '.awl-worktrees', 'some-lane');
    const result = registerProject({
      name: 'some-lane',
      path: worktreePath,
      mainLanguage: ['typescript'],
      character: '',
      registeredAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.skipped).toBe(true);
    expect(result.count).toBe(before.count); // 레지스트리 길이 불변
    const raw = JSON.parse(fs.readFileSync(projectsFile(), 'utf8')) as { path: string }[];
    expect(raw.some((p) => p.path === worktreePath)).toBe(false);
  });

  // ---- 다중-스킬 설치기 (pipeline-multi-skill-installer) ----

  it('installClaudeSkill — engine 의 모든 스킬 디렉토리를 설치한다 (AC-01). 함수 수정 없이 픽스처 2개가 다 깔린다', () => {
    // scaffoldGlobal 이 engine 을 home/engine 으로 복사한다 — 그 위에 더미 스킬을 추가한다.
    scaffoldGlobal();
    const engineClaude = path.join(home, 'engine', 'skills', 'claude');
    const dummyDir = path.join(engineClaude, 'awl-fixture-skill');
    fs.mkdirSync(dummyDir, { recursive: true });
    fs.writeFileSync(path.join(dummyDir, 'SKILL.md'), '# fixture\n');

    const ok = installClaudeSkill(proj);

    expect(ok).toBe(true);
    // 하드코딩된 awl-loop 뿐 아니라 픽스처 스킬도 설치돼야 한다(순회 증명).
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop', 'SKILL.md'))).toBe(true);
    expect(
      fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-fixture-skill', 'SKILL.md')),
    ).toBe(true);
  });

  it('installClaudeSkill — 스킬 하나도 없으면 false (engine skills/claude 비어있음)', () => {
    scaffoldGlobal();
    const engineClaude = path.join(home, 'engine', 'skills', 'claude');
    fs.rmSync(engineClaude, { recursive: true, force: true });
    fs.mkdirSync(engineClaude, { recursive: true });

    expect(installClaudeSkill(proj)).toBe(false);
  });

  it('installClaudeSkill 소스에 스킬 이름 하드코딩이 없다 (AC-01, grep 뮤테이션 가드)', () => {
    const src = fs.readFileSync(path.join(origCwd, 'src', 'commands', 'init.ts'), 'utf8');
    // Claude 설치 로직 구간만 잘라 검사한다 — Codex 라벨/설치기는 awl 마커를
    // 정당하게 참조하므로 제외한다.
    const start = src.indexOf('function claudeSkillNames');
    const end = src.indexOf('export function codexSkillLabel');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).not.toContain('awl-loop');
  });

  it('syncExistingInstall — 설치된 N개 스킬을 모두 재복사한다 (AC-02). engine 원본 변경이 둘 다 반영', () => {
    // 두 스킬(awl-loop + 픽스처)을 engine 에 두고 프로젝트에 설치한다.
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const engineClaude = path.join(home, 'engine', 'skills', 'claude');
    fs.mkdirSync(path.join(engineClaude, 'awl-fixture-skill'), { recursive: true });
    fs.writeFileSync(path.join(engineClaude, 'awl-fixture-skill', 'SKILL.md'), 'v1\n');
    installClaudeSkill(proj); // 픽스처까지 설치(둘 다 .claude/skills 에 존재)

    // engine 원본 내용을 바꾼다(둘 다) — 재실행이 갱신하는지 본다.
    fs.writeFileSync(path.join(engineClaude, 'awl-loop', 'SKILL.md'), 'awl-loop-v2\n');
    fs.writeFileSync(path.join(engineClaude, 'awl-fixture-skill', 'SKILL.md'), 'fixture-v2\n');

    const synced = syncExistingInstall(proj, result.engineVersion, '2026-01-02T00:00:00.000Z');

    expect(synced.skills).toContain('claude');
    expect(
      fs.readFileSync(path.join(proj, '.claude', 'skills', 'awl-loop', 'SKILL.md'), 'utf8'),
    ).toBe('awl-loop-v2\n');
    expect(
      fs.readFileSync(
        path.join(proj, '.claude', 'skills', 'awl-fixture-skill', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('fixture-v2\n');
  });

  it('syncExistingInstall — 재실행이 엔진에 나중 추가된 스킬을 새로 설치한다 (AC-01, 0.6.13 가드 반전)', () => {
    // awl-loop 만 설치한 상태에서 engine 에 픽스처 스킬을 새로 추가한다(엔진에 나중
    // 편입된 awl-pipeline* 을 모사). 0.6.13 은 여기서 미설치를 단언했다 — 이제 반전한다:
    // 업그레이드 경로에서 기존 사용자가 새 엔진 스킬을 재실행만으로 받아야 한다.
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    const result = applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const engineClaude = path.join(home, 'engine', 'skills', 'claude');
    fs.mkdirSync(path.join(engineClaude, 'awl-fixture-skill'), { recursive: true });
    fs.writeFileSync(path.join(engineClaude, 'awl-fixture-skill', 'SKILL.md'), 'v1\n');

    const synced = syncExistingInstall(proj, result.engineVersion, '2026-01-02T00:00:00.000Z');

    expect(synced.skills).toContain('claude');
    // 기존 스킬은 그대로.
    expect(fs.existsSync(path.join(proj, '.claude', 'skills', 'awl-loop'))).toBe(true);
    // engine 에 있으나 .claude/skills 에 없던 스킬이 이제 내용까지 설치된다(반전).
    expect(
      fs.readFileSync(
        path.join(proj, '.claude', 'skills', 'awl-fixture-skill', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('v1\n');
  });

  it('runInit --yes 재실행이 엔진 신규 스킬을 프로젝트에 설치한다 (AC-01 CLI 배선)', async () => {
    // awl-loop 만 설치. 재실행 진입점(runInit --yes 그대로 경로)이 실제로 신규 스킬을
    // 까는지 — syncExistingInstall 단위 테스트가 못 잡는 배선을 잠근다.
    const inputs = nonInteractiveInputs(proj);
    inputs.skills = { claude: true, codex: false };
    applyInit(proj, inputs, '2026-01-01T00:00:00.000Z');
    const engineClaude = path.join(home, 'engine', 'skills', 'claude');
    fs.mkdirSync(path.join(engineClaude, 'awl-fixture-skill'), { recursive: true });
    fs.writeFileSync(path.join(engineClaude, 'awl-fixture-skill', 'SKILL.md'), 'v1\n');

    // proj 가 cwd(beforeEach 에서 chdir)이고 config 가 있으므로 --yes 재실행 경로를 탄다.
    await runInit({ yes: true });

    expect(
      fs.readFileSync(
        path.join(proj, '.claude', 'skills', 'awl-fixture-skill', 'SKILL.md'),
        'utf8',
      ),
    ).toBe('v1\n');
  });
});

describe('claudeSkillLabel — 설치 메뉴 라벨을 실제 스킬 집합에서 파생 (cli-install-menu-label AC-01/02/03)', () => {
  let home: string;

  beforeEach(() => {
    home = tmp('awl-label-home-');
    fs.rmSync(home, { recursive: true, force: true });
    process.env.AWL_HOME = home;
  });

  it('AC-01/AC-03 스킬 2개 픽스처면 라벨이 2개를 표기한다', () => {
    expect(claudeSkillLabel(['awl-loop', 'awl-pipeline-plan'])).toContain('2개');
  });

  it('AC-02/AC-03 개수가 바뀌면 라벨 개수도 바뀐다 — 4개 픽스처는 4개, 2개 아님', () => {
    const label = claudeSkillLabel(['s1', 's2', 's3', 's4']);
    expect(label).toContain('4개');
    expect(label).not.toContain('2개');
  });

  it('AC-01 라벨에 단일 스킬명 하드코딩이 없다 — 목록에 그 이름이 있어도 개수만 표기(뮤테이션 저항)', () => {
    // 스킬 목록에 대표 스킬이 들어 있어도 라벨엔 개수만 나온다.
    const label = claudeSkillLabel(['awl-loop', 'awl-pipeline-exec', 'awl-pipeline-plan']);
    expect(label).not.toContain('awl-loop');
    expect(label).toContain('3개');
  });

  it('Codex 라벨도 실제 스킬 개수를 표시하고 .agents/skills 설치 위치를 알린다', () => {
    const label = codexSkillLabel(['awl-loop', 'awl-pipeline']);
    expect(label).toContain('2개');
    expect(label).toContain('.agents/skills/');
    expect(label).not.toContain('awl-loop');
  });

  it('AC-02 인자 없이 부르면 claudeSkillNames()(engine/skills/claude)의 실제 개수를 읽는다 — 하드코딩 상수 아님', () => {
    scaffoldGlobal(); // engine → home/engine 복사
    const engineClaude = path.join(home, 'engine', 'skills', 'claude');
    fs.rmSync(engineClaude, { recursive: true, force: true });
    fs.mkdirSync(engineClaude, { recursive: true });
    for (const n of ['a1', 'a2', 'a3']) {
      fs.mkdirSync(path.join(engineClaude, n));
    }
    expect(claudeSkillLabel()).toContain('3개');
  });

  it('AC-01/AC-03 skillOptions 메뉴 라벨 구간에 awl-loop 리터럴이 없고 claudeSkillLabel 을 쓴다 (grep 뮤테이션 가드)', () => {
    const src = fs.readFileSync(path.join(origCwd, 'src', 'commands', 'init.ts'), 'utf8');
    const start = src.indexOf('const skillOptions = [');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = src.indexOf('];', start);
    expect(end).toBeGreaterThan(start);
    const region = src.slice(start, end);
    expect(region).not.toContain('awl-loop');
    expect(region).toContain('claudeSkillLabel(');
  });

  it('버그 수정: engineDir 가 아직 없으면(최초 설치) packageEngineDir 로 미리보기해 0개로 잘못 보이지 않는다', () => {
    // scaffoldGlobal() 을 부르지 않는다 — "스킬 선택 화면이 실제 설치보다 먼저 뜨는"
    // 최초 실행 시나리오(engineDir 가 아예 없음)를 그대로 재현한다.
    expect(fs.existsSync(path.join(home, 'engine'))).toBe(false);
    const realCount = fs
      .readdirSync(path.join(origCwd, 'engine', 'skills', 'claude'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length;
    expect(realCount).toBeGreaterThan(0); // 이 가드 자체가 무의미해지지 않게.
    const label = claudeSkillLabel();
    expect(label).toContain(`${realCount}개`);
    expect(label).not.toContain('0개');
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

describe('scanGitProjects — git 프로젝트 스캔 (init-project-picker AC-02)', () => {
  it('하위 .git 디렉토리를 찾고 node_modules·cwd자신·깊이초과를 제외한다', () => {
    const root = fs.realpathSync(tmp('awl-scan-'));
    const mk = (rel: string) => {
      const d = path.join(root, rel);
      fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    };
    fs.mkdirSync(path.join(root, '.git'), { recursive: true }); // cwd 자신 git — 제외돼야
    mk('proj-a'); // depth 1
    mk('sub/proj-b'); // depth 2
    mk('node_modules/proj-c'); // node_modules 안 — 제외
    mk('a/b/c/proj-deep'); // depth 4 — maxdepth 3 초과 제외

    const names = scanGitProjects(root).map((f) => f.name);
    expect(names).toContain('proj-a');
    expect(names).toContain('proj-b');
    expect(names).not.toContain('proj-c'); // node_modules 내부
    expect(names).not.toContain('proj-deep'); // 깊이 초과
    expect(names).not.toContain(path.basename(root)); // cwd 자신
  });

  it('mtime 내림차순 정렬 + 최대 20개로 자른다', () => {
    const root = fs.realpathSync(tmp('awl-scan2-'));
    for (let i = 0; i < 25; i++) {
      fs.mkdirSync(path.join(root, `p${i}`, '.git'), { recursive: true });
    }
    const found = scanGitProjects(root);
    expect(found.length).toBe(20); // 25개 중 20개로 캡
    // mtime 내림차순(비증가) 정렬.
    for (let i = 1; i < found.length; i++) {
      expect(found[i - 1]?.mtimeMs).toBeGreaterThanOrEqual(found[i]?.mtimeMs ?? 0);
    }
  });
});

describe('resolveProjectChoice — 셀렉터 인덱스 해석 (init-project-picker AC-04)', () => {
  const cands = [
    { path: '/a', name: 'a', mtimeMs: 2 },
    { path: '/b', name: 'b', mtimeMs: 1 },
  ];
  it('0..n-1 은 후보, n 은 직접입력, 그 외는 취소', () => {
    expect(resolveProjectChoice(0, cands)).toEqual({ kind: 'path', path: '/a' });
    expect(resolveProjectChoice(1, cands)).toEqual({ kind: 'path', path: '/b' });
    expect(resolveProjectChoice(2, cands)).toEqual({ kind: 'type' }); // n = 직접 입력
    expect(resolveProjectChoice(3, cands)).toEqual({ kind: 'cancel' });
    expect(resolveProjectChoice(-1, cands)).toEqual({ kind: 'cancel' });
  });
  it('후보 0개면 0 = 직접입력, 1 = 취소', () => {
    expect(resolveProjectChoice(0, [])).toEqual({ kind: 'type' });
    expect(resolveProjectChoice(1, [])).toEqual({ kind: 'cancel' });
  });
});

describe('registeredProjectPaths / excludeRegisteredProjects — 이미 등록된 프로젝트는 후보에서 제외 (init-project-picker)', () => {
  let home: string;

  beforeEach(() => {
    home = tmp('awl-registered-home-');
    process.env.AWL_HOME = home;
  });

  it('projects.json 이 없으면 빈 집합(안전 폴백)', () => {
    expect(registeredProjectPaths().size).toBe(0);
  });

  it('projects.json 파싱에 실패해도 빈 집합(throw 안 함)', () => {
    fs.writeFileSync(path.join(home, 'projects.json'), 'not json');
    expect(registeredProjectPaths().size).toBe(0);
  });

  it('등록된 경로를 realpath 로 정규화한 집합으로 돌려준다', () => {
    const p1 = fs.realpathSync(tmp('awl-reg-p1-'));
    fs.writeFileSync(path.join(home, 'projects.json'), JSON.stringify([{ name: 'p1', path: p1 }]));
    expect(registeredProjectPaths().has(p1)).toBe(true);
  });

  it('excludeRegisteredProjects — 등록된 후보는 빠지고, 등록 안 된 후보는 남는다', () => {
    const p1 = fs.realpathSync(tmp('awl-reg-p1-'));
    const p2 = fs.realpathSync(tmp('awl-reg-p2-'));
    const candidates = [
      { path: p1, name: 'p1', mtimeMs: 1 },
      { path: p2, name: 'p2', mtimeMs: 2 },
    ];
    const filtered = excludeRegisteredProjects(candidates, new Set([p1]));
    expect(filtered.map((c) => c.name)).toEqual(['p2']);
  });

  it('listRegisteredProjects — projects.json 이 없으면 빈 배열(안전 폴백)', () => {
    expect(listRegisteredProjects()).toEqual([]);
  });

  it('listRegisteredProjects — 이름+경로를 그대로 돌려준다(awl-update-local 이 순회하는 형태)', () => {
    const p1 = tmp('awl-reg-list-p1-');
    fs.writeFileSync(
      path.join(home, 'projects.json'),
      JSON.stringify([{ name: 'my-project', path: p1 }]),
    );
    expect(listRegisteredProjects()).toEqual([{ name: 'my-project', path: p1 }]);
  });

  it('excludeRegisteredProjects — 등록된 게 없으면 후보를 그대로 돌려준다(no-op)', () => {
    const candidates = [{ path: '/a', name: 'a', mtimeMs: 1 }];
    expect(excludeRegisteredProjects(candidates, new Set())).toEqual(candidates);
  });

  it('통합: scanGitProjects 후보 중 등록된 프로젝트가 최종 후보(=labels 소스)에서 빠진다', () => {
    const root = fs.realpathSync(tmp('awl-scan-reg-'));
    fs.mkdirSync(path.join(root, 'proj-registered', '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'proj-new', '.git'), { recursive: true });
    const registeredPath = fs.realpathSync(path.join(root, 'proj-registered'));
    fs.writeFileSync(
      path.join(home, 'projects.json'),
      JSON.stringify([{ name: 'proj-registered', path: registeredPath }]),
    );

    // pickProjectRoot 내부와 동일한 조합(excludeRegisteredProjects(scanGitProjects(cwd), registeredProjectPaths())).
    const candidates = excludeRegisteredProjects(scanGitProjects(root), registeredProjectPaths());
    const names = candidates.map((c) => c.name);
    expect(names).toContain('proj-new');
    expect(names).not.toContain('proj-registered');
  });
});

describe('renderResult — 결과 값 emphasis 강조 (cli-visual-consistency AC-08, 리뷰)', () => {
  const inputs: InitInputs = {
    project: 'proj',
    mainLanguage: ['typescript'],
    character: 'x',
    verify: { typecheck: null, lint: null, test: null, e2e: null },
    skills: { claude: true, codex: false },
  };
  const result = {
    globalCreated: true,
    engineVersion: '0.6.8',
    configPath: '/p/.awl/config.json',
    statePath: '/p/.awl/state.json',
    gitignore: 'added' as const,
    skills: ['claude'],
    projectCount: 1,
    registrationSkipped: false,
    ruleCount: 0,
    lessonCount: 0,
    safetyHook: { installed: true },
  };
  it('색 모드에서 결과 값(engineVersion 등)을 bold 로 강조한다', () => {
    const text = renderResult(result, inputs, { unicode: true, color: true, tty: true });
    expect(text).toContain('\x1b[1m0.6.8\x1b[0m'); // 값 bold
  });
  it('색 없음이면 값은 평문(no-op)', () => {
    const text = renderResult(result, inputs, { unicode: false, color: false, tty: false });
    expect(text).toContain('0.6.8');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 부재 확인
    expect(/\x1b\[/.test(text)).toBe(false);
  });

  it('첫 줄(제목 바로 아래)에 설치된 엔진 버전을 [v...] 형태로 보여준다(사용자 피드백 — 최신 버전 확인용)', () => {
    const text = renderResult(result, inputs, { unicode: true, color: false, tty: true });
    const lines = text.split('\n');
    // lines[0] 은 renderResult 가 맨 앞에 넣는 빈 줄, lines[1] 이 '설정 완료' 상단 테두리다.
    expect(lines[1]).toContain('설정 완료');
    expect(lines[2]).toContain('[v0.6.8]');
  });
});
