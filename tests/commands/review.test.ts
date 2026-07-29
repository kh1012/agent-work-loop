import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTicketRuntime, writeTicketRuntime } from '../../src/commands/commit.js';
import type { AwlConfig } from '../../src/commands/config.js';
import { createDoc } from '../../src/commands/doc.js';
import { appendRecord } from '../../src/commands/record.js';
import {
  MAX_SHOWN_RULES,
  assembleReview,
  assembleReviewForTicket,
  countReviewRoundTrips,
  runReviewPack,
  selectCriteria,
} from '../../src/commands/review.js';
import { activeRulesDir } from '../../src/commands/rules.js';
import { deriveTickets } from '../../src/commands/tickets.js';
import { parseFrontmatter } from '../../src/core/doc-frontmatter.js';

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-review-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'x@x.com']);
  g(['config', 'user.name', 'x']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'hello\n');
  g(['add', '.']);
  g(['commit', '-q', '-m', 'base']);
  return dir;
}

const CONFIG: AwlConfig = {
  project: 'p',
  mainLanguage: ['typescript'],
  character: '',
  verifications: [{ name: 'test', cmd: `${process.execPath} --version` }],
};

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/** 조건 하나짜리 스펙 → 티켓 하나를 실제로 도출한다(next.test.ts 와 같은 패턴). */
async function specWithOneTicket(
  dir: string,
  conditionText = '언제 포커스가 패널에 있고 방향키를 누르면, 선택이 이동해야 한다',
): Promise<{ specId: string; ticketId: string }> {
  const spec = await createDoc('spec', '레이어 패널 키보드 조작', dir);
  const content = fs.readFileSync(spec.path, 'utf8');
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    throw new Error('spec 스캐폴드 파싱 실패');
  }
  const body = parsed.body.replace(
    '## Conditions\n',
    `## Conditions\n\n### condition-1\n${conditionText}\n`,
  );
  fs.writeFileSync(spec.path, content.replace(parsed.body, body));

  const derived = await deriveTickets(dir, spec.id);
  const ticketId = derived.created[0]?.id;
  if (!ticketId) {
    throw new Error('티켓 도출 실패');
  }
  return { specId: spec.id, ticketId };
}

describe('selectCriteria', () => {
  const state = { criteria: [{ id: 'AC-01' }, { id: 'AC-02' }, { id: 'AC-03' }] };
  it('범위 AC-01..AC-02', () => {
    expect(selectCriteria(state, 'AC-01..AC-02').map((c) => c.id)).toEqual(['AC-01', 'AC-02']);
  });
  it('단일 AC-03', () => {
    expect(selectCriteria(state, 'AC-03').map((c) => c.id)).toEqual(['AC-03']);
  });
});

describe('assembleReview — provenance 가 핵심', () => {
  it('provenance(branch/commit/worktree/note)와 verify 를 포함하고 JSON 직렬화된다', async () => {
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed', 조건: '방향키 이동' }] };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.provenance.commit).toMatch(/^[0-9a-f]{7,}/);
    expect(bundle.provenance.worktree).toBeTruthy();
    expect(bundle.provenance.branch).toBeTruthy();
    expect(bundle.provenance.note).toContain('워크트리');

    expect(bundle.verify.passed).toBe(true);
    expect(bundle.criteria).toHaveLength(1);

    // 리뷰어(서브에이전트)가 파싱할 수 있어야 한다.
    expect(() => JSON.parse(JSON.stringify(bundle))).not.toThrow();
  });

  it('profile.json 이 없으면 localSkills 는 빈 배열이다(크래시 없음)', async () => {
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01' }] };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);
    expect(bundle.localSkills).toEqual([]);
  });

  it('profile.local.json 이 스킬을 바꾸면 bundle.localSkills 에 슬롯 이름이 실린다(WI-G16)', async () => {
    const dir = makeRepo();
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.awl', 'profile.json'),
      JSON.stringify({
        name: 'p',
        skills: {
          spec: null,
          investigation: null,
          clarification: null,
          spike: null,
          implement: null,
          review: null,
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, '.awl', 'profile.local.json'),
      JSON.stringify({
        skills: { implement: { type: 'custom', path: 'my-tdd.md' } },
      }),
    );
    const state = { criteria: [{ id: 'AC-01' }] };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);
    expect(bundle.localSkills).toEqual(['implement']);
  });

  it('config.local.json 이 skip:true 로 끈 검증은 bundle.verify 에 skipped:"local" 로 그대로 실린다(ADK stage 4, 게이트가 경고로 볼 자료)', async () => {
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };
    const configWithSkip: AwlConfig = {
      ...CONFIG,
      verifications: [
        { name: 'test', cmd: `${process.execPath} --version` },
        { name: 'e2e', cmd: `${process.execPath} -e "process.exit(1)"`, skip: true },
      ],
    };

    const bundle = await assembleReview(dir, configWithSkip, state, 'AC-01', undefined);

    expect(bundle.verify.results.find((r) => r.name === 'e2e')?.skipped).toBe('local');
    expect(bundle.verify.passed).toBe(true); // skip 은 실패가 아니다
  });
});

