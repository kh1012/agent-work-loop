import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type HoldRecheckResult,
  parseHoldDependencies,
  recheckHolds,
  runHoldRecheck,
} from '../../src/commands/hold-recheck.js';

const origCwd = process.cwd();

afterEach(() => {
  process.chdir(origCwd);
});

function tmpProject(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-hold-')));
  fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
  for (const d of ['plan', 'exec', 'review']) {
    fs.mkdirSync(path.join(root, '.tasks', d), { recursive: true });
  }
  return root;
}

function writePlan(root: string, file: string, content: string): void {
  fs.writeFileSync(path.join(root, '.tasks', 'plan', file), content);
}

function writeExec(root: string, file: string): void {
  fs.writeFileSync(path.join(root, '.tasks', 'exec', file), '');
}

function planFiles(root: string): string[] {
  return fs.readdirSync(path.join(root, '.tasks', 'plan'));
}

// --- AC-01: 파싱 ---

describe('parseHoldDependencies — un-hold 조건 절에서 의존 workitem id 추출(AC-01)', () => {
  it('단건 의존(콜론+같은줄, gallery-constraints 류 실 포맷)을 뽑는다', () => {
    const content = `---
name: gallery-constraints
---
> [HOLD] 의존 대기.
un-hold 조건: gallery-responsive-model 합격 후
`;
    expect(parseHoldDependencies(content)).toEqual(['gallery-responsive-model']);
  });

  it('다건 의존(쉼표 구분)을 전부 뽑는다(gallery-consistency 류)', () => {
    const content =
      'un-hold 조건: gallery-detail-figma, gallery-ds-tokens, gallery-responsive-model 합격 후';
    expect(parseHoldDependencies(content)).toEqual([
      'gallery-detail-figma',
      'gallery-ds-tokens',
      'gallery-responsive-model',
    ]);
  });

  it('헤딩 스타일(마커 다음 줄에 조건)도 뽑는다', () => {
    const content = '## un-hold 조건\ngallery-autolayout-align 합격 후\n';
    expect(parseHoldDependencies(content)).toEqual(['gallery-autolayout-align']);
  });

  it('굵게(**) 강조된 마커도 뽑는다', () => {
    const content = '**un-hold 조건**: gallery-ds-tokens 합격 후';
    expect(parseHoldDependencies(content)).toEqual(['gallery-ds-tokens']);
  });

  it('마커가 없으면(전략문서·판별불가) 빈 배열 — un-hold 하지 않을 신호(AC-03)', () => {
    const content =
      '> [HOLD — exec 자동 부적합] 설계 레퍼런스 일감. 사람 조율 필요.\n## 목표\n다른 계획 문서 참조.\n';
    expect(parseHoldDependencies(content)).toEqual([]);
  });

  it('마커 밖(문서 다른 곳)의 kebab-case 언급은 조건절로 안 섞인다', () => {
    // 조건절 이전에 다른 워크아이템(gallery-detail-figma)을 언급해도, 마커 뒤 절만 본다.
    const content =
      '배경: gallery-detail-figma 는 무관하다.\nun-hold 조건: gallery-ds-tokens 합격 후\n다른 참고: gallery-lint-scope 문서.';
    expect(parseHoldDependencies(content)).toEqual(['gallery-ds-tokens']);
  });

  it('중복 id는 한 번만 남긴다', () => {
    const content = 'un-hold 조건: gallery-ds-tokens, gallery-ds-tokens 합격 후';
    expect(parseHoldDependencies(content)).toEqual(['gallery-ds-tokens']);
  });

  it('"un-hold" 단어만 있고 "조건"이 없으면(마커 불일치) 빈 배열', () => {
    const content = '이 작업은 un-hold 하기 어렵다. 별도 판단 필요.';
    expect(parseHoldDependencies(content)).toEqual([]);
  });
});

// --- AC-02/AC-03: recheckHolds ---

