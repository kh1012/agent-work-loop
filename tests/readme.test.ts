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

describe('README 파이프라인/퀵스타트 정확성 (readme-refresh AC-03)', () => {
  it('파이프라인 다이어그램에 조사→설계→명료화→스파이크→완료 조건이 순서대로 있다', () => {
    const md = read('README.md');
    const stages = ['[조사]', '[설계]', '[명료화]', '[스파이크]', '[완료 조건]'];
    let cursor = 0;
    for (const s of stages) {
      const idx = md.indexOf(s, cursor);
      expect(idx).toBeGreaterThan(-1); // 각 단계가 존재
      cursor = idx + s.length; // 순서 보장
    }
  });
});

describe('오케스트레이션 파이프라인 노출 (cli-pipeline-surface)', () => {
  it('top-level lane 설명에 파이프라인 맥락이 있다 (AC-02)', () => {
    const src = read('src/program.ts');
    // program.command('lane').description(...) 의 top-level 설명을 뽑는다.
    const m = src.match(/\.command\('lane'\)\s*\.description\(\s*'([^']*)'/);
    expect(m).not.toBeNull();
    const desc = m?.[1] ?? '';
    expect(desc).toContain('파이프라인'); // --help 명령목록 lane 줄에서 발견 가능
  });

  it('README 에 오케스트레이션 파이프라인 섹션과 3요소가 있다 (AC-01)', () => {
    const md = read('README.md');
    const head = md.indexOf('## 오케스트레이션');
    expect(head).toBeGreaterThan(-1); // ② 다중 레인 섹션 존재
    // 3요소가 섹션 안(앵커 뒤)에 공존한다 — 섹션이 비면 실패한다(AC-04 강화).
    const section = md.slice(head);
    expect(section).toContain('awl lane'); // 요소 1: 격리 레인
    expect(section).toContain('--pipeline'); // 요소 2: awl status --pipeline 롤업
    expect(section).toContain('awl-pipeline'); // 요소 3: 역할 스킬(plan/exec/review)
    // auto-spawn 미탑재는 로드맵으로만 표기(탑재된 척 금지)
    expect(section).toContain('로드맵');
  });

  it('두 pipeline 의미를 구분된 용어로 지칭한다 (AC-03)', () => {
    const md = read('README.md');
    // ① 단일 워크아이템 흐름과 ② 다중 레인을 서로 다른 용어로 부른다.
    expect(md).toContain('작업 루프'); // ① 워크플로우 라벨
    expect(md).toContain('오케스트레이션'); // ② 다중 레인 라벨
    // ① 라벨이 워크플로우 다이어그램 자리에서 먼저 등장한다(② 섹션보다 앞).
    expect(md.indexOf('작업 루프')).toBeLessThan(md.indexOf('## 오케스트레이션'));
  });
});

describe('README 담백한 사람 문체 — 금지어 (readme-refresh AC-04)', () => {
  // AI스러운 과장·번역투 마커. 사람 관점 판정(소리내 읽기)은 review 몫이고,
  // 여기서는 기계로 잡히는 금지어만 0건으로 잠근다. 활용형 우회(제공한다/통한/강력함)를
  // 막으려 어간 정규식으로 잡는다(리뷰 지적 AC-05).
  const BANNED: RegExp[] = [
    /혁신적/,
    /강력(한|함|하게)/,
    /원활(한|함|하게|히)/,
    /손쉽(게|다)/,
    /성공적으로/,
    /(을|를) 통(해|한)/,
    /제공(합니다|한다|하는|하며|해)/,
  ];

  it('금지어(활용형 포함)가 grep 0건이다', () => {
    const md = read('README.md');
    const hits = BANNED.filter((re) => re.test(md)).map((re) => re.source);
    expect(hits).toEqual([]);
  });
});