describe('assembleReview — reviewId 발급 (WI-S AC-02)', () => {
  it('호출마다 새 reviewId(rev_ 접두어)를 발급한다', async () => {
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };
    const bundle1 = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);
    const bundle2 = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle1.reviewId).toMatch(/^rev_/);
    expect(bundle2.reviewId).toMatch(/^rev_/);
    expect(bundle1.reviewId).not.toBe(bundle2.reviewId); // 매번 새로 발급
  });
});

describe('assembleReview — firstBaseline (WI-H AC-01, D-26/D-28 실사고 재현)', () => {
  it('범위 첫 AC 가 이미 닫혀 baseline 필드가 자기 자신의 커밋으로 덮어써졌어도, firstBaseline 이 있으면 그 AC 자신의 diff 가 빠지지 않는다', async () => {
    const dir = makeRepo();
    const commit0 = git(dir, ['rev-parse', 'HEAD']);

    // AC-01 작업 -> 닫힘. commit.ts 의 실제 동작대로: 닫히면 baseline 필드가
    // range-start(commit0) 에서 AC-01 자신의 최종 커밋(commit1)으로 덮어써진다.
    fs.writeFileSync(path.join(dir, 'ac01.txt'), 'ac01 change\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'AC-01 work']);
    const commit1 = git(dir, ['rev-parse', 'HEAD']);

    const state = {
      criteria: [{ id: 'AC-01', status: 'passed', baseline: commit1, firstBaseline: commit0 }],
    };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    // 버그였다면 baseline(commit1)을 기준으로 diff 를 잡아 ac01.txt 변경이 통째로
    // 빠졌을 것이다 — firstBaseline(commit0) 을 써야 정상적으로 포함된다.
    expect(bundle.diff).toContain('ac01.txt');
  });

  it('firstBaseline 이 없는(마이그레이션 전) 완료조건은 기존처럼 baseline 으로 폴백한다(하위호환)', async () => {
    const dir = makeRepo();
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'legacy.txt'), 'legacy change\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'legacy AC work']);

    // firstBaseline 없이 baseline 만 있는(옛 state) 완료조건 — 아직 안 닫힌 상태를
    // 흉내낸다(baseline 이 곧 range-start 인 유일한 경우).
    const state = { criteria: [{ id: 'AC-01', status: 'in_progress', baseline: commit0 }] };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.diff).toContain('legacy.txt');
  });

  it('여러 AC 범위에서 두 번째 이후 AC 의 firstBaseline 은 무시하고 범위 첫 AC 것만 쓴다(범위 시작점은 하나)', async () => {
    const dir = makeRepo();
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'ac01.txt'), 'ac01\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'AC-01']);
    const commit1 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'ac02.txt'), 'ac02\n');
    git(dir, ['add', '.']);
    git(dir, ['commit', '-q', '-m', 'AC-02']);
    const commit2 = git(dir, ['rev-parse', 'HEAD']);

    const state = {
      criteria: [
        { id: 'AC-01', status: 'passed', baseline: commit1, firstBaseline: commit0 },
        { id: 'AC-02', status: 'passed', baseline: commit2, firstBaseline: commit1 },
      ],
    };
    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01..AC-02', undefined);

    expect(bundle.diff).toContain('ac01.txt');
    expect(bundle.diff).toContain('ac02.txt');
  });
});

