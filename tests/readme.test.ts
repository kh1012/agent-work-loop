import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// README 는 커밋되는 소스지만, program.ts(실제 명령 정의)가 진짜 소스 오브 트루스다.
// 이 테스트는 README 의 명령 참조가 실재하는지, 신규 명령이 문서화됐는지를 기계로 잠근다.
const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

/** program.ts 의 .command('<name>') 정의를 전부 뽑는다(top-level + subcommand). */
function programCommands(): Set<string> {
  const src = read('src/program.ts');
  const out = new Set<string>();
  for (const m of src.matchAll(/\.command\(['"]([a-z][a-z-]*)/g)) {
    if (m[1]) {
      out.add(m[1]);
    }
  }
  return out;
}

/** README 에 등장하는 `awl <cmd>` 의 첫 토큰(명령)을 전부 뽑는다(플래그·버전숫자 제외). */
function readmeCommands(): string[] {
  const md = read('README.md');
  const out: string[] = [];
  for (const m of md.matchAll(/`?awl ([a-z][a-z-]+)/g)) {
    if (m[1]) {
      out.push(m[1]);
    }
  }
  return out;
}

describe('README 명령 참조가 program.ts 와 일치한다 (readme-refresh AC-01)', () => {
  it('README 의 모든 awl <cmd> 가 실재하는 명령이다', () => {
    const valid = programCommands();
    const referenced = [...new Set(readmeCommands())];
    const unknown = referenced.filter((c) => !valid.has(c));
    expect(unknown).toEqual([]); // 실재하지 않는 명령 참조 0건
  });

  it('0.6.x 주요 신규 명령이 문서화돼 있다', () => {
    const referenced = new Set(readmeCommands());
    for (const cmd of ['brief', 'metrics', 'feedback', 'version-check']) {
      expect(referenced.has(cmd)).toBe(true);
    }
  });

  it('엔진 버전 불일치를 awl init 재실행으로 안내하지 않는다(0.5.0 에서 awl update 로 정정됨)', () => {
    const md = read('README.md');
    // "엔진 ... 버전 ... awl init 다시 실행" 식 stale 안내가 없어야 한다.
    // version-check/update 로 갱신을 안내한다.
    expect(md).toContain('awl update');
    expect(md).toContain('version-check');
  });
});
