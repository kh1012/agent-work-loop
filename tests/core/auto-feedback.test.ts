import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRecords } from '../../src/commands/record.js';
import {
  buildAutoFeedbackWhat,
  commandNameFromArgv,
  recordAutoFeedback,
} from '../../src/core/auto-feedback.js';

describe('buildAutoFeedbackWhat / commandNameFromArgv — 순수 함수', () => {
  it('명령 이름을 what 문구에 담는다', () => {
    expect(buildAutoFeedbackWhat('doctor')).toContain('doctor');
    expect(buildAutoFeedbackWhat('doctor')).toContain('미처리 예외');
  });

  it('argv 에서 옵션이 아닌 첫 인자를 명령 이름으로 본다', () => {
    expect(commandNameFromArgv(['node', 'cli.js', 'record', 'gate', '--json', '{}'])).toBe('record');
  });

  it('명령 이름이 없으면(전부 옵션) 알 수 없음', () => {
    expect(commandNameFromArgv(['node', 'cli.js', '--version'])).toBe('(알 수 없음)');
  });
});

describe('recordAutoFeedback — 통합', () => {
  const origHome = process.env.AWL_HOME;
  const origCwd = process.cwd();
  let home: string;
  let root: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-autofb-home-'));
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-autofb-proj-')));
    process.env.AWL_HOME = home;
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({ project: 'autofb-proj', mainLanguage: 'other', engineVersion: '0.0.0', verify: {} }),
    );
    process.chdir(root);
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  it('프로젝트를 찾을 수 있고 기본값(켜짐)이면 awl-feedback 레코드를 남긴다', async () => {
    await recordAutoFeedback(new Error(`${root}/src/foo.ts 에서 실패`), ['node', 'cli.js', 'doctor']);
    const records = readRecords({ type: 'awl-feedback' });
    expect(records).toHaveLength(1);
    expect(records[0]?.area).toBe('cli');
    expect(records[0]?.severity).toBe('low');
    expect(String(records[0]?.what)).toContain('doctor');
    expect(String(records[0]?.impact)).toContain('<project>');
    expect(String(records[0]?.impact)).not.toContain(root);
  });

  it("config.autoFeedback === false 면 기록하지 않는다", async () => {
    fs.writeFileSync(
      path.join(root, '.awl', 'config.json'),
      JSON.stringify({
        project: 'autofb-proj',
        mainLanguage: 'other',
        engineVersion: '0.0.0',
        verify: {},
        autoFeedback: false,
      }),
    );
    await recordAutoFeedback(new Error('실패'), ['node', 'cli.js', 'doctor']);
    expect(readRecords({ type: 'awl-feedback' })).toHaveLength(0);
  });

  it('프로젝트 루트를 못 찾으면(프로젝트 밖) 조용히 아무것도 안 한다', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-autofb-outside-'));
    process.chdir(outside);
    await expect(recordAutoFeedback(new Error('실패'), ['node', 'cli.js', 'doctor'])).resolves.toBeUndefined();
    expect(readRecords({ type: 'awl-feedback' })).toHaveLength(0);
  });

  it('Error 가 아닌 값(문자열 throw 등)도 크래시 없이 처리한다', async () => {
    await expect(recordAutoFeedback('plain string error', ['node', 'cli.js', 'doctor'])).resolves.toBeUndefined();
    const records = readRecords({ type: 'awl-feedback' });
    expect(records).toHaveLength(1);
    expect(String(records[0]?.impact)).toContain('plain string error');
  });
});
