import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AwlConfig,
  SETTABLE_KEYS,
  applyConfigValue,
  interactiveEditMenu,
  loadConfig,
  parseConfigKey,
  parseVerifyValue,
  resolveProjectScope,
  runConfig,
  runConfigSet,
  validateConfig,
} from '../../src/commands/config.js';
import { applyInit, nonInteractiveInputs } from '../../src/commands/init.js';
import { buildProgram } from '../../src/program.js';

const NODE = process.execPath;

function freshConfig(): AwlConfig {
  return {
    project: 'maxflow',
    mainLanguage: ['javascript'], // WI-A 가 고칠 오판 시나리오를 흉내낸다
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

function writeLocalOverlay(root: string, value: unknown): string {
  const overlayPath = path.join(root, '.git', 'awl', 'config.local.json');
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  fs.writeFileSync(overlayPath, `${JSON.stringify(value, null, 2)}\n`);
  return overlayPath;
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

  it('tracked base를 먼저 검증한 뒤 local project와 partial feedback만 병합한다', () => {
    const root = projectWithConfig(
      JSON.stringify({
        project: 'base-project',
        mainLanguage: ['typescript'],
        character: 'upstream character',
        engineVersion: '0.7.3',
        verify: { lint: { cmd: 'biome check .' } },
        feedback: { enabled: false, path: '/base/feedback' },
      }),
    );
    fs.mkdirSync(path.join(root, '.git'));
    const overlayPath = writeLocalOverlay(root, {
      project: 'lane-project',
      feedback: { enabled: true },
    });

    const loaded = loadConfig(root);

    expect(loaded.errors).toEqual([]);
    expect(loaded.basePath).toBe(path.join(root, '.awl', 'config.json'));
    expect(loaded.overlayPath).toBe(
      path.join(fs.realpathSync(path.join(root, '.git')), 'awl', 'config.local.json'),
    );
    expect(fs.realpathSync(overlayPath)).toBe(loaded.overlayPath);
    expect(loaded.config).toMatchObject({
      project: 'lane-project',
      character: 'upstream character',
      feedback: { enabled: true, path: '/base/feedback' },
    });
  });

  it('overlay JSON/schema 오류는 base 오류와 구분하고 effective config를 반환하지 않는다', () => {
    const root = projectWithConfig(VALID);
    fs.mkdirSync(path.join(root, '.git'));
    const overlayPath = writeLocalOverlay(root, { verify: {} });

    const invalidSchema = loadConfig(root);
    expect(invalidSchema.config).toBeNull();
    expect(invalidSchema.errors.join('\n')).toContain('local config overlay');
    expect(invalidSchema.errors.join('\n')).toContain('지원하지 않는 키');

    fs.writeFileSync(overlayPath, '{ broken');
    const invalidJson = loadConfig(root);
    expect(invalidJson.config).toBeNull();
    expect(invalidJson.errors.join('\n')).toContain('local config overlay JSON 파싱 오류');
  });

  it('base가 잘못되면 malformed overlay보다 base 오류를 먼저 보고한다', () => {
    const root = projectWithConfig('{\n broken');
    fs.mkdirSync(path.join(root, '.git'));
    const overlayPath = writeLocalOverlay(root, {});
    fs.writeFileSync(overlayPath, '{ also broken');

    const loaded = loadConfig(root);

    expect(loaded.config).toBeNull();
    expect(loaded.errors[0]).toContain('config.json JSON 파싱 오류');
    expect(loaded.errors.join('\n')).not.toContain('local config overlay');
  });
});

describe('config JSON/source output and local writes', () => {
  const startingCwd = process.cwd();

  afterEach(() => {
    process.chdir(startingCwd);
    vi.restoreAllMocks();
  });

  function gitProject(): string {
    const root = fs.realpathSync(projectWithConfig(VALID));
    fs.mkdirSync(path.join(root, '.git'));
    return root;
  }

  it('program은 config --json과 config set --local을 노출한다', () => {
    const configCommand = buildProgram().commands.find((command) => command.name() === 'config');
    const setCommand = configCommand?.commands.find((command) => command.name() === 'set');

    expect(configCommand?.options.some((option) => option.long === '--json')).toBe(true);
    expect(setCommand?.options.some((option) => option.long === '--local')).toBe(true);
  });

  it('config --json은 base/overlay 경로, effective 값, override source를 출력한다', async () => {
    const root = gitProject();
    writeLocalOverlay(root, { project: 'lane', feedback: { enabled: true } });
    process.chdir(root);
    let stdout = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout += String(chunk);
      return true;
    });

    await runConfig({ json: true });

    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      basePath: path.join(root, '.awl', 'config.json'),
      overlayPath: path.join(root, '.git', 'awl', 'config.local.json'),
      effective: { project: 'lane', feedback: { enabled: true } },
      sources: {
        project: 'local',
        'feedback.enabled': 'local',
        'feedback.path': 'base',
      },
    });
  });

  it('config set --local은 base를 보존하고 지원 key만 overlay에 원자 갱신한다', async () => {
    const root = gitProject();
    process.chdir(root);
    const basePath = path.join(root, '.awl', 'config.json');
    const before = fs.readFileSync(basePath, 'utf8');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runConfigSet('project', 'lane', { force: false, local: true });
    await runConfigSet('feedback.enabled', 'true', { force: false, local: true });
    await runConfigSet('feedback.path', '/lane/feedback', { force: false, local: true });

    expect(fs.readFileSync(basePath, 'utf8')).toBe(before);
    const overlayPath = path.join(root, '.git', 'awl', 'config.local.json');
    expect(JSON.parse(fs.readFileSync(overlayPath, 'utf8'))).toEqual({
      project: 'lane',
      feedback: { enabled: true, path: '/lane/feedback' },
    });
    expect(
      fs.readdirSync(path.dirname(overlayPath)).filter((name) => name.includes('.tmp')),
    ).toEqual([]);
  });

  it.each([
    { name: '지원하지 않는 local key', key: 'character', withGit: true },
    { name: 'git worktree가 아닌 scope', key: 'project', withGit: false },
  ])('$name은 overlay를 쓰기 전에 거부한다', async ({ key, withGit }) => {
    const root = fs.realpathSync(projectWithConfig(VALID));
    if (withGit) {
      fs.mkdirSync(path.join(root, '.git'));
    }
    process.chdir(root);
    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);

    await expect(runConfigSet(key, 'value', { force: false, local: true })).rejects.toThrow(
      'exit:1',
    );
    expect(stderr).toMatch(withGit ? /local.*지원|지원.*local/i : /git.*worktree/i);
    expect(fs.existsSync(path.join(root, '.git', 'awl', 'config.local.json'))).toBe(false);
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

  it('SETTABLE_KEYS 는 protectedFiles 를 포함한 모든 설정 키를 노출한다', () => {
    expect(SETTABLE_KEYS).toContain('verify.lint.cwd');
    expect(SETTABLE_KEYS).toContain('verify.e2e.env');
    expect(SETTABLE_KEYS).toContain('namingConvention');
    expect(SETTABLE_KEYS).toContain('relatedCmd');
    expect(SETTABLE_KEYS).toContain('protectedFiles');
    expect(SETTABLE_KEYS).toContain('feedback.enabled');
    expect(SETTABLE_KEYS).toContain('feedback.path');
    expect(SETTABLE_KEYS.length).toBe(8 + 4 * 3);
  });
});

