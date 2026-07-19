import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_GRACE_MS,
  archiveAllLanes,
  archiveCompletedWorkitems,
  selectArchiveCandidates,
} from '../../src/commands/pipeline-archive.js';

/** 임시 .tasks/ 트리를 만든다. */
function tmpTasks(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-archive-')));
  const tasks = path.join(root, '.tasks');
  for (const d of ['plan', 'exec', 'review']) {
    fs.mkdirSync(path.join(tasks, d), { recursive: true });
  }
  return tasks;
}

function write(
  tasksDir: string,
  sub: 'plan' | 'exec' | 'review',
  file: string,
  content = '',
): string {
  const p = path.join(tasksDir, sub, file);
  fs.writeFileSync(p, content);
  return p;
}

/** 파일 mtime을 now 로부터 ageMs 만큼 과거로 되돌린다(가짜 mtime 픽스처). */
function ageFile(filePath: string, ageMs: number, now: number): void {
  const past = new Date(now - ageMs);
  fs.utimesSync(filePath, past, past);
}

describe('selectArchiveCandidates — F-03(pipelineLanes) 재사용 + 유예기간(AC-01/AC-02)', () => {
  it('complete + 유예(3일) 지남 → 후보 포함', () => {
    const tasks = tmpTasks();
    write(tasks, 'plan', 'done.taken.md');
    const execFile = write(tasks, 'exec', 'done.taken.md');
    const now = Date.now();
    ageFile(execFile, ARCHIVE_GRACE_MS + 1000, now);

    expect(selectArchiveCandidates(tasks, now)).toEqual(['done']);
  });

  it('complete + 유예(3일) 안 지남 → 후보 제외(방금 완료된 건 이번 실행에서 안 옮겨짐)', () => {
    const tasks = tmpTasks();
    write(tasks, 'plan', 'fresh.taken.md');
    const execFile = write(tasks, 'exec', 'fresh.taken.md');
    const now = Date.now();
    ageFile(execFile, 24 * 60 * 60 * 1000, now); // 1일 전 — 3일 미만.

    expect(selectArchiveCandidates(tasks, now)).toEqual([]);
  });

  it('hold(plan/<name>.hold.md) → status 와 무관하게 항상 제외(F-04, F-03 blocked 병합 재사용)', () => {
    const tasks = tmpTasks();
    write(tasks, 'plan', 'stuck.hold.md');
    const execFile = write(tasks, 'exec', 'stuck.taken.md');
    const now = Date.now();
    ageFile(execFile, ARCHIVE_GRACE_MS + 1000, now); // 유예도 지났지만 hold 라 제외돼야 한다.

    expect(selectArchiveCandidates(tasks, now)).toEqual([]);
  });

  it('review/<name>.md 있는 blocked(수정요구) → 후보 제외', () => {
    const tasks = tmpTasks();
    write(tasks, 'plan', 'inreview.taken.md');
    const execFile = write(tasks, 'exec', 'inreview.taken.md');
    write(tasks, 'review', 'inreview.md'); // 미반영 수정요구 = blocked
    const now = Date.now();
    ageFile(execFile, ARCHIVE_GRACE_MS + 1000, now);

    expect(selectArchiveCandidates(tasks, now)).toEqual([]);
  });

  it('pending/executing/reviewing → 유예 무관 항상 후보 제외', () => {
    const tasks = tmpTasks();
    write(tasks, 'plan', 'new.md'); // pending
    write(tasks, 'plan', 'started.taken.md'); // executing
    write(tasks, 'exec', 'handedoff.md'); // reviewing(exec 미검증 핸드오프)
    write(tasks, 'plan', 'handedoff.taken.md');

    expect(selectArchiveCandidates(tasks, Date.now() + 10 * ARCHIVE_GRACE_MS)).toEqual([]);
  });

  it('빈 .tasks/ 또는 부재 디렉토리에도 크래시하지 않고 빈 배열', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-archive-empty-')));
    expect(selectArchiveCandidates(path.join(root, '.tasks'), Date.now())).toEqual([]);
  });
});

