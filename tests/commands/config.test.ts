import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseVerifyValue, validateConfig } from '../../src/commands/config.js';

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
