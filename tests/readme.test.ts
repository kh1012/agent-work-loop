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

describe('README 0.6.x 개념 정확성 (readme-refresh AC-02)', () => {
  it('awl-feedback 를 gotcha 와 구분해 설명한다', () => {
    const md = read('README.md');
    expect(md).toContain('awl-feedback'); // 개념 등장
    expect(md).toContain('awl feedback'); // 모아보기 명령
    // 도구 자체 피드백은 규칙으로 승격되지 않는다는 구분
    expect(md).toMatch(/규칙으로 승격되지 않습니다|awl 도구 자체/);
  });

  it('구 delta id(D-0xx) 를 현재 예시로 참조하지 않는다(deltas→gotchas)', () => {
    const md = read('README.md');
    // 구 delta 번호 형식(D-003 등)이 남아있지 않아야 한다 — gotcha 는 G-0xx.
    expect(md).not.toMatch(/\bD-\d{3}\b/);
    // promote 예시는 gotcha id(G-0xx)를 쓴다.
    expect(md).toMatch(/promote G-\d/);
  });
});