describe('applyConfigValue — 키마다 검증 규칙이 다르다', () => {
  it('mainLanguage: 오판된 값(javascript)을 typescript 로 고칠 수 있다 (WI-A 의 전제)', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'mainLanguage' }, 'typescript', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.mainLanguage).toEqual(['typescript']);
  });

  it('mainLanguage: 알려지지 않은 값도 허용하되 경고한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'mainLanguage' }, 'rust', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.mainLanguage).toEqual(['rust']);
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

  it('namingConvention: 알려진 값(kebab-case 등)은 경고 없이 저장 (WI-I AC-01)', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'namingConvention' },
      'kebab-case',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.namingConvention).toBe('kebab-case');
    expect(outcome.message).not.toContain('경고');
  });

  it('namingConvention: 모르는 값도 저장은 하되 경고한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'namingConvention' },
      'Upper_Snake',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.namingConvention).toBe('Upper_Snake');
    expect(outcome.message).toContain('경고');
  });

  it('namingConvention: 빈 값이면 비운다', async () => {
    const config = freshConfig();
    config.namingConvention = 'kebab-case';
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'namingConvention' }, '  ', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.namingConvention).toBeUndefined();
  });

  it('relatedCmd: {files} 자리표시자가 있으면 저장 (WI-I AC-04)', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'relatedCmd' },
      'vitest related {files} --run',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.relatedCmd).toBe('vitest related {files} --run');
  });

  it('relatedCmd: {files} 자리표시자가 없으면 거부한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'relatedCmd' }, 'vitest run', {
      force: false,
    });
    expect(outcome.ok).toBe(false);
    expect(config.relatedCmd).toBeUndefined();
  });

  it('relatedCmd: 빈 값이면 비운다', async () => {
    const config = freshConfig();
    config.relatedCmd = 'vitest related {files}';
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'relatedCmd' }, '  ', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.relatedCmd).toBeUndefined();
  });

  it('project: 빈 값은 거부', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'project' }, '  ', {
      force: false,
    });
    expect(outcome.ok).toBe(false);
    expect(config.project).toBe('maxflow'); // 안 바뀜
  });

  it('parseConfigKey: feedback.enabled / feedback.path 를 인식한다', () => {
    expect(parseConfigKey('feedback.enabled')).toEqual({ kind: 'feedback.enabled' });
    expect(parseConfigKey('feedback.path')).toEqual({ kind: 'feedback.path' });
  });

  it.each(['true', 'TRUE', 'on', '1'])(
    'feedback.enabled: "%s" 는 true 로 저장한다',
    async (raw) => {
      const config = freshConfig();
      const outcome = await applyConfigValue(config, '/tmp', { kind: 'feedback.enabled' }, raw, {
        force: false,
      });
      expect(outcome.ok).toBe(true);
      expect(config.feedback?.enabled).toBe(true);
    },
  );

  it.each(['false', 'off', '0'])('feedback.enabled: "%s" 는 false 로 저장한다', async (raw) => {
    const config = freshConfig();
    config.feedback = { enabled: true };
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'feedback.enabled' }, raw, {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.feedback?.enabled).toBe(false);
  });

  it('feedback.enabled: true/false 가 아닌 값은 거부하고 기존 값을 보존한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'feedback.enabled' }, 'maybe', {
      force: false,
    });
    expect(outcome.ok).toBe(false);
    expect(config.feedback).toBeUndefined();
  });

  it('feedback.enabled: 이미 path 가 설정돼 있으면 enabled 만 바꿔도 path 를 보존한다', async () => {
    const config = freshConfig();
    config.feedback = { enabled: false, path: '/tmp/custom-feedback' };
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'feedback.enabled' }, 'true', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.feedback).toEqual({ enabled: true, path: '/tmp/custom-feedback' });
  });

  it('feedback.path: 절대경로를 저장한다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'feedback.path' },
      '/tmp/custom-feedback',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.feedback?.path).toBe('/tmp/custom-feedback');
  });

  it('feedback.path: 상대경로는 저장하되 경고를 붙인다', async () => {
    const config = freshConfig();
    const outcome = await applyConfigValue(
      config,
      '/tmp',
      { kind: 'feedback.path' },
      'relative/feedback',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.feedback?.path).toBe('relative/feedback');
    expect(outcome.message).toMatch(/상대경로/);
  });

  it('feedback.path: 빈 값이면 비워서 기본값으로 되돌린다', async () => {
    const config = freshConfig();
    config.feedback = { enabled: true, path: '/tmp/custom-feedback' };
    const outcome = await applyConfigValue(config, '/tmp', { kind: 'feedback.path' }, '  ', {
      force: false,
    });
    expect(outcome.ok).toBe(true);
    expect(config.feedback?.path).toBeUndefined();
    expect(config.feedback?.enabled).toBe(true); // enabled 는 안 건드림
  });

  it('validateConfig: feedback.enabled 가 boolean 이 아니면 에러', () => {
    const errors = validateConfig({
      project: 'x',
      engineVersion: '0.1.0',
      verify: {},
      feedback: { enabled: 'yes' },
    });
    expect(errors.some((e) => e.includes('feedback.enabled'))).toBe(true);
  });

  it('loadConfig: feedback 필드를 왕복한다(round-trip)', () => {
    const root = projectWithConfig(
      JSON.stringify({
        project: 'x',
        engineVersion: '0.1.0',
        verify: {},
        feedback: { enabled: true, path: '/tmp/custom-feedback' },
      }),
    );
    const result = loadConfig(root);
    expect(result.errors).toEqual([]);
    expect(result.config?.feedback).toEqual({ enabled: true, path: '/tmp/custom-feedback' });
  });

  it('loadConfig: feedback 필드가 없으면 undefined(기본 disabled)로 읽힌다', () => {
    const root = projectWithConfig(
      JSON.stringify({ project: 'x', engineVersion: '0.1.0', verify: {} }),
    );
    const result = loadConfig(root);
    expect(result.errors).toEqual([]);
    expect(result.config?.feedback).toBeUndefined();
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
    // AC-08: 존재 확인도 그 cwd 로 하므로, 실제로 존재하는 디렉토리여야 한다.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-cfg-preserve-')));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    const config = freshConfig();
    config.verify.typecheck = { cmd: 'tsc --noEmit', cwd: 'packages/app' };
    const outcome = await applyConfigValue(
      config,
      root,
      { kind: 'verify.cmd', verifyName: 'typecheck' },
      NODE,
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.typecheck).toEqual({ cmd: NODE, cwd: 'packages/app' });
  });

  it('verify.cmd: 존재 확인도 기존 cwd 기준으로 한다 (AC-08, maxflow 재현 — cwd 없이 확인하면 실패했을 명령)', async () => {
    // packages/app 안에서만 풀리는 상대경로 실행파일 — cwd 를 안 쓰고 확인하면 실패한다.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-cfg-cwd-')));
    fs.mkdirSync(path.join(root, 'packages', 'app'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    const toolPath = path.join(root, 'node_modules', '.bin', 'fake-tool');
    fs.writeFileSync(toolPath, `#!/usr/bin/env node\nprocess.stdout.write('ok');\n`);
    fs.chmodSync(toolPath, 0o755);

    const config = freshConfig();
    config.verify.typecheck = { cmd: 'old-placeholder', cwd: 'packages/app' };
    const outcome = await applyConfigValue(
      config,
      root,
      { kind: 'verify.cmd', verifyName: 'typecheck' },
      '../../node_modules/.bin/fake-tool',
      { force: false },
    );
    expect(outcome.ok).toBe(true);
    expect(config.verify.typecheck).toEqual({
      cmd: '../../node_modules/.bin/fake-tool',
      cwd: 'packages/app',
    });
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
    expect(config.mainLanguage).toEqual(['typescript']);
  });

  it('"그대로 둔다"(1번)를 고르면 아무것도 안 바뀐다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    const rl = makeRL(['1']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(false);
    expect(config.mainLanguage).toEqual(['javascript']);
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

  it('피드백 모드를 켜고 경로는 비워서 그대로 둔다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    // 6=피드백 모드, 1=켜짐(selectSingle 첫 옵션), 빈 줄=경로 그대로.
    const rl = makeRL(['6', '1', '']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(true);
    expect(config.feedback?.enabled).toBe(true);
    expect(config.feedback?.path).toBeUndefined();
  });

  it('피드백 모드를 끄고 경로도 함께 바꾼다', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const config = freshConfig();
    config.feedback = { enabled: true, path: '/old/path' };
    // 6=피드백 모드, 2=꺼짐(selectSingle 두번째 옵션), 새 경로 입력.
    const rl = makeRL(['6', '2', '/new/path']);
    const changed = await interactiveEditMenu(rl, config, '/tmp', CAPS);
    rl.close();
    stdoutSpy.mockRestore();

    expect(changed).toBe(true);
    expect(config.feedback?.enabled).toBe(false);
    expect(config.feedback?.path).toBe('/new/path');
  });
});