describe('recheckHolds — 착지+합격 의존이면 rename만(AC-02), 미충족/패턴없음은 유지(AC-03)', () => {
  it('단건 의존이 착지+합격이면 .hold.md 를 .md 로 rename하고 내용은 그대로다', () => {
    const root = tmpProject();
    const holdContent =
      '---\nname: gallery-constraints\n---\nun-hold 조건: gallery-responsive-model 합격 후\n';
    writePlan(root, 'gallery-constraints.hold.md', holdContent);
    writeExec(root, 'gallery-responsive-model.taken.md'); // 착지+합격(review 무파일)

    const result = recheckHolds(root);

    expect(result.unheld).toEqual(['gallery-constraints']);
    expect(result.kept).toEqual([]);
    const files = planFiles(root);
    expect(files).toContain('gallery-constraints.md');
    expect(files).not.toContain('gallery-constraints.hold.md');
    expect(
      fs.readFileSync(path.join(root, '.tasks', 'plan', 'gallery-constraints.md'), 'utf8'),
    ).toBe(holdContent);
  });

  it('단건 의존이 미착지면 hold를 유지한다', () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-constraints.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    // gallery-responsive-model 관련 exec 마커 없음 = 미착지

    const result = recheckHolds(root);

    expect(result.unheld).toEqual([]);
    expect(result.kept).toEqual([
      {
        name: 'gallery-constraints',
        reason: 'unsatisfied',
        waitingOn: ['gallery-responsive-model'],
      },
    ]);
    expect(planFiles(root)).toContain('gallery-constraints.hold.md');
  });

  it('다건 의존은 전부 충족돼야 un-hold — 부분충족(gallery-consistency 류)은 유지', () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-consistency.hold.md',
      'un-hold 조건: gallery-detail-figma, gallery-ds-tokens, gallery-responsive-model 합격 후',
    );
    writeExec(root, 'gallery-ds-tokens.taken.md');
    writeExec(root, 'gallery-responsive-model.taken.md');
    // gallery-detail-figma 는 미착지 그대로 둔다.

    const result = recheckHolds(root);

    expect(result.unheld).toEqual([]);
    expect(result.kept).toEqual([
      { name: 'gallery-consistency', reason: 'unsatisfied', waitingOn: ['gallery-detail-figma'] },
    ]);
  });

  it('다건 의존이 전부 착지+합격이면 un-hold 한다', () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-consistency.hold.md',
      'un-hold 조건: gallery-detail-figma, gallery-ds-tokens, gallery-responsive-model 합격 후',
    );
    writeExec(root, 'gallery-detail-figma.taken.md');
    writeExec(root, 'gallery-ds-tokens.taken.md');
    writeExec(root, 'gallery-responsive-model.taken.md');

    const result = recheckHolds(root);

    expect(result.unheld).toEqual(['gallery-consistency']);
  });

  it('un-hold 조건 패턴이 없는 전략문서 hold는 의존 충족 여부와 무관하게 건드리지 않는다(AC-03)', () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-figma-resume-strategy.hold.md',
      '> [HOLD — exec 자동 부적합] 전략문서+사람결정 대기. 실행형 판별로 hold.\n## 목표\n디자인 재개 전략을 사람이 정한다.\n',
    );

    const result = recheckHolds(root);

    expect(result.unheld).toEqual([]);
    expect(result.kept).toEqual([
      { name: 'gallery-figma-resume-strategy', reason: 'no-condition' },
    ]);
    expect(planFiles(root)).toContain('gallery-figma-resume-strategy.hold.md');
  });

  it('review/<dep>.md(수정요구)가 남아있으면 exec taken이 있어도 착지+합격이 아니다', () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-constraints.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    writeExec(root, 'gallery-responsive-model.taken.md');
    fs.writeFileSync(
      path.join(root, '.tasks', 'review', 'gallery-responsive-model.md'),
      '수정요구',
    );

    const result = recheckHolds(root);

    expect(result.unheld).toEqual([]);
    expect(result.kept[0]?.reason).toBe('unsatisfied');
  });

  it('.hold.md 아닌 plan 파일은 손대지 않는다', () => {
    const root = tmpProject();
    writePlan(root, 'freshwi.md', '신규 일감');
    const result = recheckHolds(root);
    expect(result.unheld).toEqual([]);
    expect(result.kept).toEqual([]);
    expect(planFiles(root)).toEqual(['freshwi.md']);
  });
});

// --- F-01 실측 6건 재현 + F-02 대조군 3건 (도그푸딩 동형) ---

