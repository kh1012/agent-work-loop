import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyUpdate } from '../../src/commands/update.js';

const origHome = process.env.AWL_HOME;

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

describe('applyUpdate — 엔진 재설치 (WI-X AC-05)', () => {
  it('엔진이 설치된 적 없으면(scaffoldGlobal 전) 아무것도 안 하고 안내만 한다', () => {
    // tmp() 는 디렉토리 자체를 만들어버리므로(실제 존재 여부와 무관하게), engine/
    // 이 아예 없는 상태를 흉내내려면 아직 존재하지 않는 경로 문자열만 준다.
    process.env.AWL_HOME = path.join(os.tmpdir(), `awl-update-none-${process.pid}-${Date.now()}`);
    const result = applyUpdate();
    expect(result.updated).toBe(false);
    expect(result.reason).toBe('not-installed');
  });

  it('~/.awl 이 있으면 packageEngineDir() 의 내용으로 engine/ 을 덮어쓰고 이전/이후 버전을 돌려준다', () => {
    const home = tmp('awl-update-home-');
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'engine', 'version.json'),
      JSON.stringify({ engineVersion: '0.0.1' }),
    );
    process.env.AWL_HOME = home;

    const result = applyUpdate();
    expect(result.updated).toBe(true);
    expect(result.fromVersion).toBe('0.0.1');
    // packageEngineDir() 은 이 저장소 자신의 engine/ 을 가리킨다 — 실제 버전으로 갱신됨.
    expect(result.toVersion).not.toBeNull();
    expect(result.toVersion).not.toBe('0.0.1');
    // 스킬 디렉토리까지 실제로 복사됐는지 확인(engine/ 이 통째로 덮어써졌는지).
    expect(
      fs.existsSync(path.join(home, 'engine', 'skills', 'claude', 'awl-loop', 'SKILL.md')),
    ).toBe(true);
  });

  it('이미 최신이면 fromVersion 과 toVersion 이 같다', () => {
    const home = tmp('awl-update-home-');
    process.env.AWL_HOME = home;
    // 먼저 한 번 설치해 최신으로 만든다.
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    applyUpdate();
    const first = applyUpdate();
    const second = applyUpdate();
    expect(second.fromVersion).toBe(first.toVersion);
    expect(second.toVersion).toBe(first.toVersion);
  });
});
