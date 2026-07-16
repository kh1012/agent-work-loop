// commit 격리 극한 스트레스 (stress-commit-isolation).
//
// isolatedCommit 의 격리(내 변경만 커밋, 남의 미커밋 변경 보존)가 극한 입력에서
// 정확한지 검증한다: 대량 사전 untracked·비ASCII 경로·큰 diff·인접 hunk 다수 충돌.
// 발견만 한다 — 스위트 속도를 고려한 수치(필요 시 상수 조정으로 더 깊이).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isolatedCommit, startBaseline } from '../../src/commands/commit.js';

function makeRepo(): { dir: string; g: (args: string[]) => string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-iso-stress-')));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'x@x.com']);
  g(['config', 'user.name', 'x']);
  g(['config', 'commit.gpgsign', 'false']);
  return { dir, g };
}

const UNTRACKED = 500; // 대량 사전 untracked(남의 것)
const DIFF_LINES = 5000; // 큰 diff
const HUNK_PAIRS = 60; // 인접 hunk 충돌 쌍

describe('commit 격리 극한 (stress-commit-isolation AC-01/02)', () => {
  it(`대량 사전 untracked ${UNTRACKED}개(일부 .awl-worktrees/)를 남기고 내 tracked 변경만 커밋한다`, async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'base\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    // 남의 것: 대량 untracked. 일부는 .awl-worktrees/ 아래(listUntracked 필터 대상).
    fs.mkdirSync(path.join(dir, '.awl-worktrees', 'w'), { recursive: true });
    for (let i = 0; i < UNTRACKED; i++) {
      const p =
        i < 10
          ? path.join(dir, '.awl-worktrees', 'w', `f${i}.txt`)
          : path.join(dir, `other-${i}.txt`);
      fs.writeFileSync(p, `other ${i}\n`);
    }
    // 이 시점 untracked = 남의 것 → untrackedAtStart 로 넘겨야 격리에서 제외된다.
    // (runCommit 은 crit.untrackedAtStart 를 그대로 넘긴다 — 테스트도 동일하게.)
    const { snapshot, untracked } = await startBaseline(dir, 'AC-1');
    // 내 변경: tracked 파일 하나 수정.
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'base\nMINE\n');

    const outcome = await isolatedCommit(dir, 'AC-1', 'only mine', snapshot, untracked);
    expect(outcome.committed).toBe(true);
    // 내 것만 커밋, 남의 대량 untracked 는 안 섞인다.
    expect(outcome.stagedFiles).toEqual(['mine.txt']);
    // 남의 untracked 는 워킹트리에 그대로 보존(삭제/커밋 안 됨).
    expect(fs.existsSync(path.join(dir, 'other-499.txt'))).toBe(true);
    const show = g(['show', '--stat', 'HEAD']);
    expect(show).not.toContain('other-');
    expect(show).not.toContain('.awl-worktrees');
  });

  it('비ASCII 경로(한글·이모지·제어문자)를 정확히 격리 커밋한다', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'x\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const { snapshot } = await startBaseline(dir, 'AC-1');
    // 내 새 파일들: 비ASCII 이름.
    const names = ['한글파일.txt', '이모지-🔥.txt', '제어문자.txt', '공백 있는.txt'];
    for (const n of names) {
      fs.writeFileSync(path.join(dir, n), 'mine\n');
    }
    const outcome = await isolatedCommit(dir, 'AC-1', 'nonascii', snapshot);
    expect(outcome.committed).toBe(true);
    // -z 기반이라 비ASCII 이름이 원본 그대로 매칭돼 전부 포함.
    expect([...outcome.stagedFiles].sort()).toEqual([...names].sort());
  });

  it(`큰 diff(${DIFF_LINES}줄 추가)를 격리 커밋한다`, async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'big.txt'), 'l0\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    const { snapshot } = await startBaseline(dir, 'AC-1');
    const big = `l0\n${Array.from({ length: DIFF_LINES }, (_, i) => `line ${i}`).join('\n')}\n`;
    fs.writeFileSync(path.join(dir, 'big.txt'), big);
    const outcome = await isolatedCommit(dir, 'AC-1', 'bigdiff', snapshot);
    expect(outcome.committed).toBe(true);
    expect(outcome.stagedFiles).toEqual(['big.txt']);
  });

  it(`인접 hunk ${HUNK_PAIRS}쌍이 남/나 교차로 겹치면 커밋 거부하고 워킹트리를 보존한다`, async () => {
    const { dir, g } = makeRepo();
    // 짝수 줄 = 남, 홀수 줄 = 나 가 될 인접 라인들.
    const base = Array.from({ length: HUNK_PAIRS * 2 }, (_, i) => `L${i}`).join('\n');
    fs.writeFileSync(path.join(dir, 'f.txt'), `${base}\n`);
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'base']);
    // 남의 변경: 짝수 줄 수정.
    const lines = base.split('\n');
    for (let i = 0; i < lines.length; i += 2) {
      lines[i] = `OTHER${i}`;
    }
    fs.writeFileSync(path.join(dir, 'f.txt'), `${lines.join('\n')}\n`);
    const { snapshot } = await startBaseline(dir, 'AC-1');
    // 내 변경: 홀수 줄 수정(남의 변경과 줄 단위로 인접).
    for (let i = 1; i < lines.length; i += 2) {
      lines[i] = `MINE${i}`;
    }
    const mine = `${lines.join('\n')}\n`;
    fs.writeFileSync(path.join(dir, 'f.txt'), mine);

    const outcome = await isolatedCommit(dir, 'AC-1', 'conflict', snapshot);
    expect(outcome.committed).toBe(false); // 안전하게 분리 불가 → 거부
    // 워킹트리는 그대로(남의 것도 내 것도 유실 없음).
    expect(fs.readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe(mine);
  });
});