describe('recheckHolds — F-01 실측 6건 재현 + F-02 대조군 3건 (pipeline-hold-recheck 도그푸딩)', () => {
  function seedF01(root: string): void {
    // 의존 gallery-responsive-model — 3건(단건류)
    writePlan(
      root,
      'gallery-constraints.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    writePlan(
      root,
      'gallery-responsive-ui.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    writePlan(
      root,
      'gallery-multi-artboard.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    // 의존 gallery-ds-tokens — 2건
    writePlan(root, 'gallery-ds-cascade.hold.md', 'un-hold 조건: gallery-ds-tokens 합격 후');
    writePlan(
      root,
      'gallery-openpencil-pipeline.hold.md',
      'un-hold 조건: gallery-ds-tokens 합격 후',
    );
    // 의존 gallery-autolayout-align — 1건
    writePlan(
      root,
      'gallery-layout-grid.hold.md',
      'un-hold 조건: gallery-autolayout-align 합격 후',
    );
    // 3개 의존 모두 착지+합격
    writeExec(root, 'gallery-responsive-model.taken.md');
    writeExec(root, 'gallery-ds-tokens.taken.md');
    writeExec(root, 'gallery-autolayout-align.taken.md');

    // 대조군 3건(F-02) — 이번 재점검에서 안 풀려야 한다
    writePlan(
      root,
      'gallery-consistency.hold.md',
      'un-hold 조건: gallery-detail-figma, gallery-ds-cascade, gallery-responsive-model 합격 후',
    ); // gallery-detail-figma 미착지
    writePlan(root, 'gallery-lint-scope.hold.md', 'un-hold 조건: gallery-ds-cascade 합격 후'); // ds-cascade 자체가 미실행(un-hold 됐어도 미착지)
    writePlan(root, 'gallery-figma-resume-strategy.hold.md', '> [HOLD] 전략문서+사람결정 대기.\n'); // 패턴 없음
  }

  it('의존 착지+합격 6건은 un-hold, 대조군 3건은 hold 유지', () => {
    const root = tmpProject();
    seedF01(root);

    const result = recheckHolds(root);

    expect(result.unheld.sort()).toEqual(
      [
        'gallery-constraints',
        'gallery-responsive-ui',
        'gallery-multi-artboard',
        'gallery-ds-cascade',
        'gallery-openpencil-pipeline',
        'gallery-layout-grid',
      ].sort(),
    );
    const keptNames = result.kept.map((k) => k.name).sort();
    expect(keptNames).toEqual(
      ['gallery-consistency', 'gallery-lint-scope', 'gallery-figma-resume-strategy'].sort(),
    );
    const files = planFiles(root);
    for (const n of result.unheld) {
      expect(files).toContain(`${n}.md`);
      expect(files).not.toContain(`${n}.hold.md`);
    }
    for (const n of keptNames) {
      expect(files).toContain(`${n}.hold.md`);
    }
  });

  it('gallery-lint-scope 는 gallery-ds-cascade 가 같은 재점검에서 un-hold 돼도 여전히 hold — un-hold ≠ 착지+합격', () => {
    // gallery-ds-cascade 가 이번 recheckHolds 호출로 .md 로 풀려도, 그건 "착수 가능"이지
    // "exec/gallery-ds-cascade.taken.md 존재"(착지+합격)가 아니다. gallery-lint-scope 는
    // 그 착지+합격을 요구하므로 순서와 무관하게 이번 재점검에서 계속 hold 여야 한다.
    const root = tmpProject();
    seedF01(root);
    const result = recheckHolds(root);
    const lintScope = result.kept.find((k) => k.name === 'gallery-lint-scope');
    expect(lintScope).toEqual({
      name: 'gallery-lint-scope',
      reason: 'unsatisfied',
      waitingOn: ['gallery-ds-cascade'],
    });
  });
});

// --- AC-04: 같은 턴 즉시 반영 ---

describe('recheckHolds — un-hold 직후 같은 턴에 즉시 반영(AC-04)', () => {
  it('recheckHolds 가 반환한 시점에 이미 plan 디렉토리가 갱신돼 있다(동기, 추가 대기 없음)', () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-constraints.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    writeExec(root, 'gallery-responsive-model.taken.md');

    const result = recheckHolds(root);

    // 별도 await/재조회 없이, 반환 직후 같은 동기 코드에서 바로 신규 착수 후보로 보인다.
    expect(result.unheld).toContain('gallery-constraints');
    const files = planFiles(root); // 워처 재무장·다음 유휴를 기다리지 않고 즉시 재스캔
    expect(files).toContain('gallery-constraints.md');
  });

  it('unheld 목록에 오른 이름은 워처 재감지 대상(.md, .taken/.hold 아님)과 동일 판정이다', () => {
    const root = tmpProject();
    writePlan(root, 'gallery-ds-cascade.hold.md', 'un-hold 조건: gallery-ds-tokens 합격 후');
    writeExec(root, 'gallery-ds-tokens.taken.md');

    const result = recheckHolds(root);
    const files = planFiles(root);
    const isFreshCandidate = (name: string): boolean =>
      files.includes(`${name}.md`) &&
      !files.includes(`${name}.taken.md`) &&
      !files.includes(`${name}.hold.md`);

    for (const name of result.unheld) {
      expect(isFreshCandidate(name)).toBe(true);
    }
  });
});

// --- CLI 글루 (runHoldRecheck) ---

// --- AC-04: SKILL.md 절차 명문화(섹션 범위 안에서 공존 단언, G-059) ---