// --- config-anywhere-fallback: cwd 밖에서도 등록된 프로젝트를 보여준다 ---

const origCwd = process.cwd();
const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** applyInit 으로 config.json + projects.json 등록까지 한 번에 갖춘 프로젝트를 만든다. */
function registeredProject(name: string): string {
  const root = tmp(`awl-multi-${name}-`);
  const inputs = nonInteractiveInputs(root);
  inputs.project = name;
  applyInit(root, inputs, '2026-01-01T00:00:00.000Z');
  return root;
}

describe('resolveProjectScope — config-anywhere-fallback', () => {
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  it('cwd 가 프로젝트 안이면 등록 목록과 무관하게 single 이다', () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const proj = registeredProject('solo');
    expect(resolveProjectScope(proj).mode).toBe('single');
  });

  it('cwd 밖이고 등록된 프로젝트가 있으면 multi 로 폴백한다', () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const a = registeredProject('proj-a');
    const b = registeredProject('proj-b');
    const lonely = tmp('awl-multi-lonely-');

    const scope = resolveProjectScope(lonely);
    expect(scope.mode).toBe('multi');
    expect(scope.projects?.map((p) => p.path).sort()).toEqual([a, b].sort());
  });

  it('cwd 밖이고 등록된 프로젝트도 없으면 none 이다', () => {
    process.env.AWL_HOME = tmp('awl-multi-home-empty-');
    expect(resolveProjectScope(tmp('awl-multi-lonely2-')).mode).toBe('none');
  });

  it('등록됐지만 경로가 사라진 프로젝트는 목록에서 빠진다', () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const a = registeredProject('proj-alive-1');
    const b = registeredProject('proj-alive-2');
    const gone = registeredProject('proj-gone');
    fs.rmSync(gone, { recursive: true, force: true });

    const scope = resolveProjectScope(tmp('awl-multi-lonely3-'));
    expect(scope.mode).toBe('multi');
    expect(scope.projects?.map((p) => p.path).sort()).toEqual([a, b].sort());
  });

  it('등록된 프로젝트가 정확히 1개면 cd 없이 그 프로젝트로 single 자동 선택된다', () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const solo = registeredProject('proj-solo');

    const scope = resolveProjectScope(tmp('awl-multi-lonely4-'));
    expect(scope.mode).toBe('single');
    expect(scope.projectRoot).toBe(solo);
  });
});

