import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  type AwlConfig,
  SETTABLE_KEYS,
  applyConfigValue,
  interactiveEditMenu,
  loadConfig,
  parseConfigKey,
  parseVerifyValue,
  validateConfig,
} from '../../src/commands/config.js';

const NODE = process.execPath;

function freshConfig(): AwlConfig {
  return {
    project: 'maxflow',
    mainLanguage: 'javascript', // WI-A 가 고칠 오판 시나리오를 흉내낸다
    character: '',
    engineVersion: '0.1.0',
    verify: {
      typecheck: { cmd: 'tsc --noEmit' },
      lint: null,
      test: null,
      e2e: null,
    },
  };
}

function projectWithConfig(text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-cfg-'));
  fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
  fs.writeFileSync(path.join(root, '.awl', 'config.json'), text);
  return root;
}

const VALID = JSON.stringify({
  project: 'maxflow',
  mainLanguage: 'typescript',
  character: '디자인 토큰 강제',
  engineVersion: '0.0.0',
  verify: { typecheck: { cmd: 'tsc --noEmit' }, lint: null, test: null, e2e: null },
});

describe('validateConfig', () => {
  it('정상 config 는 통과(빈 오류)', () => {
    expect(validateConfig(JSON.parse(VALID))).toEqual([]);
  });

  it('project 가 없으면 거부', () => {
    const errors = validateConfig({ engineVersion: '0.0.0', verify: {} });
    expect(errors.some((e) => e.includes('project'))).toBe(true);
  });

  it('verify 항목 형식이 틀리면 잡는다', () => {
    const errors = validateConfig({
      project: 'x',
      engineVersion: '0.0.0',
      verify: { lint: 'eslint .' }, // 문자열은 형식 오류 (null 또는 {cmd})
    });
    expect(errors.some((e) => e.includes('verify.lint'))).toBe(true);
  });
});

describe('loadConfig', () => {
  it('정상 파일을 로드하고 verify 를 정규화한다', () => {
    const root = projectWithConfig(VALID);
    const { config, errors } = loadConfig(root);
    expect(errors).toEqual([]);
    expect(config?.project).toBe('maxflow');
    expect(config?.verify.typecheck).toEqual({ cmd: 'tsc --noEmit' });
    expect(config?.verify.e2e).toBeNull();
  });

  it('JSON 이 깨지면 대략적인 줄 번호를 알려준다', () => {
    const root = projectWithConfig('{\n  "project": "x",\n  bad\n}');
    const { config, errors } = loadConfig(root);
    expect(config).toBeNull();
    expect(errors[0]).toContain('파싱 오류');
  });

  it('파일이 없으면 init 안내', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-cfg-'));
    const { config, errors } = loadConfig(root);
    expect(config).toBeNull();
    expect(errors[0]).toContain('awl init');
  });
});

describe('parseVerifyValue', () => {
  it('명령 문자열을 cmd 로', () => {
    expect(parseVerifyValue('biome check .')).toEqual({ cmd: 'biome check .' });
  });
  it('인라인 env 를 분리', () => {
    expect(parseVerifyValue('NODE_ENV=test vitest run')).toEqual({
      cmd: 'vitest run',
      env: { NODE_ENV: 'test' },
    });
  });
  it('null/none/- 은 null', () => {
    expect(parseVerifyValue('null')).toBeNull();
    expect(parseVerifyValue('-')).toBeNull();
  });
});

describe('parseConfigKey — 지원하는 모든 키 (Part 0-4)', () => {
  it('project/mainLanguage/character', () => {
    expect(parseConfigKey('project')).toEqual({ kind: 'project' });
    expect(parseConfigKey('mainLanguage')).toEqual({ kind: 'mainLanguage' });
    expect(parseConfigKey('character')).toEqual({ kind: 'character' });
  });

  it('verify.<name>.cmd/.cwd/.env', () => {
    expect(parseConfigKey('verify.lint.cmd')).toEqual({ kind: 'verify.cmd', verifyName: 'lint' });
    expect(parseConfigKey('verify.lint.cwd')).toEqual({ kind: 'verify.cwd', verifyName: 'lint' });
    expect(parseConfigKey('verify.lint.env')).toEqual({ kind: 'verify.env', verifyName: 'lint' });
  });

  it('verify.<name> (접미사 없음)은 하위 호환으로 .cmd 취급', () => {
    expect(parseConfigKey('verify.test')).toEqual({ kind: 'verify.cmd', verifyName: 'test' });
  });

  it('알 수 없는 키는 null', () => {
    expect(parseConfigKey('nope')).toBeNull();
    expect(parseConfigKey('verify.nope.cmd')).toBeNull();
  });

  it('SETTABLE_KEYS 는 12개 verify 키 + project/mainLanguage/character', () => {
    expect(SETTABLE_KEYS).toContain('verify.lint.cwd');
    expect(SETTABLE_KEYS).toContain('verify.e2e.env');
    expect(SETTABLE_KEYS.length).toBe(3 + 4 * 3);
  });
});

