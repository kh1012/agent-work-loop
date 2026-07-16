import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildRescueGuidance,
  checkBaseDrift,
  isolatedCommit,
  runCommit,
  startBaseline,
} from '../../src/commands/commit.js';
import { getCriterion, loadState } from '../../src/commands/state.js';

function makeRepo(): { dir: string; g: (args: string[]) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-commit-'));
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  g(['init', '-q']);
  g(['config', 'user.email', 'x@x.com']);
  g(['config', 'user.name', 'x']);
  g(['config', 'commit.gpgsign', 'false']);
  return { dir, g };
}

describe('isolatedCommit — 남의 작업을 잃지 않는다 (핵심)', () => {
  it('남의 미커밋 변경이 섞여도 내 변경만 커밋하고 남의 것은 워킹트리에 보존', async () => {
    const { dir, g } = makeRepo();
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, `${Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n')}\n`);
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    // 남의 미커밋 변경(line1), 그 상태에서 베이스라인.
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('line1\n', 'OTHER\n'));
    const { snapshot } = await startBaseline(dir, 'AC-01');

    // 내 변경(line10).
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('line10', 'MINE'));

    const outcome = await isolatedCommit(dir, 'AC-01', '레이어 패널 이동', snapshot);

    expect(outcome.committed).toBe(true);
    expect(outcome.selfCheckOk).toBe(true);
    expect(outcome.stagedFiles).toContain('f.txt');

    const show = g(['show', 'HEAD']);
    expect(show).not.toContain('OTHER'); // 남의 변경이 커밋에 안 들어감
    expect(show).toContain('MINE');
    expect(show).toContain('[AC-01]'); // 완료 조건 ID 포함

    // 워킹트리에 남의 변경이 그대로 남아있다.
    expect(fs.readFileSync(f, 'utf8')).toContain('OTHER');
  });

  it('내 변경과 남의 변경이 인접해 hunk 가 겹치면 커밋하지 않고 알린다', async () => {
    const { dir, g } = makeRepo();
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, 'a\nb\nc\nd\ne\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    fs.writeFileSync(f, 'a\nBOTHER\nc\nd\ne\n'); // 남: line2
    const { snapshot } = await startBaseline(dir, 'AC-02');
    fs.writeFileSync(f, 'a\nBOTHER\nCMINE\nd\ne\n'); // 나: line3 (인접)

    const outcome = await isolatedCommit(dir, 'AC-02', 'my', snapshot);

    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toContain('안전하게 분리할 수 없');
    // 워킹트리는 그대로(남의 것도 내 것도 유실 없음).
    expect(fs.readFileSync(f, 'utf8')).toBe('a\nBOTHER\nCMINE\nd\ne\n');
  });

  it('커밋할 내 변경이 없으면 커밋하지 않는다', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    const { snapshot } = await startBaseline(dir, 'AC-03');
    const outcome = await isolatedCommit(dir, 'AC-03', 'nothing', snapshot);
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toContain('내 변경이 없습니다');
  });

  it('stash 왕복 복구 경로가 응집 변경(tracked 2 + 새 파일 1)을 격리 커밋한다 (commit-start-rescue AC-02)', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a0\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b0\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    // --start 없이 응집 구현: tracked 2개 수정 + 새 파일 1개(untracked).
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a0\nMINE-A\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b0\nMINE-B\n');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'NEW-C\n');
    // 안내한 복구 경로: stash push -u → startBaseline(clean→snapshot=HEAD) → stash pop → isolatedCommit.
    g(['stash', 'push', '-u']);
    const { snapshot } = await startBaseline(dir, 'AC-1');
    g(['stash', 'pop']);
    const outcome = await isolatedCommit(dir, 'AC-1', 'cohesive', snapshot);
    expect(outcome.committed).toBe(true);
    // 세 변경이 모두 격리 커밋에 포함(남의 파일 없음).
    expect([...outcome.stagedFiles].sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
  });
});

