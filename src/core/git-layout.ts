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

function requireRegularFile(candidate: string, label: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new Error(`${label} Git metadata is missing: ${candidate}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} Git metadata is not a file: ${candidate}`);
  }
}

function requireGitHead(gitDir: string, label: string): void {
  const headPath = path.join(gitDir, 'HEAD');
  requireRegularFile(headPath, label);
  const head = fs.readFileSync(headPath, 'utf8').trim();
  if (!/^ref:\s+refs\/[^\s]+$/.test(head) && !/^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(head)) {
    throw new Error(`${label} Git metadata has an invalid HEAD: ${headPath}`);
  }
}

function validateGitLayoutMetadata(worktreeGitDir: string, commonGitDir: string): void {
  requireGitHead(worktreeGitDir, 'gitdir');
  if (commonGitDir !== worktreeGitDir) {
    requireGitHead(commonGitDir, 'commondir');
  }
  requireDirectory(path.join(commonGitDir, 'objects'), 'commondir Git metadata objects');
  requireDirectory(path.join(commonGitDir, 'refs'), 'commondir Git metadata refs');
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
    validateGitLayoutMetadata(gitDir, gitDir);
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
    validateGitLayoutMetadata(worktreeGitDir, worktreeGitDir);
    return { dotGitPath, worktreeGitDir, commonGitDir: worktreeGitDir };
  }
  const commonDir = fs.readFileSync(commonDirFile, 'utf8').trim();
  if (commonDir === '') {
    throw new Error(`${commonDirFile} is empty`);
  }
  const commonGitDir = requireDirectory(path.resolve(worktreeGitDir, commonDir), 'commondir');
  validateGitLayoutMetadata(worktreeGitDir, commonGitDir);
  return { dotGitPath, worktreeGitDir, commonGitDir };
}

/** Untracked, worktree-specific AWL config overlay. */
export function worktreeLocalConfigPath(projectRoot: string): string {
  return path.join(resolveGitLayout(projectRoot).worktreeGitDir, 'awl', 'config.local.json');
}