describe('engine/awl-pipeline-exec SKILL.md — hold 재점검 절차 명문화(AC-04)', () => {
  const skillPath = path.join(process.cwd(), 'engine/skills/claude/awl-pipeline-exec/SKILL.md');
  const skill = fs.readFileSync(skillPath, 'utf8');

  /** "### N. 제목" 헤딩부터 다음 "### " 헤딩(또는 "## ") 전까지만 잘라낸다 — 토큰 존재만 보면
   * 문서 어디에나 있어도 통과하는 함정(G-059)을 피하려고 섹션 범위로 슬라이스한다. */
  function section(heading: string): string {
    const start = skill.indexOf(heading);
    expect(start, `"${heading}" 섹션이 없습니다`).toBeGreaterThanOrEqual(0);
    const rest = skill.slice(start + heading.length);
    const nextHeadingRel = rest.search(/\n#{2,3} /);
    return nextHeadingRel === -1 ? rest : rest.slice(0, nextHeadingRel);
  }

  it('한 틱 우선순위에 "hold 재점검" 단계가 신규 착수(2) 다음, 유휴(4) 앞에 있다', () => {
    const idx1 = skill.indexOf('### 1. 피드백 반영');
    const idx2 = skill.indexOf('### 2. 신규 착수');
    const idx3 = skill.indexOf('### 3. hold 재점검');
    const idx4 = skill.indexOf('### 4. 유휴');
    for (const idx of [idx1, idx2, idx3, idx4]) {
      expect(idx).toBeGreaterThanOrEqual(0);
    }
    expect(idx1).toBeLessThan(idx2);
    expect(idx2).toBeLessThan(idx3);
    expect(idx3).toBeLessThan(idx4);
  });

  it('hold 재점검 섹션 안에서 awl hold-recheck 호출과 un-hold 조건 파싱이 같이 서술된다', () => {
    const body = section('### 3. hold 재점검');
    expect(body).toContain('awl hold-recheck');
    expect(body).toContain('un-hold 조건');
    expect(body).toContain('착지+합격');
  });

  it('un-hold 직후 같은 턴에 2(신규 착수)로 돌아간다는 즉시착수 절차가 명문화돼 있다(다음 유휴까지 안 미룸)', () => {
    const body = section('### 3. hold 재점검');
    expect(body).toContain('그 턴에 바로 2(신규 착수)로 돌아가');
    expect(body).toContain('다음 워처 발화·다음 유휴까지 미루지 않는다');
  });

  it('유휴(4) 섹션은 1·2·3 모두 처리할 게 없을 때만 워처를 재무장한다', () => {
    const idx4 = skill.indexOf('### 4. 유휴');
    const around = skill.slice(idx4, idx4 + 200);
    expect(around).toContain('1·2·3 모두 처리할 게 없으면');
  });
});

describe('runHoldRecheck — CLI 핸들러 (glue 커버, G-047)', () => {
  it('--json: 재점검 결과를 그대로 JSON으로 낸다', async () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-constraints.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    writeExec(root, 'gallery-responsive-model.taken.md');
    process.chdir(root);

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      await runHoldRecheck({ json: true });
    } finally {
      spy.mockRestore();
    }
    const parsed = JSON.parse(buf) as HoldRecheckResult;
    expect(parsed.unheld).toEqual(['gallery-constraints']);
    // JSON 출력 경로도 실제로 rename 을 수행한다(렌더만 하고 side effect 를 건너뛰지 않는다).
    expect(planFiles(root)).toContain('gallery-constraints.md');
  });

  it('--json 없이: 사람이 읽는 카드에 un-hold 된 이름과 유지된 이름/사유가 모두 보인다', async () => {
    const root = tmpProject();
    writePlan(
      root,
      'gallery-constraints.hold.md',
      'un-hold 조건: gallery-responsive-model 합격 후',
    );
    writeExec(root, 'gallery-responsive-model.taken.md');
    writePlan(root, 'gallery-figma-resume-strategy.hold.md', '> [HOLD] 전략문서+사람결정 대기.\n');
    process.chdir(root);

    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      await runHoldRecheck({ json: false });
    } finally {
      spy.mockRestore();
    }
    expect(buf).toContain('gallery-constraints');
    expect(buf).toContain('gallery-figma-resume-strategy');
  });

  it('재점검할 hold 가 없으면 빈 결과를 낸다(크래시하지 않는다)', async () => {
    const root = tmpProject();
    process.chdir(root);
    let buf = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      buf += String(c);
      return true;
    });
    try {
      await runHoldRecheck({ json: true });
    } finally {
      spy.mockRestore();
    }
    expect(JSON.parse(buf)).toEqual({ unheld: [], kept: [] });
  });
});