describe('isolatedCommit — HEAD 드리프트 감지 (자체검증 순환참조 방지, D-36)', () => {
  it('베이스라인 시작 이후 다른 커밋이 HEAD 에 얹히면 거부한다(자체 검증은 이 경우를 못 잡는다)', async () => {
    const { dir, g } = makeRepo();
    const f = path.join(dir, 'f.txt');
    const other = path.join(dir, 'other.txt');
    fs.writeFileSync(f, 'a\n');
    fs.writeFileSync(other, '기존 내용\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    const { snapshot, head } = await startBaseline(dir, 'AC-01');

    // 내 변경(f.txt 만 건드림).
    fs.writeFileSync(f, 'a\nMINE\n');

    // 그 사이 다른 커밋이 이 브랜치 HEAD 에 얹힘(다른 완료조건을 실수로 여기서
    // 커밋했거나, 동시 진행 중인 다른 세션/에이전트의 작업) — 내가 안 건드린
    // other.txt 를 "수정"한다(신규 추가가 아니라 기존 파일 수정이라 git apply
    // --cached 충돌 없이 조용히 diff 에 흡수된다. 이게 자체 검증이 못 잡는 진짜
    // 취약점 — 신규 파일 추가라면 우연히 apply 충돌로 걸리지만, 기존 파일
    // 수정/삭제는 그렇지 않다).
    fs.writeFileSync(other, '다른 세션이 수정함\n');
    g(['add', 'other.txt']);
    g(['commit', '-q', '-m', 'other work landed in between']);

    const outcome = await isolatedCommit(dir, 'AC-01', 'my change', snapshot, [], head);

    expect(outcome.committed).toBe(false);
    expect(outcome.reason).toContain('HEAD');
    // 아무것도 커밋되거나 스테이징되지 않았어야 한다 — 워킹트리 변경도 그대로.
    expect(fs.readFileSync(f, 'utf8')).toBe('a\nMINE\n');
    const log = g(['log', '--oneline']);
    expect(log.trim().split('\n')).toHaveLength(2); // base + other work 뿐, 내 커밋 없음
  });

  it('HEAD 가 그대로면 expectedHead 를 줘도 평소처럼 커밋된다(하위호환)', async () => {
    const { dir, g } = makeRepo();
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, 'a\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    const { snapshot, head } = await startBaseline(dir, 'AC-01');
    fs.writeFileSync(f, 'a\nMINE\n');

    const outcome = await isolatedCommit(dir, 'AC-01', 'my change', snapshot, [], head);

    expect(outcome.committed).toBe(true);
    expect(outcome.selfCheckOk).toBe(true);
  });

  it('expectedHead 없이는(옛 동작) 드리프트가 여전히 hunk 충돌로 걸리지만, 원인이 HEAD 이동이라는 건 안 알려준다', async () => {
    const { dir, g } = makeRepo();
    const f = path.join(dir, 'f.txt');
    const other = path.join(dir, 'other.txt');
    fs.writeFileSync(f, 'a\n');
    fs.writeFileSync(other, '기존 내용\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    const { snapshot } = await startBaseline(dir, 'AC-01');
    fs.writeFileSync(f, 'a\nMINE\n');
    fs.writeFileSync(other, '다른 세션이 수정함\n');
    g(['add', 'other.txt']);
    g(['commit', '-q', '-m', 'other work landed in between']);

    // expectedHead 를 안 준다 — 이게 지금까지의 실제 호출 방식이었다.
    // 실측 결과: 이 경우 apply 가 실패해 결국 커밋은 안 된다(index 가 이미
    // 드리프트 커밋 내용으로 reset 돼 있어 patch 의 이전 상태와 안 맞음).
    // 다만 이유가 "hunk 충돌"로만 나와 HEAD 가 이동했다는 진짜 원인은 안 보인다.
    const outcome = await isolatedCommit(dir, 'AC-01', 'my change', snapshot);
    expect(outcome.committed).toBe(false);
    expect(outcome.reason).not.toContain('HEAD'); // 원인 불명확 — expectedHead 로 고친 버전과 대조됨
  });

  it('expectedHead 를 안 주면(생략) 기존처럼 드리프트 확인을 건너뛰고 hunk 로직만 탄다(호출부 하위호환)', async () => {
    const { dir, g } = makeRepo();
    const f = path.join(dir, 'f.txt');
    fs.writeFileSync(f, 'a\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    const { snapshot } = await startBaseline(dir, 'AC-01');
    fs.writeFileSync(f, 'a\nMINE\n');

    // expectedHead 인자 자체를 생략 — 기존 호출부(테스트 포함)를 안 깨야 한다.
    const outcome = await isolatedCommit(dir, 'AC-01', 'my change', snapshot);

    expect(outcome.committed).toBe(true);
  });
});

describe('checkBaseDrift', () => {
  it('원본이 전진하고 파일이 겹치면 경고 정보를 준다', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'base\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    g(['branch', '-M', 'main']);

    g(['checkout', '-q', '-b', 'feature']);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'feature change\n');
    g(['commit', '-q', '-am', 'feat']);

    g(['checkout', '-q', 'main']);
    fs.writeFileSync(path.join(dir, 'f.txt'), 'main advance\n');
    g(['commit', '-q', '-am', 'adv']);

    g(['checkout', '-q', 'feature']);
    const drift = await checkBaseDrift(dir, 'main', ['f.txt']);
    expect(drift?.ahead).toBe(1);
    expect(drift?.overlap).toContain('f.txt');
  });

  it('기준 브랜치를 알 수 없으면 null(경고 생략)', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'x\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);
    // upstream 없음
    const drift = await checkBaseDrift(dir, undefined, ['f.txt']);
    expect(drift).toBeNull();
  });
});

