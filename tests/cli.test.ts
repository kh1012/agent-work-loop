import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { version as pkgVersion } from '../package.json';
import { type Caps, visibleWidth } from '../src/core/tty.js';
import {
  BANNER,
  buildProgram,
  parseExperimentOption,
  parseWorkitemsOption,
  renderBanner,
  versionString,
} from '../src/program.js';

const origHome = process.env.AWL_HOME;

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.AWL_HOME;
  } else {
    process.env.AWL_HOME = origHome;
  }
});

function tmpHomeWithEngine(engineVersion: string | null): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-ver-'));
  if (engineVersion !== null) {
    fs.mkdirSync(path.join(home, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(home, 'engine', 'version.json'), JSON.stringify({ engineVersion }));
  }
  return home;
}

/** AWL_HOME 아래 npm-latest-cache.json 을 직접 써서 readCachedLatestVersion() 픽스처를 만든다(AC-03). */
function writeNpmCache(home: string, latestVersion: string | null): void {
  fs.writeFileSync(
    path.join(home, 'npm-latest-cache.json'),
    JSON.stringify({ checkedAt: new Date().toISOString(), latestVersion }),
  );
}

describe('awl 프로그램 구성', () => {
  it('버전 정보를 노출한다', () => {
    const program = buildProgram();
    expect(program.version()).toMatch(/^awl v\d+\.\d+\.\d+/);
  });

  it('배너에 핵심 문구가 담겨 있다', () => {
    expect(BANNER).toContain('AGENT WORK LOOP');
    expect(BANNER).toContain('판단은 Claude Code나 Codex가 하고');
    expect(BANNER).toContain('awl은 파일과 상태만 관리합니다');
    // 배너에 임시 진단 문구가 없어야 한다(cli-design-tokens AC-04 회귀잠금) — 재삽입 시 실패.
    expect(BANNER).not.toContain('/awl-improve-loop');
    expect(BANNER).not.toContain('임시 피드백');
  });

  it('유니코드 TTY 배너는 조밀한 AWL 워드마크와 색상을 쓴다', () => {
    const banner = renderBanner({ unicode: true, color: true, tty: true });
    // 좌→우 무지개 그라데이션(cli-banner-rainbow)은 문자마다 개별 ANSI 코드를 입혀
    // '███████' 같은 연속 매치가 색코드 없는 원문 그대로는 안 남는다 — 색코드를
    // 벗겨낸 뒤 워드마크 존재를 확인한다.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence 를 벗겨낸다(src/core/tty.ts 의 ANSI_SGR 과 동일 관례).
    const stripped = banner.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toContain('███████');
    expect(banner).toContain('\x1b[');
  });

  it('배너는 좌측 워드마크와 우측 안내를 같은 행에 배치한다', () => {
    const banner = renderBanner({ unicode: false, color: false, tty: false });
    const lines = banner.split('\n');
    // 로고 앞 여백 줄이 있어 첫 줄엔 로고만 있을 수 있다(cli-banner 재편집) — 태그라인이
    // 처음 나오는 줄에서 ASCII 워드마크와 같은 행에 있는지 확인한다.
    const taglineLine = lines.find((l) => l.includes('AGENT WORK LOOP'));
    expect(taglineLine).toBeDefined();
    // ASCII 워드마크는 줄마다 `_`/`\`/`/` 중 일부만 쓴다(가운데 줄엔 `_` 없음) — 셋 중
    // 하나라도 있으면 로고와 같은 행이라는 뜻.
    expect(taglineLine).toMatch(/[\\/_]/);
    expect(banner.startsWith('\n')).toBe(false);
  });

  // cli-banner-align AC-03: 색 켜짐에서 열계산이 ANSI 를 폭에 포함하면(stringWidth)
  // 로고 없는 설명줄이 우측으로 밀리고(+12), 3자리 팔레트(135) 로고행은 -1칸 어긋난다.
  // 각 설명줄이 시작하는 "표시 열"을 재서 전부 같은지 잠근다. visibleWidth 로 고쳐야만
  // 통과하고, stringWidth 로 되돌리면 색 켜짐에서 열이 갈라져 fail 한다(뮤테이션-저항).
  function copyStartColumns(c: Caps): number[] {
    const rendered = renderBanner(c).split('\n');
    const copyLines = BANNER.split('\n');
    const cols: number[] = [];
    for (let i = 0; i < copyLines.length; i++) {
      const copy = copyLines[i];
      if (copy === undefined || copy.trim() === '') continue; // 빈 줄은 정렬 대상 아님
      const line = rendered[i] ?? '';
      // 렌더 줄 = 로고 + 패딩 + 설명. 설명은 마지막이고 색코드가 없다.
      // 설명 시작 열 = (색 벗긴 전체폭) - (설명폭). visibleWidth 가 ANSI 를 폭 0 으로 친다.
      // stringWidth 로 되돌리면 로고 없는 줄의 패딩이 +12, 135 팔레트 로고행이 -1 되어 열이 갈라진다.
      expect(line.endsWith(copy)).toBe(true); // 설명이 줄 끝에 그대로 있어야 한다
      cols.push(visibleWidth(line) - visibleWidth(copy));
    }
    return cols;
  }

  it('색 켜짐 배너의 모든 설명줄은 같은 열에서 시작한다 (renderBanner 정렬, AC-03)', () => {
    const cols = copyStartColumns({ unicode: true, color: true, tty: true });
    expect(cols.length).toBeGreaterThan(1);
    // 전부 첫 열과 같아야 한다. stringWidth 로 되돌리면 로고 없는 줄(+12)과 135행(-1)이 갈라진다.
    for (const col of cols) expect(col).toBe(cols[0]);
  });

  it('배너 정렬은 색 꺼짐/켜짐이 동일하다 (회귀 방지, AC-03)', () => {
    const on = copyStartColumns({ unicode: true, color: true, tty: true });
    const off = copyStartColumns({ unicode: true, color: false, tty: false });
    expect(on).toEqual(off);
  });

  it('evolve 는 스킬 전용(숨김)이라 최상위 도움말에 안 보인다', () => {
    const program = buildProgram();
    // 'evolve' 를 부분 문자열로 포함하는 다른 명령이 없어 안전하게 단독 검사할 수 있다.
    expect(program.helpInformation()).not.toContain('evolve');
  });

  it('rules promote 는 사람이 치는 명령이라 rules 도움말에 보인다', () => {
    const program = buildProgram();
    const rulesCmd = program.commands.find((c) => c.name() === 'rules');
    expect(rulesCmd?.helpInformation()).toContain('promote');
  });

  it('gotchas 는 도움말에 보이고 폐기예정 deltas 명령은 제거됐다 (deltas-removal AC-01)', () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain('gotchas');
    // deltas 는 폐기예정 잔재로 완전히 제거됐다 — 등록 자체가 없다(하위호환 별칭을 되살리면 실패).
    expect(program.helpInformation()).not.toContain('deltas');
    const deltasCmd = program.commands.find((c) => c.name() === 'deltas');
    expect(deltasCmd).toBeUndefined();
  });

  it('src/ 에 0.4.0 스테일 제거기한 잔재가 없다 (deltas-removal AC-01)', () => {
    // 삭제된 deltas 명령이 달고 있던 스테일 기한 텍스트. 재유입 방지 잠금.
    // (tests/ 는 스캔 대상이 아니라 이 파일 자체의 리터럴은 자기매칭되지 않는다.)
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const staleMarker = ['0', '.4.0'].join(''); // 자기매칭 회피용 조립
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts') && fs.readFileSync(p, 'utf8').includes(staleMarker)) {
          offenders.push(p);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('철회된 sync-skills 명령은 제거됐다 (pipeline-sync-skills-revert AC-01)', () => {
    // temp-loop-*(자기개발 하네스)와 awl-pipeline-*(배포 제품)는 독립 산출물이라
    // 영구 동기화 메커니즘이 필요 없다고 판명됐다 — 등록 자체가 없다.
    const program = buildProgram();
    expect(program.helpInformation()).not.toContain('sync-skills');
    const syncSkillsCmd = program.commands.find((c) => c.name() === 'sync-skills');
    expect(syncSkillsCmd).toBeUndefined();
  });

  it('src/ 에 sync-skills 구현 흔적이 없다 (pipeline-sync-skills-revert AC-01)', () => {
    // deriveTempLoopContent/syncPipelineSkills 등 파생 메커니즘이 재유입되면 실패한다.
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const markers = ['sync-skills', 'syncSkills', 'deriveTempLoop'];
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) {
          const content = fs.readFileSync(p, 'utf8');
          if (markers.some((m) => content.includes(m))) offenders.push(p);
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it('metrics 는 사람이 치는 명령이라 도움말에 보인다 (WI-P AC-04)', () => {
    const program = buildProgram();
    expect(program.helpInformation()).toContain('metrics');
  });

  it('실제 루트 도움말은 Codex native Scheduled polling 계약을 노출한다', () => {
    const program = buildProgram();
    let output = '';
    program.configureOutput({
      writeOut: (value) => {
        output += value;
      },
    });
    program.outputHelp();

    for (const contract of [
      '$awl-pipeline <lane명> <mode> [--poll <interval>]',
      '--poll 30m',
      'native Scheduled',
      'Scheduled capability',
    ]) {
      expect(output).toContain(contract);
    }
  });
});

describe('parseExperimentOption — --experiment 파싱/검증 (experiment-harness AC-06, 리뷰)', () => {
  it('정상 JSON 객체는 ok+value', () => {
    const r = parseExperimentOption('{"model":"lite","mode":"loop"}');
    expect(r).toEqual({ ok: true, value: { model: 'lite', mode: 'loop' } });
  });
  it('미지정/빈 문자열은 ok+undefined(정상)', () => {
    expect(parseExperimentOption(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseExperimentOption('   ')).toEqual({ ok: true, value: undefined });
  });
  it('배열은 거부(객체 아님)', () => {
    const r = parseExperimentOption('[1,2]');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('객체');
  });
  it('비객체(숫자/null)는 거부', () => {
    expect(parseExperimentOption('42').ok).toBe(false);
    expect(parseExperimentOption('null').ok).toBe(false);
  });
  it('파싱 불가는 거부', () => {
    const r = parseExperimentOption('{not json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('파싱');
  });
});

describe('parseWorkitemsOption — loop-summary --workitems 콤마 파싱 (pipeline-cycle-summary AC-06, 리뷰)', () => {
  it('콤마로 구분한 id 목록을 배열로 파싱한다', () => {
    expect(parseWorkitemsOption('WI-1,WI-2,WI-3')).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });
  it('각 항목 앞뒤 공백을 trim 한다', () => {
    expect(parseWorkitemsOption(' WI-1 , WI-2 ,WI-3 ')).toEqual(['WI-1', 'WI-2', 'WI-3']);
  });
  it('빈 항목(연속 콤마)은 버린다', () => {
    expect(parseWorkitemsOption('WI-1,,WI-2')).toEqual(['WI-1', 'WI-2']);
  });
  it('미지정/빈 문자열/공백만 있으면 undefined(단일모드 폴백)', () => {
    expect(parseWorkitemsOption(undefined)).toBeUndefined();
    expect(parseWorkitemsOption('')).toBeUndefined();
    expect(parseWorkitemsOption('   ')).toBeUndefined();
  });
  it('콤마·공백뿐이라 항목이 하나도 안 남으면 undefined(빈 배열이 아니다)', () => {
    expect(parseWorkitemsOption(' , , ')).toBeUndefined();
  });
});

const NO_COLOR: Caps = { unicode: false, color: false, tty: false };
const COLOR: Caps = { unicode: true, color: true, tty: true };

describe('versionString — engine 버전 표시', () => {
  it('엔진이 설치 안 됐으면 템플릿 미설치 경고를 보여준다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(null);
    const s = versionString(NO_COLOR);
    expect(s).toContain(`awl v${pkgVersion}`);
    expect(s).toContain('Engine Template: (설치되지 않음)');
    expect(s).toContain('[!]');
    expect(s).toContain('awl init');
  });

  it('엔진 버전이 같으면 CLI와 템플릿을 위계로 보여준다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(pkgVersion);
    const s = versionString(NO_COLOR);
    expect(s).toContain(`awl v${pkgVersion}`);
    expect(s).toContain(`Engine Template: v${pkgVersion}`);
    // 유니코드 미지원이면 트리 글리프도 ASCII 로 degrade 한다(예전엔 └── 가 그대로 새어나왔다).
    expect(s).toContain('`--');
    expect(s).not.toContain('└──');
  });

  it('엔진 버전이 다르면 경고와 awl update 안내를 보여준다(불일치는 엔진 갱신이지 프로젝트 재설정이 아님)', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString(NO_COLOR);
    expect(s).toContain('Engine Template: v0.0.1');
    expect(s).toContain('[!]');
    expect(s).toContain('awl update'); // version-check 힌트(binary-vs-engine)와 일치
    expect(s).not.toContain('awl init'); // 불일치 브랜치는 더 이상 awl init 을 지시하지 않는다
  });

  it('색 미지원이면 ANSI 코드 없이 마커만 나온다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString(NO_COLOR);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 부재 확인용
    expect(/\x1b\[/.test(s)).toBe(false);
  });

  it('색 지원이면 ANSI 코드가 포함된다', () => {
    process.env.AWL_HOME = tmpHomeWithEngine('0.0.1');
    const s = versionString(COLOR);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI 이스케이프 존재 확인용
    expect(/\x1b\[/.test(s)).toBe(true);
  });

  it('인자를 안 주면 현재 프로세스 능력을 기본값으로 쓴다(크래시 없음)', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(null);
    expect(() => versionString()).not.toThrow();
  });
});

describe('versionString — npm 업데이트 안내 (AC-03, 로컬 캐시만 동기 읽기·네트워크 없음)', () => {
  it('캐시에 새 버전이 있으면 안내 라인을 추가로 보여준다', () => {
    const home = tmpHomeWithEngine(pkgVersion);
    writeNpmCache(home, '999.0.0');
    process.env.AWL_HOME = home;
    const s = versionString(NO_COLOR);
    expect(s).toContain('새 버전 v999.0.0');
    expect(s).toContain('npm i -g agent-work-loop@latest');
  });

  it('캐시의 최신 버전이 현재 버전과 같으면 안내 라인이 없다', () => {
    const home = tmpHomeWithEngine(pkgVersion);
    writeNpmCache(home, pkgVersion);
    process.env.AWL_HOME = home;
    const s = versionString(NO_COLOR);
    expect(s).not.toContain('새 버전');
    expect(s).not.toContain('npm i -g');
  });

  it('캐시 파일이 없으면(조회 실패/미조회) 안내 라인이 없다 — 회귀 없음(AC-05)', () => {
    process.env.AWL_HOME = tmpHomeWithEngine(pkgVersion);
    const s = versionString(NO_COLOR);
    expect(s).not.toContain('새 버전');
    expect(s).not.toContain('npm i -g');
  });

  it('기존 엔진 버전 불일치 경고와 새 버전 안내가 함께 나올 수 있다(병기)', () => {
    const home = tmpHomeWithEngine('0.0.1');
    writeNpmCache(home, '999.0.0');
    process.env.AWL_HOME = home;
    const s = versionString(NO_COLOR);
    expect(s).toContain('버전 불일치 감지'); // 기존 엔진 불일치 경고
    expect(s).toContain('새 버전 v999.0.0'); // 신규 npm 업데이트 안내
  });
});

// 빌드 산출물이 있을 때만 실제 CLI를 실행해 확인한다.
const distCli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.runIf(existsSync(distCli))('빌드된 CLI 실행', () => {
  it('--version 이 버전을 출력한다', () => {
    const out = execFileSync('node', [distCli, '--version']).toString();
    expect(out.trim()).toMatch(/^awl v\d+\.\d+\.\d+/);
  });

  it('--help 가 배너를 출력한다', () => {
    const out = execFileSync('node', [distCli, '--help']).toString();
    expect(out).toContain('AGENT WORK LOOP');
    expect(out).toContain('판단은 Claude Code나 Codex가 하고');
  });

  it('배너 제목의 버전이 package.json 버전과 동기화된다(하드코딩 금지 회귀잠금)', () => {
    expect(BANNER).toContain(`AGENT WORK LOOP v${pkgVersion}`);
  });

  it('제거된 deltas 명령은 unknown command 로 exit!=0 이다 (deltas-removal AC-01, dogfooding)', () => {
    // bare 로 친다 — deltas --json 은 커맨더가 미지 옵션(--json)에서 먼저 걸려
    // 명령 라우팅 경로를 안 탄다(G-028). unknown-operand 가드를 실제로 태우려면 인자 없이.
    const result = spawnSync('node', [distCli, 'deltas'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('deltas');
    expect(result.stderr).toContain('알 수 없는 명령');
    // 하위호환 별칭을 되살리면 gotchas 로 라우팅돼 exit 0 이 되고 이 테스트가 실패한다.
  });

  it('철회된 sync-skills 명령은 unknown command 로 exit!=0 이다 (pipeline-sync-skills-revert AC-01, dogfooding)', () => {
    // bare 로 친다 — deltas 사례(G-028)와 같은 이유로 인자 없이 라우팅 경로를 확실히 태운다.
    const result = spawnSync('node', [distCli, 'sync-skills'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('sync-skills');
    expect(result.stderr).toContain('알 수 없는 명령');
  });

  it('인자 없는 bare awl 은 여전히 help 배너를 exit 0 으로 낸다 (unknown-operand 가드 회귀잠금)', () => {
    // 가드가 bare 호출(operand 없음)까지 에러로 만들면 이 테스트가 실패한다.
    const result = spawnSync('node', [distCli], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Agent Work Loop');
  });

  it('awl help 는 도움말을 exit 0 으로 낸다 (deltas-removal AC-04, 리뷰 rev_6841 finding #1)', () => {
    // help 는 commander 내장이지만 루트 액션에 가려 operand 로 가드에 도달한다.
    // 가드가 이를 미등록으로 오판해 exit1 을 내면(회귀) 이 테스트가 실패한다.
    const result = spawnSync('node', [distCli, 'help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Agent Work Loop');
  });

  it('awl help <cmd> 는 그 명령의 도움말을 exit 0 으로 낸다 (deltas-removal AC-04)', () => {
    const result = spawnSync('node', [distCli, 'help', 'gotchas'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    // 해당 서브명령(gotchas)의 사용법이 나온다.
    expect(result.stdout).toContain('gotchas');
  });

  it('state set phase:loop 이 gate:1 기록 없이는 거부되고, 기록 후엔 통과한다 (WI-Q AC-02, program.ts 배선 확인)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-loop-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-loop-proj-'));
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    fs.writeFileSync(
      path.join(proj, '.awl', 'state.json'),
      JSON.stringify({ workitem: 'WI-Q', workitems: {} }),
    );
    const env = { ...process.env, AWL_HOME: home };

    const denied = spawnSync('node', [distCli, 'state', 'set', '--json', '{"phase":"loop"}'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('게이트 1');

    const gateRecord = spawnSync(
      'node',
      [
        distCli,
        'record',
        'gate',
        '--json',
        '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"]}',
      ],
      { cwd: proj, env, encoding: 'utf8' },
    );
    expect(gateRecord.status).toBe(0);

    const allowed = spawnSync('node', [distCli, 'state', 'set', '--json', '{"phase":"loop"}'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    });
    expect(allowed.status).toBe(0);
    expect(JSON.parse(allowed.stdout).phase).toBe('loop');
  });

  it('현재 워크아이템이 없으면 다른 워크아이템의 gate:1 기록으로도 통과하지 않는다 (WI-Q 리뷰 지적 — fail-open 방지)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-noworkitem-'));
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-gate-noworkitem-proj-'));
    fs.mkdirSync(path.join(proj, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.awl', 'config.json'),
      JSON.stringify({ project: 'p', mainLanguage: 'other', verify: {} }),
    );
    // 현재 워크아이템(workitem 필드) 없이 state.json 만 있다.
    fs.writeFileSync(path.join(proj, '.awl', 'state.json'), JSON.stringify({ workitems: {} }));
    const env = { ...process.env, AWL_HOME: home };

    // 다른(과거) 워크아이템의 gate:1 은 기록해둔다 — 이게 새어 들어가면 안 된다.
    const gateRecord = spawnSync(
      'node',
      [
        distCli,
        'record',
        'gate',
        '--json',
        '{"gate":1,"decision":"approved","presentedCriteria":["AC-01"],"workitem":"WI-OTHER"}',
      ],
      { cwd: proj, env, encoding: 'utf8' },
    );
    expect(gateRecord.status).toBe(0);

    const denied = spawnSync('node', [distCli, 'state', 'set', '--json', '{"phase":"loop"}'], {
      cwd: proj,
      env,
      encoding: 'utf8',
    });
    expect(denied.status).not.toBe(0);
    expect(denied.stderr).toContain('게이트 1');
  });

  it.each([
    ['CI=true', { CI: 'true' }],
    ['CI 없음', {}],
  ])(
    'stdin 파이프에서 init --yes 는 %s 여부와 무관하게 크래시 없이 끝난다 (WI-Y AC-05/AC-08, 회귀)',
    (_label, extraEnv) => {
      // 리뷰(rev_b9f3bb4b93ede055f5 finding #1) 지적 — 이 테스트는 raw-mode "회피"를
      // 검증하지 않는다. runInit 은 opts.yes===true 면 readline 조차 안 만들고 곧장
      // nonInteractiveInputs(순수 함수, stdin 미접근)로 직행해 selectSingle/
      // rawModeCapable 자체를 호출하지 않는다(src/commands/init.ts:1134-1143) —
      // CI 유무는 이 경로에 아무 영향이 없다. 그래서 CI 있음/없음 두 케이스를 나란히
      // 돌려 "둘 다 안전하게 끝난다"만 정직하게 확인한다. raw-mode 분기 자체의
      // true/false 커버리지는 AC-01~03(select.test.ts)과 AC-08(init.test.ts,
      // selectSingle/selectMulti 직접 단위테스트)의 몫이다.
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-init-ci-home-'));
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-init-ci-proj-'));
      const env = { ...process.env, ...extraEnv, AWL_HOME: home };

      const result = spawnSync('node', [distCli, 'init', '--yes'], {
        cwd: proj,
        env,
        encoding: 'utf8',
        input: '', // stdin 을 파이프로 연결한다(TTY 아님)
        timeout: 10_000,
      });

      expect(result.status).toBe(0);
      expect(result.signal).toBeNull();
      const configPath = path.join(proj, '.awl', 'config.json');
      expect(existsSync(configPath)).toBe(true);
    },
  );
});
