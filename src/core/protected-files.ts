import { run } from './runner.js';

/** HEAD 대비 변경된 추적/스테이지 파일에서 보호 파일을 찾는다. */
export async function changedProtectedFiles(
  projectRoot: string,
  protectedFiles: string[] | undefined,
): Promise<string[]> {
  if (!protectedFiles || protectedFiles.length === 0) return [];
  const result = await run({
    cmd: 'git',
    args: ['diff', '--name-only', 'HEAD'],
    cwd: projectRoot,
    timeoutMs: 15_000,
  });
  const changed = new Set(
    result.stdout
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean),
  );
  return protectedFiles.filter((file) => changed.has(file));
}

export async function protectedFilesMessage(
  projectRoot: string,
  protectedFiles: string[] | undefined,
): Promise<string | null> {
  const changed = await changedProtectedFiles(projectRoot, protectedFiles);
  return changed.length
    ? `❌ 보호 파일이 변경되었습니다: ${changed.join(', ')}\n  사람이 확인한 경우에만 --force 로 보호 파일 검사를 우회하세요.`
    : null;
}