describe('isolatedCommit — 새 파일(untracked) 처리 (dogfooding 이 잡은 결함)', () => {
  it('베이스라인 이후 새로 만든 파일도 커밋한다', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    const { snapshot, untracked } = await startBaseline(dir, 'AC-N');
    expect(untracked).toEqual([]); // 시작 시점 untracked 없음
    fs.writeFileSync(path.join(dir, 'new.ts'), 'export const x = 1;\n');

    const outcome = await isolatedCommit(dir, 'AC-N', 'add new', snapshot, untracked);
    expect(outcome.committed).toBe(true);
    expect(outcome.stagedFiles).toContain('new.ts');
    expect(g(['show', 'HEAD', '--name-only'])).toContain('new.ts');
  });

  it('남의 새 파일(시작 시점 untracked)은 커밋하지 않고 보존한다', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    // 남의 새 파일이 이미 있는 상태에서 베이스라인.
    fs.writeFileSync(path.join(dir, 'their.ts'), 'other\n');
    const { snapshot, untracked } = await startBaseline(dir, 'AC-M');
    expect(untracked).toContain('their.ts');

    // 내 새 파일.
    fs.writeFileSync(path.join(dir, 'mine.ts'), 'mine\n');
    const outcome = await isolatedCommit(dir, 'AC-M', 'add mine', snapshot, untracked);

    expect(outcome.stagedFiles).toContain('mine.ts');
    expect(outcome.stagedFiles).not.toContain('their.ts');
    // 남의 새 파일은 워킹트리에 그대로 남고 커밋에 없다.
    expect(fs.existsSync(path.join(dir, 'their.ts'))).toBe(true);
    expect(g(['show', 'HEAD', '--name-only'])).not.toContain('their.ts');
  });

  it('한글 등 비ASCII 파일명 새 파일도 스테이징한다 (리뷰어 지적 AC-05)', async () => {
    const { dir, g } = makeRepo();
    // 크로스 환경: 기본값(true)에서 한글 경로가 인용-인코딩된다. 이 조건을 강제한다.
    g(['config', 'core.quotePath', 'true']);
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    const { snapshot, untracked } = await startBaseline(dir, 'AC-K');
    fs.writeFileSync(path.join(dir, '한글파일.ts'), 'export const x = 1;\n');

    const outcome = await isolatedCommit(dir, 'AC-K', 'add korean', snapshot, untracked);
    expect(outcome.stagedFiles).toContain('한글파일.ts');

    // 커밋 파일 목록을 -z(인용 없음)로 읽어 원본 파일명과 비교한다.
    const committed = g(['show', 'HEAD', '--name-only', '--format=', '-z'])
      .split('\0')
      .filter(Boolean);
    expect(committed).toContain('한글파일.ts');
  });

  it('awl 자기 산출물(.awl-worktrees/·.awl/)은 untracked 에서 제외한다 (F-1 state.json 비대 근원)', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    // awl 이 스스로 만든 워크트리·상태 (gitignore 되지 않은 최악의 경우를 가정한다).
    fs.mkdirSync(path.join(dir, '.awl-worktrees', 'WI8'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.awl-worktrees', 'WI8', 'huge.ts'), 'x\n');
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.awl', 'state.json'), '{}\n');
    // 남의 새 파일 — 이건 계속 untracked 로 잡혀야 한다(제외 대상 아님).
    fs.writeFileSync(path.join(dir, 'their.ts'), 'other\n');

    const { untracked } = await startBaseline(dir, 'AC-SELF');
    expect(untracked).toContain('their.ts');
    expect(untracked.some((f) => f.startsWith('.awl-worktrees/'))).toBe(false);
    expect(untracked.some((f) => f.startsWith('.awl/'))).toBe(false);
  });
});