describe('applyConfigValue — 키마다 검증 규칙이 다르다', () => {
  it('mainLanguage: 오판된 값(javascript)을 typescript 로 고칠 수 있다 (WI-A 의 전제)', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'mainLanguage' }, 'typescript', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.mainLanguage).toBe('typescript');
  });

  it('mainLanguage: 알려지지 않은 값도 허용하되 경고한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'mainLanguage' }, 'rust', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.mainLanguage).toBe('rust');
    expect(outcome.message).toContain('경고');
  });

  it('character: 검증 없이 자유 텍스트', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'character' },
      '디자인 토큰 강제',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.character).toBe('디자인 토큰 강제');
  });

  it('project: 빈 값은 거부', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'project' }, '  ', {
      force: false,
    });
    expect(outcome.ok).toBe(false);
    expect(config.project).toBe('maxflow'); // 안 바뀜
  });

  it('verify.cmd: 실제 존재하는 명령이면 통과하고 저장한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cmd', verifyName: 'lint' },
      NODE,
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.lint?.cmd).toBe(NODE);
  });

  it('verify.cmd: 없는 명령은 거부(--force 없이)', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cmd', verifyName: 'lint' },
      'awl_no_such_tool_zzz .',
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    expect(config.verify.lint).toBeNull(); // 저장 안 됨
  });

  it('verify.cmd: --force 면 없는 명령도 저장한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cmd', verifyName: 'lint' },
      'awl_no_such_tool_zzz .',
      { force: true },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.lint?.cmd).toBe('awl_no_such_tool_zzz .');
  });

  it('verify.cwd: 존재하는 디렉토리(프로젝트 루트 기준 상대경로)를 저장한다', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-cwd-'));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    const config = freshConfig();
    config.verify.typecheck = { cmd: 'tsc --noEmit' };
    const outcome = await applyConfigValue(
      config,
      root,
      { kind: 'verify.cwd', verifyName: 'typecheck' },
      'packages/app',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.typecheck?.cwd).toBe('packages/app');
  });

  it('verify.cwd: 없는 디렉토리는 거부(--force 없이)', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cwd', verifyName: 'typecheck' },
      'no/such/dir',
      { force: false },
    );
    expect(outcome.ok).toBe(false);
    expect(config.verify.typecheck?.cwd).toBeUndefined();
  });

  it('verify.cwd: 절대경로는 허용하되 경고한다', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-cwd-'));
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cwd', verifyName: 'typecheck' },
      root,
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain('경고');
    expect(outcome.message).toContain('절대 경로');
  });

  it('verify.cwd: cmd 가 설정 안 된 항목이면 거부', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cwd', verifyName: 'lint' }, // lint 는 freshConfig 에서 null
      '.',
      { force: false },
    );
    expect(outcome.ok).toBe(false);
  });

  it('verify.env: JSON 객체를 저장한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.env', verifyName: 'typecheck' },
      '{"NODE_ENV":"test"}',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.typecheck?.env).toEqual({ NODE_ENV: 'test' });
  });

  it('verify.env: JSON 이 아니면 거부', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.env', verifyName: 'typecheck' },
      'not json',
      { force: false },
    );
    expect(outcome.ok).toBe(false);
  });

  it('verify.cmd 만 바꿀 때 기존 cwd 를 보존한다', async () => {
    const config = freshConfig();
    config.verify.typecheck = { cmd: 'tsc --noEmit', cwd: 'packages/app' };
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'verify.cmd', verifyName: 'typecheck' },
      NODE,
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.typecheck).toEqual({ cmd: NODE, cwd: 'packages/app' });
  });
});

// 실제 TTY 대신 in-memory 스트림으로 readline 을 구동한다. PTY 는 macOS/CI 에서
// 불안정해 신뢰할 수 없다(script 명령으로 시도했으나 입력 전달이 들쭉날쭉했다).
//
// readline 은 question() 이 걸려 있지 않을 때 도착한 줄을 그냥 버린다(질문마다
// 오는 한 번의 대답을 기다리는 대화형 프롬프트가 전제라서다). 그래서 답을 전부
// 미리 스트림에 써두는 방식은 통하지 않는다 — question() 이 호출될 때마다 다음
// 답 하나를 그 직후(nextTick)에 흘려보내야 한다.
describe('interactiveEditMenu — init 의 buildScreens 를 재사용한 인터랙티브 수정', () => {
  const CAPS = { unicode: false, color: false, tty: false };

  function makeRL(answers: string[]): readline.Interface {
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {}); // 프롬프트 텍스트는 검증 대상이 아니다. 드레인만 한다.
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

  it('메뉴에서 주 언어를 골라 오판(javascript)을 typescript 로 고친다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig(); // mainLanguage: 'javascript'
    const rl = makeRL(['2', '1']); // 2=주 언어 메뉴, 1=TypeScript 선택
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(true);
    expect(config.mainLanguage).toBe('typescript');
  });

  it('"그대로 둔다"(1번)를 고르면 아무것도 안 바뀐다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    const rl = makeRL(['1']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(false);
    expect(config.mainLanguage).toBe('javascript');
  });

  it('성격을 자유 텍스트로 고친다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    const rl = makeRL(['4', '디자인 토큰 강제. 자유 px 금지']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(true);
    expect(config.character).toBe('디자인 토큰 강제. 자유 px 금지');
  });

  it('프로젝트 이름을 고친다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    const rl = makeRL(['5', 'new-name']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(true);
    expect(config.project).toBe('new-name');
  });

  it('검증 명령어 메뉴에서 존재하는 명령으로 고친다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    // typecheck/lint/test/e2e 순서로 물어본다. typecheck 만 바꾸고 나머지는 빈 줄(유지).
    const rl = makeRL(['3', NODE, '', '', '']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(true);
    expect(config.verify.typecheck?.cmd).toBe(NODE);
    expect(config.verify.lint).toBeNull(); // 안 바뀜
  });
});
