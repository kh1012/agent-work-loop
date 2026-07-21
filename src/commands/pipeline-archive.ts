import fs from 'node:fs';
import path from 'node:path';
import { WORKTREES_DIR } from '../core/paths.js';
import { markerBaseName, pipelineLanes, readDirNames } from './status.js';

/**
 * .tasks/{plan,exec,review} 완료 항목 보관 (pipeline-archive-cleanup).
 *
 * 상태판정은 새로 만들지 않는다 — pipelineLanes(status.ts, F-03)의 산출 결과만 입력으로
 * 쓴다. hold 는 review-blocked 와 함께 이미 'blocked' 로 병합되어 나오므로, 여기서
 * status==='complete' 만 후보로 거르면 hold 는 자동으로 제외된다(별도 hold 특수처리 없음).
 */

/**
 * 유예 기간 기본값: complete 후 3일. F-01 실측(세션당 수십 개 증가, 파이프라인
 * 세션이 거의 매일 도는 사용 패턴) 기준 "방금 끝났다"는 가시성(F-05)을 주중 하루
 * 정도의 세션 공백까지 보존하면서도, 활성 스캔면이 며칠 단위로는 반드시 얇아지게
 * 하는 값이다. 옵션/설정으로 노출하지 않는다(범위 밖 — 기본값 하나만 둔다).
 */
export const ARCHIVE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** complete 판정의 결정적 근거 파일(F-04, pipelineLanes 우선순위) — 이 mtime을 완료 시각으로 쓴다. */
function execTakenPath(tasksDir: string, name: string): string {
  return path.join(tasksDir, 'exec', `${name}.taken.md`);
}

/**
 * 보관 후보 선정(AC-01/AC-02). pipelineLanes 가 이미 판정한 status 만 보고 후보를
 * 거른다 — 마커 파일명 정규식이나 우선순위를 이 함수에서 다시 만들지 않는다.
 * status==='complete' 이고, 완료 근거 파일(exec/<name>.taken.md)의 mtime 이
 * graceMs 이상 지난 항목만 후보다.
 */
export function selectArchiveCandidates(
  tasksDir: string,
  now: number = Date.now(),
  graceMs: number = ARCHIVE_GRACE_MS,
): string[] {
  const lanes = pipelineLanes(
    readDirNames(path.join(tasksDir, 'plan')),
    readDirNames(path.join(tasksDir, 'exec')),
    readDirNames(path.join(tasksDir, 'review')),
  );
  const candidates: string[] = [];
  for (const lane of lanes) {
    if (lane.status !== 'complete') {
      continue; // hold 를 포함한 모든 non-complete 는 여기서 자동 제외된다(F-03 재사용).
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(execTakenPath(tasksDir, lane.name));
    } catch {
      continue; // complete 판정 근거 파일이 없으면(이론상 불가) 후보에서 뺀다.
    }
    if (now - stat.mtimeMs >= graceMs) {
      candidates.push(lane.name);
    }
  }
  return candidates;
}

/**
 * name 소유 파일(모든 마커 접미사 포함)만 골라낸다. status 판정이 아니라 "이 workitem에
 * 속한 실제 파일이 무엇인가"라는 물리적 질의라 pipelineLanes 의 상태판정과는 별개지만,
 * 마커 접미사를 벗기는 규칙(markerBaseName)은 status.ts 와 공유한다 — 여기서 정규식을
 * 복제하면 마커 접미사가 늘 때 한쪽만 갱신되어 파일 일부만 이동하는 desync 가 생긴다
 * (리뷰 지적, rev_9a9fc20b7ac6ed5b02 MEDIUM).
 */
function ownedFiles(dir: string, name: string): string[] {
  return readDirNames(dir).filter((f) => f.endsWith('.md') && markerBaseName(f) === name);
}

/**
 * 한 workitem의 plan/exec/review 파일을 archive/<name>/<sub>/ 로 옮긴다(rename — 삭제
 * 아님, 내용 그대로라 바이트 손실 없음). 원래 서브디렉토리에서는 사라져 활성 스캔에서
 * 제외된다. archive/ 자체는 readDirNames 가 plan/exec/review 서브디렉토리만 읽으므로
 * 별도 배제 로직 없이 status --pipeline 스캔에서 구조적으로 빠진다(F-05).
 */
function moveWorkitemFiles(tasksDir: string, name: string): boolean {
  let movedAny = false;
  for (const sub of ['plan', 'exec', 'review'] as const) {
    const dir = path.join(tasksDir, sub);
    const files = ownedFiles(dir, name);
    if (files.length === 0) {
      continue;
    }
    const destDir = path.join(tasksDir, 'archive', name, sub);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of files) {
      fs.renameSync(path.join(dir, f), path.join(destDir, f));
      movedAny = true;
    }
  }
  return movedAny;
}

/** 한 .tasks/ 트리(bare 또는 레인)에서 유예 지난 complete workitem을 보관한다(AC-03). */
export function archiveCompletedWorkitems(
  tasksDir: string,
  now: number = Date.now(),
  graceMs: number = ARCHIVE_GRACE_MS,
): string[] {
  const candidates = selectArchiveCandidates(tasksDir, now, graceMs);
  const archived: string[] = [];
  for (const name of candidates) {
    if (moveWorkitemFiles(tasksDir, name)) {
      archived.push(name);
    }
  }
  return archived;
}

/**
 * 레인 스코프까지 동일 적용(AC-04) — bare .tasks/ 를 'main' 으로, .awl-worktrees/<lane>/.tasks/
 * 를 레인별로 순회해 각각 archiveCompletedWorkitems 를 적용한다. collectPipelineLaneGroups
 * (status.ts, F-03)와 같은 레인 진실원천(WORKTREES_DIR)을 쓴다 — 레인 열거 로직도 새로
 * 만들지 않는다.
 */
export function archiveAllLanes(
  root: string,
  now: number = Date.now(),
  graceMs: number = ARCHIVE_GRACE_MS,
): Record<string, string[]> {
  const result: Record<string, string[]> = {
    main: archiveCompletedWorkitems(path.join(root, '.tasks'), now, graceMs),
  };
  const base = path.join(root, WORKTREES_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return result; // .awl-worktrees/ 없음 = 레인 없음 → main 만.
  }
  for (const e of entries) {
    if (!e.isDirectory()) {
      continue;
    }
    result[e.name] = archiveCompletedWorkitems(path.join(base, e.name, '.tasks'), now, graceMs);
  }
  return result;
}