describe('baseline git ref 네임스페이스 (WI-D AC-06 — 워크아이템이 같은 AC-ID 를 재사용해도 안 겹친다)', () => {
  function setWorkitem(dir: string, workitem: string | undefined): void {
    fs.mkdirSync(path.join(dir, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.awl', 'state.json'),
      JSON.stringify(workitem ? { workitem } : {}),
    );
  }

  it('서로 다른 workitem 이면 같은 AC-ID 라도 서로 다른 ref 경로를 쓴다', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    setWorkitem(dir, 'WI-A');
    await startBaseline(dir, 'AC-01');
    setWorkitem(dir, 'WI-B');
    await startBaseline(dir, 'AC-01');

    const refs = g(['for-each-ref', '--format=%(refname)', 'refs/awl/baseline/']);
    expect(refs).toContain('refs/awl/baseline/WI-A/AC-01');
    expect(refs).toContain('refs/awl/baseline/WI-B/AC-01');
  });

  it('workitem 이 없으면(레거시 state) 예전처럼 AC-ID 만 쓴다(회귀 없음)', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    await startBaseline(dir, 'AC-01'); // .awl/state.json 자체가 없다.

    const refs = g(['for-each-ref', '--format=%(refname)', 'refs/awl/baseline/']);
    expect(refs.trim()).toBe('refs/awl/baseline/AC-01');
  });

  it('workitem/ac 에 연속 마침표·공백이 있어도 sanitize 해서 ref 를 만든다 (AC-12, 리뷰 지적)', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    setWorkitem(dir, 'WI-A..B');
    await startBaseline(dir, 'AC 01');

    const refs = g(['for-each-ref', '--format=%(refname)', 'refs/awl/baseline/']);
    expect(refs).not.toContain('..');
    expect(refs).not.toContain('AC 01');
  });

  it('update-ref 가 실패해도(예: 레거시 leaf ref 와 D/F 충돌) 크래시하지 않고 경고만 남긴다 (AC-12, 리뷰 지적)', async () => {
    const { dir, g } = makeRepo();
    fs.writeFileSync(path.join(dir, 'f.txt'), 'a\n');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'base']);

    // 레거시(워크아이템 없음) baseline 으로 leaf ref refs/awl/baseline/AC-06 을 먼저 만든다.
    await startBaseline(dir, 'AC-06');

    // workitem 이름이 우연히 'AC-06' 이면 refs/awl/baseline/AC-06/AC-07 을 만들려다
    // 이미 leaf 로 존재하는 AC-06 과 D/F 충돌한다 — sanitize 로는 못 막는 케이스.
    setWorkitem(dir, 'AC-06');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await expect(startBaseline(dir, 'AC-07')).resolves.toBeDefined();
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});

describe('buildRescueGuidance (WI-F AC-04 — commit 거부 시 대안 안내, 실사고 재현 방지)', () => {
  it('hunk 충돌 거부일 때만 격리 워크트리로 옮기는 구체적 명령을 담은 안내를 만든다', () => {
    const reason =
      '내 변경을 안전하게 분리할 수 없습니다(hunk 가 남의 변경과 겹칠 수 있습니다). 커밋하지 않았습니다. 사람이 확인하세요.\nerror: patch failed';
    const guidance = buildRescueGuidance(reason);
    expect(guidance).not.toBeNull();
    expect(guidance).toContain('git stash push -u');
    expect(guidance).toContain('git worktree add');
    expect(guidance).toContain('git stash pop');
    expect(guidance).toContain('awl work new');
  });

  it('"커밋할 변경 없음" 등 다른 거부 사유에는 안내를 안 붙인다(관련 없는 안내로 화면을 안 채운다)', () => {
    expect(buildRescueGuidance('커밋할 내 변경이 없습니다.')).toBeNull();
    expect(buildRescueGuidance('커밋 실패: 잠긴 저장소')).toBeNull();
    expect(buildRescueGuidance(undefined)).toBeNull();
  });
});

