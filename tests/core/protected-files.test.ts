import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { protectedFilesMessage } from '../../src/core/protected-files.js';

const created: string[] = [];
afterEach(() => {
  for (const d of created.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function gitRepoWithChangedFile(): { root: string; file: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-prot-')));
  created.push(root);
  const g = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  g(['init']);
  g(['config', 'user.email', 't@t']);
  g(['config', 'user.name', 't']);
  const file = 'GUARD.md';
  fs.writeFileSync(path.join(root, file), 'v1');
  g(['add', '.']);
  g(['commit', '-m', 'init']);
  fs.writeFileSync(path.join(root, file), 'v2'); // 변경 발생
  return { root, file };
}

describe('protectedFilesMessage — 상태 마커는 호출부 몫(cli-visual-consistency AC-01)', () => {
  it('변경된 보호 파일 메시지에 raw ❌ 를 하드코딩하지 않는다(호출부가 signal로 붙임)', async () => {
    const { root, file } = gitRepoWithChangedFile();
    const msg = await protectedFilesMessage(root, [file]);
    expect(msg).not.toBeNull();
    expect(msg).not.toContain('❌'); // caps 게이트 우회하던 하드코딩 제거
    expect(msg).toContain('보호 파일이 변경되었습니다');
    expect(msg).toContain(file);
  });

  it('변경 없으면 null', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-prot2-')));
    created.push(root);
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    expect(await protectedFilesMessage(root, ['NOPE.md'])).toBeNull();
  });
});
