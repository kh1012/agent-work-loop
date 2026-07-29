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
    for (const cmd of ['brief', 'metrics', 'feedback-log', 'version-check']) {
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
    expect(md).toContain('awl feedback-log'); // 모아보기 명령
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

// 설계 대조 2단계 #15 — 오케스트레이터를 은퇴시켰으므로(#3) README 도 그 구조를
// 더는 설명하지 않는다. 레인은 남지만 세션을 띄우는 건 사람이다.
describe('작업 루프와 오케스트레이션 노출', () => {
  it('README 가 레인을 여는 법과 여는 주체를 함께 말한다', () => {
    const md = read('README.md');
    const head = md.indexOf('## 작업 루프와 오케스트레이션');
    expect(head).toBeGreaterThan(-1);
    const section = md.slice(head);
    expect(section).toContain('awl run --lanes'); // 레인을 여는 명령
    expect(section).toContain('awl lanes'); // 현황
    expect(section).toContain('/awl'); // 레인에서 사람이 도는 것
    // 스폰 주체를 흐리지 않는다 — awl 이 띄우는 것처럼 읽히면 안 된다.
    expect(section).toContain('오케스트레이터 에이전트를 두지 않습니다');
  });

  it('README 에 은퇴한 파이프라인 표면이 남아 있지 않다', () => {
    const md = read('README.md');
    for (const gone of ['awl-pipeline', '--pipeline', 'gate-high', 'gate-low']) {
      expect(md).not.toContain(gone);
    }
    // --gl/--gm/--gh 게이트밀도 축약(뒤에 단어가 안 붙는 형태)도 사라져야 한다.
    expect(md).not.toMatch(/--g[lmh]\b/);
  });

  it('두 층을 구분된 용어로 지칭한다', () => {
    const md = read('README.md');
    expect(md).toContain('작업 루프');
    expect(md).toContain('오케스트레이션');
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
