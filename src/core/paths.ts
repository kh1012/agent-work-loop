import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 경로 계산 모듈.
 *
 * 규칙:
 * - 홈 디렉토리는 os.homedir()로만 구한다. %USERPROFILE%/$HOME을 직접 읽지 않는다.
 *   Node가 이미 크로스 플랫폼 처리를 해준다.
 * - 경로 조합은 전부 path.join. 문자열 연결('+ "/" +')은 쓰지 않는다.
 * - 각 함수는 호출 시점에 process.env를 읽는다. 모듈 로드 시점에 값을 고정하지
 *   않는다. 그래야 테스트에서 AWL_HOME 재정의가 동작한다.
 */

/** 전역 루트: 기본은 ~/.awl. 환경변수 AWL_HOME으로 재정의 가능. */
export function globalRoot(): string {
  const override = process.env.AWL_HOME;
  if (override && override.trim() !== '') {
    return path.resolve(override);
  }
  return path.join(os.homedir(), '.awl');
}

/** ~/.awl/engine — 설치된 스킬·검사기·템플릿·마이그레이션 */
export function engineDir(): string {
  return path.join(globalRoot(), 'engine');
}

/** ~/.awl/records — 작업 기록 */
export function recordsDir(): string {
  return path.join(globalRoot(), 'records');
}

/** ~/.awl/deltas — 변화(델타) */
export function deltasDir(): string {
  return path.join(globalRoot(), 'deltas');
}

/** ~/.awl/rules — 규칙 */
export function rulesDir(): string {
  return path.join(globalRoot(), 'rules');
}

/** ~/.awl/templates — 템플릿 */
export function templatesDir(): string {
  return path.join(globalRoot(), 'templates');
}

/** ~/.awl/generations/<project> — 프로젝트별 세대 */
export function generationsDir(project: string): string {
  return path.join(globalRoot(), 'generations', project);
}

/** ~/.awl/projects.json — 등록된 프로젝트 목록 */
export function projectsFile(): string {
  return path.join(globalRoot(), 'projects.json');
}

/** ~/.awl/.lock — 전역 잠금 파일 */
export function lockFile(): string {
  return path.join(globalRoot(), '.lock');
}

/**
 * 현재 디렉토리에서 위로 올라가며 .git 또는 .awl 을 찾는다.
 * 파일 시스템 루트까지 못 찾으면 명확한 에러를 던진다.
 */
export function findProjectRoot(cwd: string = process.cwd()): string {
  let dir = path.resolve(cwd);

  // path.dirname은 루트에서 자기 자신을 반환한다. 그때 멈춘다.
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.awl'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(
    `프로젝트 루트를 찾을 수 없습니다. '${path.resolve(cwd)}' 위쪽에서 .git 또는 .awl 을 찾지 못했습니다.`,
  );
}

/** <project>/.awl/config.json */
export function projectConfigPath(cwd?: string): string {
  return path.join(findProjectRoot(cwd), '.awl', 'config.json');
}

/** <project>/.awl/state.json */
export function projectStatePath(cwd?: string): string {
  return path.join(findProjectRoot(cwd), '.awl', 'state.json');
}
