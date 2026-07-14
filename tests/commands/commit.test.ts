import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildRescueGuidance,
  checkBaseDrift,
  isolatedCommit,
  startBaseline,
} from '../../src/commands/commit.js';

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
