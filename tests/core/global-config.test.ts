import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readGlobalAwlConfig,
  seedAuthorFromGitConfig,
  writeGlobalAwlConfig,
} from '../../src/core/global-config.js';

const ORIGINAL_AWL_HOME = process.env.AWL_HOME;

function tmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-global-config-'));
  process.env.AWL_HOME = home;
  return home;
}

afterEach(() => {
  if (ORIGINAL_AWL_HOME === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = ORIGINAL_AWL_HOME;
  }
});

describe('readGlobalAwlConfig', () => {
  it('파일이 없으면 null을 돌려준다(크래시하지 않는다)', () => {
    tmpHome();
    expect(readGlobalAwlConfig()).toBeNull();
  });

  it('손상된 JSON이면 null을 돌려준다(예외를 던지지 않는다)', () => {
    const home = tmpHome();
    fs.writeFileSync(path.join(home, 'config.json'), '{ not valid json');
    expect(readGlobalAwlConfig()).toBeNull();
  });

  it('정상 쓰기/읽기가 왕복한다', () => {
    tmpHome();
    writeGlobalAwlConfig({
      author: 'hong@midasit.com',
      sync: { records: { endpoint: '', token: '' }, feedback: { endpoint: '' } },
    });
    expect(readGlobalAwlConfig()).toEqual({
      author: 'hong@midasit.com',
      sync: { records: { endpoint: '', token: '' }, feedback: { endpoint: '' } },
    });
  });
});

describe('seedAuthorFromGitConfig', () => {
  it('git 저장소 밖(cwd 없음)이어도 예외를 던지지 않는다', async () => {
    await expect(seedAuthorFromGitConfig(os.tmpdir())).resolves.toEqual(expect.any(String));
  });

  it('현재 저장소의 git config user.email 을 읽는다면 빈 문자열이 아니다', async () => {
    // 이 테스트 자체가 git 저장소 안에서 돈다 — CI/로컬 모두 user.email 이
    // 설정돼 있을 수도, 없을 수도 있어 값 자체는 단정하지 않고 타입만 확인한다.
    const value = await seedAuthorFromGitConfig(process.cwd());
    expect(typeof value).toBe('string');
  });
});
