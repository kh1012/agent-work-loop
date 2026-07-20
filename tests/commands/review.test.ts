import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AwlConfig } from '../../src/commands/config.js';
import { assembleReview, selectCriteria } from '../../src/commands/review.js';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-review-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'x@x.com']);
  g(['config', 'user.name', 'x']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'base']);
  return dir;
}

const CONFIG: AwlConfig = {
  project: 'p',
  mainLanguage: ['typescript'],
  character: '',
  engineVersion: '0.0.0',
  verify: {
    typecheck: null,
    lint: null,
    test: { cmd: `${process.execPath} --version` },
    e2e: null,
  },
};

describe('selectCriteria', () => {
  const state = { criteria: [{ id: 'AC-01' }, { id: 'AC-02' }, { id: 'AC-03' }] };
  it('범위 AC-01..AC-02', () => {
    expect(selectCriteria(state, 'AC-01..AC-02').map((c) => c.id)).toEqual(['AC-01', 'AC-02']);
  });
  it('단일 AC-03', () => {
    expect(selectCriteria(state, 'AC-03').map((c) => c.id)).toEqual(['AC-03']);
  });
});

describe('assembleReview — provenance 가 핵심', () => {
  it('provenance(branch/commit/worktree/note)와 verify 를 포함하고 JSON 직렬화된다', async () => {
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed', 조건: '방향키 이동' }] };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.provenance.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(bundle.provenance.worktree).toBeTruthy();
    expect(bundle.provenance.branch).toBeTruthy();
    expect(bundle.provenance.note).toContain('워크트리');

    expect(bundle.verify.passed).toBe(true);
    expect(bundle.criteria).toHaveLength(1);

    // 리뷰어(서브에이전트)가 파싱할 수 있어야 한다.
    expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow();
  });
});

describe('assembleReview — reviewId 발급 (WI-S AC-02)', () => {
  it('호출마다 새 reviewId(rev_ 접두어)를 발급한다', async () => {
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };
    const bundle1 = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);
    const bundle2 = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle1.reviewId).toMatch(/^rev_/);
    expect(bundle2.reviewId).toMatch(/^rev_/);
    expect(bundle1.reviewId).not.toBe(bundle2.reviewId); // 매번 새로 발급
  });
});

describe('assembleReview — firstBaseline (WI-H AC-01, D-26/D-28 실사고 재현)', () => {
  function git(dir: string, args: string[]): string {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  }

  it('범위 첫 AC 가 이미 닫혀 baseline 필드가 자기 자신의 커밋으로 덮어써졌어도, firstBaseline 이 있으면 그 AC 자신의 diff 가 빠지지 않는다', async () => {
    const dir = makeRepo();
    const commit0 = git(dir, ['rev-parse', 'HEAD']);

    // AC-01 작업 -> 닫힘. commit.ts 의 실제 동작대로: 닫히면 baseline 필드가
    // range-start(commit0) 에서 AC-01 자신의 최종 커밋(commit1)으로 덮어써진다.
    fs.writeFileSync(path.join(dir, 'ac01.txt'), 'ac01 change\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'AC-01 work']);
    const commit1 = git(dir, ['rev-parse', 'HEAD']);

    const state = {
      criteria: [{ id: 'AC-01', status: 'passed', baseline: commit1, firstBaseline: commit0 }],
    };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    // 버그였다면 baseline(commit1)을 기준으로 diff 를 잡아 ac01.txt 변경이 통째로
    // 빠졌을 것이다 — firstBaseline(commit0) 을 써야 정상적으로 포함된다.
    expect(bundle.diff).toContain('ac01.txt');
  });

  it('firstBaseline 이 없는(마이그레이션 전) 완료조건은 기존처럼 baseline 으로 폴백한다(하위호환)', async () => {
    const dir = makeRepo();
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'legacy.txt'), 'legacy change\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'legacy AC work']);

    // firstBaseline 없이 baseline 만 있는(옛 state) 완료조건 — 아직 안 닫힌 상태를
    // 흉내낸다(baseline 이 곧 range-start 인 유일한 경우).
    const state = { criteria: [{ id: 'AC-01', status: 'in_progress', baseline: commit0 }] };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.diff).toContain('legacy.txt');
  });

  it('여러 AC 범위에서 두 번째 이후 AC 의 firstBaseline 은 무시하고 범위 첫 AC 것만 쓴다(범위 시작점은 하나)', async () => {
    const dir = makeRepo();
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'ac01.txt'), 'ac01\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'AC-01']);
    const commit1 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'ac02.txt'), 'ac02\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'AC-02']);
    const commit2 = git(dir, ['rev-parse', 'HEAD']);

    const state = {
      criteria: [
        { id: 'AC-01', status: 'passed', baseline: commit1, firstBaseline: commit0 },
        { id: 'AC-02', status: 'passed', baseline: commit2, firstBaseline: commit1 },
      ],
    };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01..AC-02', undefined);

    expect(bundle.diff).toContain('ac01.txt');
    expect(bundle.diff).toContain('ac02.txt');
  });
});
