import fs from 'node:fs';
import path from 'node:path';

export interface GitLayout {
  dotGitPath: string;
  worktreeGitDir: string;
  commonGitDir: string;
}

export function findDotGitPath(start: string): string | null {
  let cursor = path.resolve(start);
  for (;;) {
    const candidate = path.join(cursor, '.git');
    try {
      fs.lstatSync(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

function requireDirectory(candidate: string, label: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(`${label} does not exist: ${candidate}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`${label} is not a directory: ${resolved}`);
  }
  return resolved;
}

/** Resolve worktree-specific and shared Git storage without invoking Git. */
export function resolveGitLayout(projectRoot: string): GitLayout {
  const dotGitPath = findDotGitPath(projectRoot);
  if (!dotGitPath) {
    throw new Error(`${path.resolve(projectRoot)} 또는 상위 경로에서 .git을 찾지 못했습니다.`);
  }
  const dotGitStat = fs.statSync(dotGitPath);
  if (dotGitStat.isDirectory()) {
    const gitDir = requireDirectory(dotGitPath, '.git');
    return { dotGitPath, worktreeGitDir: gitDir, commonGitDir: gitDir };
  }
  if (!dotGitStat.isFile()) {
    throw new Error(`${dotGitPath} is neither a directory nor a gitdir file`);
  }

  const gitdirMatch = fs.readFileSync(dotGitPath, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
  if (!gitdirMatch) {
    throw new Error(`${dotGitPath} does not contain a gitdir: line`);
  }
  const gitdir = gitdirMatch[1];
  if (!gitdir) {
    throw new Error(`${dotGitPath} has an empty gitdir: line`);
  }
  const worktreeGitDir = requireDirectory(path.resolve(path.dirname(dotGitPath), gitdir), 'gitdir');
  const commonDirFile = path.join(worktreeGitDir, 'commondir');
  if (!fs.existsSync(commonDirFile)) {
    return { dotGitPath, worktreeGitDir, commonGitDir: worktreeGitDir };
  }
  const commonDir = fs.readFileSync(commonDirFile, 'utf8').trim();
  if (commonDir === '') {
    throw new Error(`${commonDirFile} is empty`);
  }
  const commonGitDir = requireDirectory(path.resolve(worktreeGitDir, commonDir), 'commondir');
  return { dotGitPath, worktreeGitDir, commonGitDir };
}

/** Untracked, worktree-specific AWL config overlay. */
export function worktreeLocalConfigPath(projectRoot: string): string {
  return path.join(resolveGitLayout(projectRoot).worktreeGitDir, 'awl', 'config.local.json');
}