describe('assembleReviewForTicket — 4게이트 티켓 모델 review pack (WI-G23)', () => {
  it('존재하지 않는 티켓이면 재료 부족을 반환한다(크래시 아님)', async () => {
    const dir = makeRepo();
    const result = await assembleReviewForTicket(dir, CONFIG, 'no-such-ticket', undefined);
    expect('missing' in result).toBe(true);
    expect('missing' in result && result.missing).toContain('찾을 수 없습니다');
  });

  it('베이스라인 이후 변경이 없으면(commit --start 안 함) 재료 부족을 반환한다', async () => {
    const dir = makeRepo();
    const { ticketId } = await specWithOneTicket(dir);
    const result = await assembleReviewForTicket(dir, CONFIG, ticketId, undefined);
    expect('missing' in result).toBe(true);
    expect('missing' in result && result.missing).toContain('diff');
  });

  it('.awl/tickets/<id>.json 의 firstBaseline 을 diff 기준점으로 쓴다', async () => {
    const dir = makeRepo();
    const { ticketId } = await specWithOneTicket(dir);
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    writeTicketRuntime(dir, ticketId, { firstBaseline: commit0, baseline: commit0 });

    fs.writeFileSync(path.join(dir, 'panel.ts'), 'onKey()\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'panel 작업']);

    const result = await assembleReviewForTicket(dir, CONFIG, ticketId, undefined);
    expect('bundle' in result).toBe(true);
    if ('bundle' in result) {
      expect(result.bundle.diff).toContain('panel.ts');
      expect(result.bundle.criteria).toHaveLength(1);
      expect(result.bundle.criteria[0]?.id).toBe('condition-1');
      expect(result.bundle.criteria[0]?.text).toContain('언제 포커스가 패널에 있고');
      expect(result.bundle.reviewId).toMatch(/^rev_/);
    }
  });

  it('--base 를 주면 티켓 baseline 대신 그걸 diff 기준으로 쓴다', async () => {
    const dir = makeRepo();
    const { ticketId } = await specWithOneTicket(dir);
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'before-base.ts'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'base 이전 변경 — 안 보여야 함']);
    const commitBase = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'after-base.ts'), 'y\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'base 이후 변경']);
    writeTicketRuntime(dir, ticketId, { firstBaseline: commit0 });

    const result = await assembleReviewForTicket(dir, CONFIG, ticketId, commitBase);
    expect('bundle' in result).toBe(true);
    if ('bundle' in result) {
      expect(result.bundle.diff).toContain('after-base.ts');
      expect(result.bundle.diff).not.toContain('before-base.ts');
    }
  });

  it('스펙에서 조건 원문을 못 찾으면(스펙 파일 없음) 재료 부족을 반환한다', async () => {
    const dir = makeRepo();
    const ticket = await createDoc('ticket', '제목', dir, {
      spec: 'no-such-spec',
      conditions: ['condition-1'],
    });
    writeTicketRuntime(dir, ticket.id, { firstBaseline: git(dir, ['rev-parse', 'HEAD']) });
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'x']);

    const result = await assembleReviewForTicket(dir, CONFIG, ticket.id, undefined);
    expect('missing' in result).toBe(true);
    expect('missing' in result && result.missing).toContain('완료 조건');
  });

  it('기반 티켓(conditions:[])은 조건이 없는 게 정상이다 — 재료 부족이 아니라 빈 criteria 로 번들이 나온다 (시뮬레이션 발견, adk-simulation.md 시나리오A)', async () => {
    const dir = makeRepo();
    const spec = await createDoc('spec', '스펙', dir);
    const ticket = await createDoc('ticket', '기반 티켓', dir, { spec: spec.id, conditions: [] });
    writeTicketRuntime(dir, ticket.id, { firstBaseline: git(dir, ['rev-parse', 'HEAD']) });
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'x']);

    const result = await assembleReviewForTicket(dir, CONFIG, ticket.id, undefined);
    expect('bundle' in result).toBe(true);
    if ('bundle' in result) {
      expect(result.bundle.criteria).toEqual([]);
      expect(result.bundle.diff).toContain('x.ts');
    }
  });

  it('기반 티켓의 왕복 카운트는 review.criteria 에 담긴 티켓 자신의 id 로 잡힌다(시뮬레이션 발견 회귀 방지)', async () => {
    const dir = makeRepo();
    const spec = await createDoc('spec', '스펙', dir);
    const ticket = await createDoc('ticket', '기반 티켓', dir, { spec: spec.id, conditions: [] });
    writeTicketRuntime(dir, ticket.id, { firstBaseline: git(dir, ['rev-parse', 'HEAD']) });
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'x']);
    appendRecord(
      {
        id: 'rec_1',
        at: new Date().toISOString(),
        type: 'review',
        project: 'p',
        reviewId: 'rev_1',
        criteria: [ticket.id], // 조건 id 가 없으니 티켓 자신의 id 를 담는 관례
        findings: [{ what: '지적' }],
        cheatingDetected: [],
        verifyPassedBefore: true,
      },
      dir,
    );

    const result = await assembleReviewForTicket(dir, CONFIG, ticket.id, undefined);
    expect('bundle' in result).toBe(true);
    if ('bundle' in result) {
      expect(result.bundle.roundTrips).toBe(1);
    }
  });

  it('조건이 있는데 그중 일부만 스펙에서 못 찾으면 그 id 를 지목해 재료 부족을 반환한다', async () => {
    const dir = makeRepo();
    const spec = await createDoc('spec', '스펙', dir);
    const content = fs.readFileSync(spec.path, 'utf8');
    const parsed = parseFrontmatter(content);
    if (!parsed) {
      throw new Error('스펙 파싱 실패');
    }
    const body = parsed.body.replace(
      '## Conditions\n',
      '## Conditions\n\n### condition-1\n실재하는 조건\n',
    );
    fs.writeFileSync(spec.path, content.replace(parsed.body, body));
    const ticket = await createDoc('ticket', '티켓', dir, {
      spec: spec.id,
      conditions: ['condition-1', 'condition-2-없음'],
    });
    writeTicketRuntime(dir, ticket.id, { firstBaseline: git(dir, ['rev-parse', 'HEAD']) });
    fs.writeFileSync(path.join(dir, 'x.ts'), 'x\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'x']);

    const result = await assembleReviewForTicket(dir, CONFIG, ticket.id, undefined);
    expect('missing' in result).toBe(true);
    expect('missing' in result && result.missing).toContain('condition-2-없음');
    expect('missing' in result && result.missing).not.toContain('condition-1,');
  });

  it('lastReviewedCommit 이 있으면(재리뷰) firstBaseline 대신 그 지점부터 diff 를 잡는다(WI-G24, 고친 커밋만)', async () => {
    const dir = makeRepo();
    const { ticketId } = await specWithOneTicket(dir);
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'first-review.ts'), 'v1\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', '첫 리뷰 이전 작업']);
    const firstReviewedCommit = git(dir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(dir, 'after-review.ts'), 'v2\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', '지적 반영']);

    writeTicketRuntime(dir, ticketId, {
      firstBaseline: commit0,
      lastReviewedCommit: firstReviewedCommit,
    });

    const result = await assembleReviewForTicket(dir, CONFIG, ticketId, undefined);
    expect('bundle' in result).toBe(true);
    if ('bundle' in result) {
      expect(result.bundle.diff).toContain('after-review.ts');
      expect(result.bundle.diff).not.toContain('first-review.ts'); // 재리뷰라 고친 커밋만
    }
  });

  it('lastReviewedCommit 이 HEAD 와 같으면(새 커밋 없는 재요청) 재료 부족을 반환한다', async () => {
    const dir = makeRepo();
    const { ticketId } = await specWithOneTicket(dir);
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'a.ts'), 'v1\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'a']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeTicketRuntime(dir, ticketId, { firstBaseline: commit0, lastReviewedCommit: head });

    const result = await assembleReviewForTicket(dir, CONFIG, ticketId, undefined);
    expect('missing' in result).toBe(true);
  });
});

