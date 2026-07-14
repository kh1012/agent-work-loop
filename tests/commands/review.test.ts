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
  mainLanguage: 'typescript',
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
