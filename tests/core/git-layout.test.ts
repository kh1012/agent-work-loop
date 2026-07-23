import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveGitLayout, worktreeLocalConfigPath } from '../../src/core/git-layout.js';

function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('resolveGitLayout', () => {
  it('main worktree에서는 .git을 worktree/common gitdir로 함께 반환한다', () => {
    const root = tmp('awl-git-layout-main-');
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir);

    expect(resolveGitLayout(path.join(root, 'nested'))).toEqual({
      dotGitPath: gitDir,
      worktreeGitDir: gitDir,
      commonGitDir: gitDir,
    });
    expect(worktreeLocalConfigPath(root)).toBe(path.join(gitDir, 'awl', 'config.local.json'));
  });

  it('linked worktree에서는 overlay를 shared common-dir가 아닌 worktree gitdir 아래에 둔다', () => {
    const repository = tmp('awl-git-layout-repo-');
    const commonGitDir = path.join(repository, '.git');
    const worktreeGitDir = path.join(commonGitDir, 'worktrees', 'lane');
    const lane = tmp('awl-git-layout-lane-');
    fs.mkdirSync(worktreeGitDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '../..\n');
    fs.writeFileSync(path.join(lane, '.git'), `gitdir: ${path.relative(lane, worktreeGitDir)}\n`);

    expect(resolveGitLayout(lane)).toEqual({
      dotGitPath: path.join(lane, '.git'),
      worktreeGitDir,
      commonGitDir,
    });
    const overlayPath = worktreeLocalConfigPath(lane);
    expect(overlayPath).toBe(path.join(worktreeGitDir, 'awl', 'config.local.json'));
    expect(overlayPath.startsWith(`${commonGitDir}${path.sep}`)).toBe(true);
    expect(path.dirname(overlayPath)).not.toBe(path.join(commonGitDir, 'awl'));
  });

  it.each([
    {
      name: 'gitdir 줄이 없는 .git',
      arrange(root: string) {
        fs.writeFileSync(path.join(root, '.git'), 'not a gitdir file\n');
      },
      message: 'gitdir:',
    },
    {
      name: '존재하지 않는 gitdir',
      arrange(root: string) {
        fs.writeFileSync(path.join(root, '.git'), 'gitdir: missing\n');
      },
      message: 'gitdir',
    },
    {
      name: '빈 commondir',
      arrange(root: string) {
        const worktreeGitDir = path.join(tmp('awl-git-layout-common-'), 'lane');
        fs.mkdirSync(worktreeGitDir, { recursive: true });
        fs.writeFileSync(path.join(worktreeGitDir, 'commondir'), '\n');
        fs.writeFileSync(path.join(root, '.git'), `gitdir: ${worktreeGitDir}\n`);
      },
      message: 'commondir',
    },
  ])('$name이면 경로를 반환하지 않고 명확히 실패한다', ({ arrange, message }) => {
    const root = tmp('awl-git-layout-invalid-');
    arrange(root);

    expect(() => resolveGitLayout(root)).toThrow(message);
    expect(fs.existsSync(path.join(root, '.git', 'awl'))).toBe(false);
  });
});