describe('countReviewRoundTrips — 순수 계산 (WI-G24)', () => {
  it('findings 가 비어있지 않은 review 만 왕복으로 센다', () => {
    const records = [
      { type: 'review', criteria: ['condition-1'], findings: [{ what: 'x' }] },
      { type: 'review', criteria: ['condition-1'], findings: [] }, // 지적 없음 — 왕복 아님
      { type: 'review', criteria: ['condition-2'], findings: [{ what: 'y' }] }, // 다른 조건 — 안 셈
    ];
    expect(countReviewRoundTrips(records, ['condition-1'])).toBe(1);
  });

  it('조건 여러 개 중 하나만 겹쳐도 센다(같은 티켓의 여러 조건)', () => {
    const records = [{ type: 'review', criteria: ['condition-2'], findings: [{ what: 'x' }] }];
    expect(countReviewRoundTrips(records, ['condition-1', 'condition-2'])).toBe(1);
  });

  it('review 기록이 없으면 0', () => {
    expect(countReviewRoundTrips([], ['condition-1'])).toBe(0);
  });

  it('기반 티켓(조건 id 없음)도 매칭 목록에 티켓 자신의 id 를 넣으면 왕복이 잡힌다(시뮬레이션 발견 회귀 방지)', () => {
    const records = [{ type: 'review', criteria: ['ticket-1'], findings: [{ what: 'x' }] }];
    // 기반 티켓은 conditionIds 가 [] 라 매칭 목록이 [ticketId] 하나뿐이어도 잡혀야 한다.
    expect(countReviewRoundTrips(records, ['ticket-1'])).toBe(1);
    expect(countReviewRoundTrips(records, [])).toBe(0); // 매칭 목록이 정말 비면 당연히 0
  });
});