describe('archiveCompletedWorkitems — 이동(AC-03, 바이트 동일·원위치 소거)', () => {
  it('유예 지난 complete 항목을 archive/<name>/ 로 이동, 내용 바이트 동일, 원위치 소거', () => {
    const tasks = tmpTasks();
    const planContent = '---\nname: done\n---\n계획 내용\n';
    const execContent = '# 핸드오프\n검증 통과\n';
    const planPath = write(tasks, 'plan', 'done.taken.md', planContent);
    const execPath = write(tasks, 'exec', 'done.taken.md', execContent);
    const now = Date.now();
    ageFile(execPath, ARCHIVE_GRACE_MS + 1000, now);

    const archived = archiveCompletedWorkitems(tasks, now);
    expect(archived).toEqual(['done']);

    // 원위치 소거.
    expect(fs.existsSync(planPath)).toBe(false);
    expect(fs.existsSync(execPath)).toBe(false);

    // 새 위치에 바이트 동일 내용.
    const archivedPlan = path.join(tasks, 'archive', 'done', 'plan', 'done.taken.md');
    const archivedExec = path.join(tasks, 'archive', 'done', 'exec', 'done.taken.md');
    expect(fs.existsSync(archivedPlan)).toBe(true);
    expect(fs.existsSync(archivedExec)).toBe(true);
    expect(Buffer.compare(fs.readFileSync(archivedPlan), Buffer.from(planContent))).toBe(0);
    expect(Buffer.compare(fs.readFileSync(archivedExec), Buffer.from(execContent))).toBe(0);
  });

  it('유예 안 지난 complete 항목은 옮기지 않는다(뮤테이션-저항: 빈 배열 대신 원위치 파일 존재로도 확인)', () => {
    const tasks = tmpTasks();
    const execPath =
      write(tasks, 'plan', 'fresh.taken.md') && write(tasks, 'exec', 'fresh.taken.md');
    const now = Date.now();
    ageFile(execPath, 60 * 1000, now); // 1분 전.

    const archived = archiveCompletedWorkitems(tasks, now);
    expect(archived).toEqual([]);
    expect(fs.existsSync(execPath)).toBe(true);
    expect(fs.existsSync(path.join(tasks, 'archive'))).toBe(false);
  });

  it('hold 항목은 유예가 아무리 지나도 옮기지 않는다', () => {
    const tasks = tmpTasks();
    write(tasks, 'plan', 'stuck.hold.md');
    const execPath = write(tasks, 'exec', 'stuck.taken.md');
    const now = Date.now();
    ageFile(execPath, ARCHIVE_GRACE_MS * 10, now);

    const archived = archiveCompletedWorkitems(tasks, now);
    expect(archived).toEqual([]);
    expect(fs.existsSync(execPath)).toBe(true);
  });
});

describe('archiveAllLanes — 레인 스코프 동일 적용(AC-04)', () => {
  it('main(.tasks/)과 .awl-worktrees/<lane>/.tasks/ 양쪽에서 각각 보관한다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-archive-lanes-')));
    const now = Date.now();

    // main.
    fs.mkdirSync(path.join(root, '.tasks', 'plan'), { recursive: true });
    fs.mkdirSync(path.join(root, '.tasks', 'exec'), { recursive: true });
    fs.writeFileSync(path.join(root, '.tasks', 'plan', 'mainwi.taken.md'), '');
    const mainExec = path.join(root, '.tasks', 'exec', 'mainwi.taken.md');
    fs.writeFileSync(mainExec, '');
    ageFile(mainExec, ARCHIVE_GRACE_MS + 1000, now);

    // lane 'fe'.
    const feTasks = path.join(root, '.awl-worktrees', 'fe', '.tasks');
    fs.mkdirSync(path.join(feTasks, 'plan'), { recursive: true });
    fs.mkdirSync(path.join(feTasks, 'exec'), { recursive: true });
    fs.writeFileSync(path.join(feTasks, 'plan', 'lanewi.taken.md'), '');
    const laneExec = path.join(feTasks, 'exec', 'lanewi.taken.md');
    fs.writeFileSync(laneExec, '');
    ageFile(laneExec, ARCHIVE_GRACE_MS + 1000, now);

    const result = archiveAllLanes(root, now);
    expect(result.main).toEqual(['mainwi']);
    expect(result.fe).toEqual(['lanewi']);
    expect(
      fs.existsSync(path.join(root, '.tasks', 'archive', 'mainwi', 'exec', 'mainwi.taken.md')),
    ).toBe(true);
    expect(fs.existsSync(path.join(feTasks, 'archive', 'lanewi', 'exec', 'lanewi.taken.md'))).toBe(
      true,
    );
  });

  it('.awl-worktrees/ 부재면 main 만 처리하고 크래시하지 않는다', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-archive-nolane-')));
    fs.mkdirSync(path.join(root, '.tasks', 'plan'), { recursive: true });
    const result = archiveAllLanes(root, Date.now());
    expect(result).toEqual({ main: [] });
  });
});