describe('runConfig / runConfigSet — cwd 밖에서는 조회만, 쓰기는 거부(config-anywhere-fallback)', () => {
  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  it('runConfig: 등록된 프로젝트 전부를 읽기전용으로 보여주고 인터랙티브 메뉴로 안 들어간다', async () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const a = registeredProject('view-a');
    const b = registeredProject('view-b');
    process.chdir(tmp('awl-multi-lonely-'));

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      await runConfig();
    } finally {
      spy.mockRestore();
    }
    expect(buf).toContain('view-a');
    expect(buf).toContain('view-b');
    expect(buf).toContain(a);
    expect(buf).toContain(b);
    expect(buf).toContain('cd '); // cd 안내
  });

  it('runConfigSet: 등록된 프로젝트가 여럿이면(진짜 모호함) cwd 밖에서 파일을 쓰지 않고 cd 안내만 한다', async () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const a = registeredProject('write-a');
    registeredProject('write-b');
    const before = fs.readFileSync(path.join(a, '.awl', 'config.json'), 'utf8');
    process.chdir(tmp('awl-multi-lonely-'));

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      await runConfigSet('character', '바뀌면 안 됨', { force: false });
    } finally {
      spy.mockRestore();
    }
    const after = fs.readFileSync(path.join(a, '.awl', 'config.json'), 'utf8');
    expect(after).toBe(before); // 안 바뀜
    expect(buf).toContain('cd ');
    expect(buf).toContain(a);
  });

  it('runConfigSet: 등록된 프로젝트가 1개뿐이면 cwd 밖에서도 cd 없이 바로 써진다', async () => {
    process.env.AWL_HOME = tmp('awl-multi-home-');
    const a = registeredProject('solo-write');
    process.chdir(tmp('awl-multi-lonely-'));

    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runConfigSet('character', '단일 등록 프로젝트라 바로 써진다', { force: false });
    } finally {
      spy.mockRestore();
    }
    const after = JSON.parse(fs.readFileSync(path.join(a, '.awl', 'config.json'), 'utf8'));
    expect(after.character).toBe('단일 등록 프로젝트라 바로 써진다');
  });
});
