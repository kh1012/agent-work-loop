import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deltasDir,
  engineDir,
  findProjectRoot,
  generationsDir,
  globalRoot,
  lockFile,
  projectConfigPath,
  projectStatePath,
  projectsFile,
  recordsDir,
  rulesDir,
  templatesDir,
} from '../../src/core/paths.js';

const ORIGINAL_AWL_HOME = process.env.AWL_HOME;

// 임시 디렉토리를 os.tmpdir() 아래에 만든다. Windows/macOS 모두에서 동작.
function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  if (ORIGINAL_AWL_HOME === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = ORIGINAL_AWL_HOME;
  }
});

describe('globalRoot / AWL_HOME 재정의', () => {
  it('AWL_HOME이 없으면 ~/.awl 을 반환한다', () => {
    delete process.env.AWL_HOME;
    expect(globalRoot()).toBe(path.join(os.homedir(), '.awl'));
  });

  it('AWL_HOME이 있으면 그 경로를 절대경로로 반환한다', () => {
    const tmp = makeTmpDir('awl-home-');
    process.env.AWL_HOME = tmp;
    expect(globalRoot()).toBe(path.resolve(tmp));
  });

  it('AWL_HOME이 빈 문자열이면 기본값으로 폴백한다', () => {
    process.env.AWL_HOME = '   ';
    expect(globalRoot()).toBe(path.join(os.homedir(), '.awl'));
  });

  it('AWL_HOME 재정의가 하위 디렉토리에도 전파된다', () => {
    const tmp = makeTmpDir('awl-home-');
    process.env.AWL_HOME = tmp;
    expect(engineDir()).toBe(path.join(path.resolve(tmp), 'engine'));
    expect(recordsDir()).toBe(path.join(path.resolve(tmp), 'records'));
  });
});

describe('전역 하위 경로 조합', () => {
  beforeEach(() => {
    process.env.AWL_HOME = makeTmpDir('awl-home-');
  });

  it('각 디렉토리를 globalRoot 아래 올바른 이름으로 조합한다', () => {
    const root = globalRoot();
    expect(engineDir()).toBe(path.join(root, 'engine'));
    expect(recordsDir()).toBe(path.join(root, 'records'));
    expect(deltasDir()).toBe(path.join(root, 'deltas'));
    expect(rulesDir()).toBe(path.join(root, 'rules'));
    expect(templatesDir()).toBe(path.join(root, 'templates'));
    expect(projectsFile()).toBe(path.join(root, 'projects.json'));
    expect(lockFile()).toBe(path.join(root, '.lock'));
  });

  it('generationsDir은 프로젝트 이름을 경로에 포함한다', () => {
    const root = globalRoot();
    expect(generationsDir('my-proj')).toBe(path.join(root, 'generations', 'my-proj'));
  });

  it('조합 결과는 플랫폼 구분자를 쓴다 (문자열 연결이 아님)', () => {
    // path.join 사용을 검증: 결과에 현재 플랫폼의 sep이 들어있어야 한다.
    expect(engineDir()).toContain(path.sep);
    // '/' 하드코딩이 아님을 win32 환경에서 확인하기 위한 문서용 단언.
    expect(path.win32.join('C:\\Users\\x\\.awl', 'engine')).toBe('C:\\Users\\x\\.awl\\engine');
    expect(path.posix.join('/home/x/.awl', 'engine')).toBe('/home/x/.awl/engine');
  });
});

describe('findProjectRoot', () => {
  it('.git이 있는 디렉토리를 루트로 찾는다', () => {
    const proj = makeTmpDir('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'));
    expect(findProjectRoot(proj)).toBe(path.resolve(proj));
  });

  it('.awl이 있는 디렉토리를 루트로 찾는다', () => {
    const proj = makeTmpDir('awl-proj-');
    fs.mkdirSync(path.join(proj, '.awl'));
    expect(findProjectRoot(proj)).toBe(path.resolve(proj));
  });

  it('하위 디렉토리에서 실행해도 위로 올라가 루트를 찾는다', () => {
    const proj = makeTmpDir('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'));
    const nested = path.join(proj, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(path.resolve(proj));
  });

  it('.git도 .awl도 없으면 명확한 에러를 던진다', () => {
    // tmpdir 아래에 마커 없는 고립된 디렉토리를 만든다.
    const lonely = makeTmpDir('awl-lonely-');
    expect(() => findProjectRoot(lonely)).toThrow(/프로젝트 루트를 찾을 수 없습니다/);
  });

  it('projectConfigPath / projectStatePath는 루트 아래 .awl/*.json을 가리킨다', () => {
    const proj = makeTmpDir('awl-proj-');
    fs.mkdirSync(path.join(proj, '.git'));
    const root = path.resolve(proj);
    expect(projectConfigPath(proj)).toBe(path.join(root, '.awl', 'config.json'));
    expect(projectStatePath(proj)).toBe(path.join(root, '.awl', 'state.json'));
  });
});
