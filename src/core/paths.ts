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

/** Isolated homes point back to the complete installation with this marker. */
export const AWL_PARENT_MARKER = '.awl-parent';

/** Read the parent installation recorded for an isolated data home. */
export function parentGlobalRoot(home: string = globalRoot()): string | null {
  try {
    const raw = fs.readFileSync(path.join(home, AWL_PARENT_MARKER), 'utf8').trim();
    return raw === '' ? null : path.resolve(raw);
  } catch {
    return null;
  }
}

/**
 * Root containing the installed engine and machine-wide registry.
 * Data paths remain under globalRoot() so records and learning stay isolated.
 */
export function installationRoot(): string {
  return parentGlobalRoot() ?? globalRoot();
}

/** ~/.awl/engine — 설치된 스킬·검사기·템플릿·마이그레이션 */
export function engineDir(): string {
  return path.join(installationRoot(), 'engine');
}

/**
 * <project>/.awl/records — 작업 기록(ADK stage 5, adk-reference.md:576-591).
 * 예전엔 globalRoot() 기준 전역이었다 — 레인마다 완전히 다른 AWL_HOME 으로 격리하고
 * teardown 때 병합해야 했다(정확히 설계와 반대: "정리 때 병합할 게 없어야" 하는데
 * "정리가 곧 병합"). project-local 로 옮기고 레인은 파일명 접미사(records-suffix.json,
 * recordsSuffixPath)로만 나눈다 — 레인 워크트리는 이 디렉토리를 main 트리로의
 * 심링크로 만들어 실시간 공유한다(커밋을 기다리는 git 동기화가 아니다, config.json/
 * profile.json 과는 다른 메커니즘 — 그건 커밋 시점 동기화라 records 의 세션 중
 * 실시간 가시성 요구를 못 만족한다).
 */
export function recordsDir(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'records');
}

/**
 * <project>/.awl/records-suffix.json — 이 프로젝트 루트(레인 워크트리 또는 격리
 * 세션)가 남기는 records 파일명 접미사({"suffix":"<레인 또는 세션 id>"}). 없으면
 * 접미사 없이 쓴다(메인). 워크트리 로컬이라 심링크 대상이 아니다 — 레인마다 달라야
 * 하는 유일한 조각.
 */
export function recordsSuffixPath(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'records-suffix.json');
}

/** ~/.awl/gotchas — 아직 규칙이 되지 않은 교훈(WI-O — 예전 이름 delta 를 개명함). */
export function gotchasDir(): string {
  return path.join(globalRoot(), 'gotchas');
}

/**
 * ~/.awl/deltas — gotchas 로 개명되기 전 옛 위치(WI-O). migrateDeltasToGotchas 만
 * 읽기 전용으로 참조한다.
 *
 * 유지 결정(deltas-removal, 0.6.x 기준): 마이그레이션은 머신당 1회·멱등·무손실 안전망이라
 * gotchas/ 가 생긴 뒤엔 영구 no-op(비용 0). 옛 설치를 복원한 ~/.awl/deltas 유입 가능성을
 * 코드로 배제할 수 없어 제거하지 않는다 — 레거시 지원을 끊는 메이저에서 재검토한다.
 */
export function legacyDeltasDir(): string {
  return path.join(globalRoot(), 'deltas');
}

/** ~/.awl/rules — 규칙 */
export function rulesDir(): string {
  return path.join(globalRoot(), 'rules');
}

/** ~/.awl/templates — 템플릿 */
export function templatesDir(): string {
  return path.join(installationRoot(), 'templates');
}

/** ~/.awl/generations/<project> — 프로젝트별 세대 */
export function generationsDir(project: string): string {
  return path.join(globalRoot(), 'generations', project);
}

/** ~/.awl/projects.json — 등록된 프로젝트 목록 */
export function projectsFile(): string {
  return path.join(installationRoot(), 'projects.json');
}

/** ~/.awl/.lock — 전역 잠금 파일 */
export function lockFile(): string {
  return path.join(globalRoot(), '.lock');
}

/** ~/.awl/npm-latest-cache.json — npm 레지스트리 최신 버전 조회 캐시(TTL, 프로젝트 무관) */
export function npmVersionCachePath(): string {
  return path.join(installationRoot(), 'npm-latest-cache.json');
}

/**
 * ~/.awl/sync-cursor.json — 중앙 저장소 전송 커서(ADK stage 3). sync.records/
 * sync.feedback endpoint 설정이 전역(사람마다 한 번)이므로 커서도 전역이다(records
 * 자체는 project-local 로 옮겼지만, "어디까지 보냈나"는 사람×프로젝트 조합별로
 * cursor.records[projectName] 에 저장돼 전역 파일 하나로도 여러 프로젝트를 구분한다) —
 * 프로젝트별 .awl/state.json(baseline/attempts 런타임)과는 다른 층위.
 */
export function syncCursorPath(): string {
  return path.join(installationRoot(), 'sync-cursor.json');
}

/**
 * ~/.awl/config.json — 전역 사용자 설정(author · sync). installationRoot() 기준이라
 * 격리 홈(--isolated 레인) 안에서도 부모 설치의 값을 그대로 본다 — 레인마다
 * author 를 다시 묻지 않는다(ADK stage 1).
 */
export function globalConfigPath(): string {
  return path.join(installationRoot(), 'config.json');
}

/**
 * ~/.awl/backlog-cursor.json — 정리 신호 커서(ADK stage 6, awl backlog). sync-cursor.json
 * 과 같은 층위(installationRoot() 기준, 사람마다 한 번) — "지난 정리 이후 증분"의 기준점.
 */
export function backlogCursorPath(): string {
  return path.join(installationRoot(), 'backlog-cursor.json');
}

/**
 * 현재 디렉토리에서 위로 올라가며 .git 또는 .awl 을 찾는다.
 * 파일 시스템 루트까지 못 찾으면 명확한 에러를 던진다.
 *
 * 전역 설치 디렉토리(globalRoot(), 기본 ~/.awl)는 .awl 마커에서 제외한다.
 * 그렇지 않으면 홈 디렉토리(또는 AWL_HOME 자체)에서 실행했을 때 전역 설치 폴더를
 * 프로젝트로 오판해 그 아래 config.json 이 없다는 혼란스러운 에러로 이어진다.
 */
export function findProjectRoot(cwd: string = process.cwd()): string {
  let dir = path.resolve(cwd);
  const global = globalRoot();

  // path.dirname은 루트에서 자기 자신을 반환한다. 그때 멈춘다.
  for (;;) {
    const awlPath = path.join(dir, '.awl');
    if (fs.existsSync(path.join(dir, '.git')) || (awlPath !== global && fs.existsSync(awlPath))) {
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

/** 레인 진실원천 디렉토리(F-05). status --pipeline 교차 레인 롤업도 이 단일 출처를 쓴다. */
export const WORKTREES_DIR = '.awl-worktrees';

/**
 * 경로가 어떤 레인 워크트리(`<project>/.awl-worktrees/<lane>[/...]`) 안에 있는지 본다.
 * 레인 워크트리는 부모 프로젝트가 `awl lane rm`/`awl remove`로 관리하는 일회성 작업
 * 단위라, 그 안에서 `awl init`이 실행돼도 독립 프로젝트처럼 `~/.awl/projects.json`에
 * 등록되면 안 된다(registerProject 가드가 이 함수를 쓴다).
 */
export function isInsideWorktreesDir(p: string): boolean {
  return path.resolve(p).split(path.sep).includes(WORKTREES_DIR);
}