describe('runReviewPack — CLI 진입점 (WI-G24 글루)', () => {
  const origCwd = process.cwd();

  it('성공하면 lastReviewedCommit 을 티켓 런타임에 남긴다(다음 재리뷰가 diff-only 로 좁혀지도록)', async () => {
    const dir = fs.realpathSync(makeRepo());
    const { ticketId } = await specWithOneTicket(dir);
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    const commit0 = git(dir, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(dir, 'panel.ts'), 'v1\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', '구현']);
    const head = git(dir, ['rev-parse', 'HEAD']);
    writeTicketRuntime(dir, ticketId, { firstBaseline: commit0 });

    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    process.chdir(dir);
    try {
      await runReviewPack(ticketId, { json: true });
    } finally {
      process.chdir(origCwd);
      stdoutSpy.mockRestore();
    }

    expect(loadTicketRuntime(dir, ticketId)?.lastReviewedCommit).toBe(head);
  });
});

describe('토큰 상한 — 프로젝트 규칙 대량 누적 스트레스 (WI-I2)', () => {
  const origHome = process.env.AWL_HOME;

  afterEach(() => {
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  /** activeRulesDir() 에 hits 가 서로 다른 규칙 n개를 직접 시딩한다(AWL_HOME 격리 후). */
  function seedRules(n: number): void {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-review-rules-home-'));
    const dir = activeRulesDir();
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < n; i++) {
      fs.writeFileSync(
        path.join(dir, `rule-${String(i).padStart(3, '0')}.md`),
        `---\nid: R-${i}\nscope: review\napplies: 조건 ${i}\ncounter: 반증 ${i}\nhits: ${i}\n---\n\n본문 ${i}\n`,
      );
    }
  }

  it(`규칙이 ${MAX_SHOWN_RULES}개를 넘으면 hits 상위 ${MAX_SHOWN_RULES}개만 본문에, 나머지는 additionalRuleIds 로 id만 담는다`, async () => {
    const total = MAX_SHOWN_RULES + 20;
    seedRules(total);
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };

    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.rules).toHaveLength(MAX_SHOWN_RULES);
    expect(bundle.additionalRuleIds).toHaveLength(total - MAX_SHOWN_RULES);
    // hits 가 가장 높은(id 가 가장 큰 번호) 규칙들이 본문에 남는다.
    const shownIds = bundle.rules.map((r) => r.id);
    expect(shownIds).toContain(`R-${total - 1}`); // hits 최댓값
    expect(shownIds).not.toContain('R-0'); // hits 최솟값은 잘려나간다
    expect(bundle.additionalRuleIds).toContain('R-0');
  });

  it(`규칙이 ${MAX_SHOWN_RULES}개 이하면 안 잘리고 additionalRuleIds 는 빈 배열이다`, async () => {
    seedRules(10);
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };

    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.rules).toHaveLength(10);
    expect(bundle.additionalRuleIds).toEqual([]);
  });

  it('규칙이 없으면(seedRules 안 씀) rules/additionalRuleIds 둘 다 빈 배열(크래시 아님)', async () => {
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-review-norules-home-'));
    const dir = makeRepo();
    const state = { criteria: [{ id: 'AC-01', status: 'passed' }] };

    const bundle = await assembleReview(dir, CONFIG, state, 'AC-01', undefined);

    expect(bundle.rules).toEqual([]);
    expect(bundle.additionalRuleIds).toEqual([]);
  });
});