describe('firstBaseline (WI-H AC-01) — 재시작/여러 커밋에도 range-start 가 안 바뀐다', () => {
  const origCwd = process.cwd();
  const origHome = process.env.AWL_HOME;

  afterEach(() => {
    process.chdir(origCwd);
    if (origHome === undefined) {
      delete process.env.AWL_HOME;
    } else {
      process.env.AWL_HOME = origHome;
    }
  });

  function realGitProject(): string {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-firstbase-')));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: proj });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: proj });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: proj });
    fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
    process.chdir(proj);
    process.env.AWL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-home-'));
    return proj;
  }

  it('--start 를 여러 번 다시 해도(중간 재시작) firstBaseline 은 최초 값 그대로다', async () => {
    const proj = realGitProject();
    const commit0 = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: proj,
      encoding: 'utf8',
    }).trim();

    await runCommit('AC-01', { start: true });
    const afterFirstStart = getCriterion(loadState(proj), 'AC-01');
    expect(afterFirstStart?.firstBaseline).toBe(commit0);

    // 절차적 실수 등으로 baseline 을 다시 잡아도(D-012 교훈의 그 상황)
    // firstBaseline 은 안 바뀌어야 한다.
    fs.writeFileSync(path.join(proj, 'g.txt'), 'other\n');
    execFileSync('git', ['add', '-A'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'unrelated'], { cwd: proj });
    await runCommit('AC-01', { start: true });
    const afterSecondStart = getCriterion(loadState(proj), 'AC-01');
    expect(afterSecondStart?.firstBaseline).toBe(commit0); // 여전히 최초 값.
    expect(afterSecondStart?.baseline).not.toBe(commit0); // baseline 은 갱신됨(다른 목적).
  });

  it('완료조건을 닫아도(격리 커밋) firstBaseline 은 그대로 보존된다', async () => {
    const proj = realGitProject();
    const commit0 = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: proj,
      encoding: 'utf8',
    }).trim();

    await runCommit('AC-01', { start: true });
    fs.writeFileSync(path.join(proj, 'my-change.txt'), 'work\n');
    await runCommit('AC-01', { message: '작업 완료' });

    const closed = getCriterion(loadState(proj), 'AC-01');
    expect(closed?.firstBaseline).toBe(commit0); // range-start 는 그대로.
    expect(closed?.baseline).not.toBe(commit0); // baseline 은 이 AC 자신의 커밋으로 갱신(기존 동작 유지).
  });

  it('격리 커밋이 성공하면 그 커밋 SHA 를 criterion.commit 에 기록한다 (wi8-F3 AC-01)', async () => {
    const proj = realGitProject();
    await runCommit('AC-01', { start: true });
    fs.writeFileSync(path.join(proj, 'my-change.txt'), 'work\n');
    await runCommit('AC-01', { message: '작업 완료' });

    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: proj, encoding: 'utf8' }).trim();
    const closed = getCriterion(loadState(proj), 'AC-01');
    // commit 은 baseline 과 달리 --start 로 리셋되지 않는 "이 AC 의 마지막 격리 커밋"
    // 전용 필드 — status 의 캐노니컬 HEAD 검증(AC-02)이 이 값을 HEAD 와 대조한다.
    expect(closed?.commit).toBe(head);
  });

  it('baseline 없이 commit 하면 stash 왕복 복구 경로를 안내한다 (commit-start-rescue AC-01)', async () => {
    realGitProject();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errs: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
      errs.push(String(s));
      return true;
    });
    try {
      // --start 없이 바로 commit → baseline 부재 거부.
      await expect(runCommit('AC-9', { message: 'x' })).rejects.toThrow('exit:1');
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
    const msg = errs.join('');
    expect(msg).toContain('awl commit AC-9 --start'); // 구현 전 경로
    expect(msg).toContain('git stash push'); // 이미 구현한 경우 복구
    expect(msg).toContain('git stash pop');
  });

  it('runCommit -m 이 실제로 baseline(crit.baseline)을 expectedHead 로 넘겨 HEAD 드리프트를 거부한다 (D-36 배선 확인)', async () => {
    const proj = realGitProject();
    await runCommit('AC-01', { start: true });
    fs.writeFileSync(path.join(proj, 'my-change.txt'), 'work\n');

    // --start 이후 다른 완료조건(혹은 다른 세션)이 이 브랜치에 커밋을 얹음.
    fs.writeFileSync(path.join(proj, 'other.txt'), 'other work\n');
    execFileSync('git', ['add', 'other.txt'], { cwd: proj });
    execFileSync('git', ['commit', '-q', '-m', 'other commit landed'], { cwd: proj });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);

    await expect(runCommit('AC-01', { message: '작업 완료' })).rejects.toThrow('exit:1');
    expect(stderrSpy.mock.calls.some((c) => String(c[0]).includes('HEAD'))).toBe(true);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();

    // 커밋되지 않았어야 한다 — HEAD 는 "other commit landed" 그대로.
    const log = execFileSync('git', ['log', '--oneline'], { cwd: proj, encoding: 'utf8' });
    expect(log).not.toContain('작업 완료');
  });
});
