import { Command } from 'commander';
import { version } from '../package.json';
import { installedEngineVersion } from './core/engine.js';
import { readCachedLatestVersion } from './core/npm-registry.js';
import {
  type Caps,
  caps,
  gradient,
  makeColors,
  makeSymbols,
  signal,
  visibleWidth,
} from './core/tty.js';
import { computeUpdateAvailable } from './core/versions.js';

export const BANNER = `Agent Work Loop

같은 실패를 두 번 하지 않게 만드는 도구입니다.
awl 자체는 판단하지 않습니다. 파일과 상태만 관리합니다.
판단은 Claude Code 나 Codex 가 합니다.

시작하기:
  1. awl init       이 프로젝트를 설정합니다
  2. awl status     지금 어디까지 왔는지 봅니다
  3. awl doctor     설치와 환경을 점검합니다`;

const DENSE_AWL = `█████╗ ██╗    ██╗██╗
██╔══██╗██║    ██║██║
███████║██║ █╗ ██║██║
██╔══██║██║███╗██║██║
██║  ██║╚███╔███╔╝███████╗
╚═╝  ╚═╝ ╚══╝╚══╝ ╚══════╝`;

const ASCII_AWL = `    _       __        __
   / \\      \\ \\      / /
  / _ \\      \\ \\ /\\ / /
 / ___ \\      \\ V  V /
/_/   \\_\\      \\_/\\_/`;

/** 첫 화면은 Gemini처럼 조밀한 워드마크를 쓰되, 유니코드가 불확실한 환경은
 * 같은 형태의 ASCII 로고로 안전하게 폴백한다. 좌측 마크와 우측 설명을 같은
 * 행에 배치해 넓은 터미널에서 정보 밀도를 높인다. */
export function renderBanner(c: Caps = caps()): string {
  const markLines = gradient((c.unicode ? DENSE_AWL : ASCII_AWL).split('\n'), c);
  const copyLines = BANNER.split('\n');
  const markWidth = Math.max(...markLines.map(visibleWidth));
  const rowCount = Math.max(markLines.length, copyLines.length);
  return Array.from({ length: rowCount }, (_, i) => {
    const mark = markLines[i] ?? '';
    const copy = copyLines[i] ?? '';
    return `${mark}${' '.repeat(Math.max(0, markWidth - visibleWidth(mark)) + 4)}${copy}`.trimEnd();
  }).join('\n');
}

/**
 * `awl --version` 이 보여줄 문자열을 만든다. 패키지 버전뿐 아니라 설치된
 * 엔진 템플릿도 위계로 보여준다. 설치 버전이 어긋나면 경고와 갱신 방법을
 * 바로 알려줘 doctor까지 들어가지 않아도 원인을 알 수 있다.
 *
 * npm 새 버전 안내(WI-npm-update-notice AC-03)는 로컬 캐시 파일만 동기로 읽는다
 * (readCachedLatestVersion — 네트워크 없음). 이 함수는 buildProgram() 에서 모든
 * `awl` 명령 실행마다 호출되므로, 여기서 네트워크를 치면 --version 과 무관한
 * 모든 명령이 함께 느려진다(AC-05 회귀 금지). 캐시 채우기는 `awl version-check`
 * 가 담당한다(AC-04).
 */
export function versionString(c: Caps = caps()): string {
  const color = makeColors(c.color);
  const s = makeSymbols(c);
  const engineVer = installedEngineVersion();
  const heading = `awl v${version}`;

  let base: string;
  if (engineVer === null) {
    base = [
      heading,
      `    ${s.lastBranch} Engine Template: ${color.dim('(설치되지 않음)')}`,
      '',
      `    ${signal(c, 'warn')} 엔진 템플릿이 없습니다.`,
      `        ${color.dim("'awl init'을 실행하여 템플릿을 설치하세요.")}`,
    ].join('\n');
  } else {
    const template = `    ${s.lastBranch} Engine Template: v${engineVer}`;
    if (engineVer === version) {
      base = `${heading}\n${template}`;
    } else {
      base = [
        heading,
        template,
        '',
        `    ${signal(c, 'warn')} 버전 불일치 감지!`,
        '        CLI 본체와 홈 디렉토리(~/.awl/engine)의 스킬 템플릿 버전이 다릅니다.',
        `        ${color.dim('해결하려면 awl update 로 엔진을 갱신하세요.')}`,
      ].join('\n');
    }
  }

  const updateAvailable = computeUpdateAvailable(version, readCachedLatestVersion());
  if (!updateAvailable) {
    return base;
  }
  return [
    base,
    '',
    `    ${signal(c, 'warn')} 새 버전 v${updateAvailable.latest} 있음`,
    `        ${color.dim(updateAvailable.hint)}`,
  ].join('\n');
}

/** work new --experiment 파싱 결과(순수, 테스트 가능하게 커맨더 액션에서 분리, experiment-harness). */
export type ExperimentParse =
  | { ok: true; value: Record<string, unknown> | undefined }
  | { ok: false; error: string };

/**
 * --experiment JSON 옵션을 파싱·검증한다(순수). 미지정/빈 문자열이면 undefined(정상),
 * 파싱 불가/객체 아님/배열이면 에러. 커맨더 액션이 이 결과로 exit/전달을 결정한다.
 */
export function parseExperimentOption(input: string | undefined): ExperimentParse {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: true, value: undefined };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return { ok: false, error: '--experiment JSON 을 파싱하지 못했습니다.' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '--experiment 은 JSON 객체여야 합니다.' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/**
 * awl 명령어 트리를 만든다.
 *
 * `--help`에는 사람이 치는 명령만 보인다. 스킬 전용 명령(verify, record,
 * state, evolve)은 나중에 `{ hidden: true }`로 추가해 help에서 숨긴다.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('awl')
    .version(versionString(), '-v, --version', '버전을 출력합니다')
    .helpOption('-h, --help', '도움말을 출력합니다')
    // 배너는 루트(awl / awl --help)에서만 보여준다. 예전엔 beforeAll 이 모든
    // 서브커맨드 help(work --help 등)에도 배너를 반복 출력했다.
    .addHelpText('beforeAll', (ctx) => (ctx.command === program ? `${renderBanner()}\n` : ''))
    .showHelpAfterError();

  // 사람이 치는 명령: init (처음 설정)
  program
    .command('init')
    .description('이 프로젝트에 Agent Work Loop 를 설정합니다')
    .option('--yes', '질문 없이 자동 감지된 값으로 진행합니다 (비대화형)')
    .action(async (opts: { yes?: boolean }) => {
      const { runInit } = await import('./commands/init.js');
      await runInit({ yes: opts.yes === true });
    });

  // 사람이 치는 명령: status (지금 어디까지 왔는지 한눈에)
  program
    .command('status')
    .description('지금 어디까지 왔는지 한눈에 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--pipeline', '.tasks 레인(plan/exec/review)의 workitem 상태를 배지로 봅니다')
    .action(async (opts: { json?: boolean; pipeline?: boolean }) => {
      const { runStatus } = await import('./commands/status.js');
      await runStatus({ json: opts.json === true, pipeline: opts.pipeline === true });
    });

  // 사람이 치는 명령: brief (KST 오늘 진행분을 스킬이 소비할 데이터로 낸다)
  program
    .command('brief')
    .description('KST 오늘(또는 --date)의 진행분을 모아 냅니다(스킬 소비용 --json)')
    .option('--today', '오늘(KST) 기준으로 모읍니다(기본)')
    .option('--date <YYYY-MM-DD>', 'KST 기준 특정 날짜로 모읍니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { today?: boolean; date?: string; json?: boolean }) => {
      const { runBrief } = await import('./commands/brief.js');
      await runBrief({ today: opts.today === true, date: opts.date, json: opts.json === true });
    });

  // 사람이 치는 명령: doctor (아무것도 설치·수리하지 않고 점검만 한다)
  program
    .command('doctor')
    .description('설치와 환경을 점검합니다 (아무것도 고치지 않습니다)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runDoctor } = await import('./commands/doctor.js');
      await runDoctor({ json: opts.json === true });
    });

  // 사람이 치는 명령: version-check (버전 네 쌍 불일치 검사 — WI-X)
  program
    .command('version-check')
    .description('버전 불일치를 검사합니다 (package/engine/프로젝트/스킬)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runVersionCheck } = await import('./commands/version-check.js');
      await runVersionCheck({ json: opts.json === true });
    });

  // 사람이 치는 명령: update (설치된 엔진을 갱신 — WI-X)
  program
    .command('update')
    .description('설치된 엔진(~/.awl/engine)을 갱신합니다')
    .action(async () => {
      const { runUpdate } = await import('./commands/update.js');
      runUpdate();
    });

  // 사람이 치는 명령: config (현재 설정 보기, TTY 면 항목을 골라 수정)
  const config = program
    .command('config')
    .description('이 프로젝트의 설정을 봅니다 (TTY 면 수정도)');
  config.action(async () => {
    const { runConfig } = await import('./commands/config.js');
    await runConfig();
  });
  config
    .command('set [key] [value]')
    .description('설정 값을 바꿉니다 (키 생략 시 목록, cmd 는 실제로 실행해 봅니다)')
    .option('--force', '검증에 실패해도 저장합니다')
    .action(
      async (key: string | undefined, value: string | undefined, opts: { force?: boolean }) => {
        const { runConfigSet } = await import('./commands/config.js');
        await runConfigSet(key, value, { force: opts.force === true });
      },
    );

  // 사람이 치는 명령: work (워크아이템 여러 개를 오간다, WI-D)
  const work = program.command('work').description('이 프로젝트의 워크아이템을 관리합니다');
  work
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runWorkList } = await import('./commands/work.js');
      runWorkList({ json: opts.json === true });
    });
  work
    .command('list')
    .description('등록된 워크아이템 목록과 진행 상황을 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runWorkList } = await import('./commands/work.js');
      runWorkList({ json: opts.json === true });
    });
  work
    .command('new <id> [description]')
    .description('새 워크아이템을 만들고 전환합니다 (현재 워크아이템은 보관됩니다)')
    .option('--worktree [branch]', '격리된 git worktree 를 만들어 그 안에서 시작합니다')
    .option('--skip-baseline', '검증 베이스라인 캡처를 건너뜁니다 (느린 프로젝트용)')
    .option(
      '--isolated',
      'records(~/.awl)를 이 워크아이템 전용 AWL_HOME 으로 격리합니다 (병렬 세션용)',
    )
    .option('--experiment <json>', '실험 케이스 메타 JSON (예: {"model":"lite","mode":"loop"})')
    .action(
      async (
        id: string,
        description: string | undefined,
        opts: {
          worktree?: string | boolean;
          skipBaseline?: boolean;
          isolated?: boolean;
          experiment?: string;
        },
      ) => {
        const { runWorkNew } = await import('./commands/work.js');
        const parsedExp = parseExperimentOption(opts.experiment);
        if (!parsedExp.ok) {
          process.stderr.write(`\n  ${signal(caps(), 'error')} ${parsedExp.error}\n`);
          process.exit(1);
        }
        await runWorkNew(id, description, { ...opts, experiment: parsedExp.value });
      },
    );
  work
    .command('switch <id>')
    .description('다른 워크아이템으로 전환합니다 (현재 워크아이템은 보관됩니다)')
    .action(async (id: string) => {
      const { runWorkSwitch } = await import('./commands/work.js');
      await runWorkSwitch(id);
    });
  work
    .command('abandon <id>')
    .description('워크아이템을 중단 처리합니다 (삭제하지 않습니다, 기록은 남습니다)')
    .action(async (id: string) => {
      const { runWorkAbandon } = await import('./commands/work.js');
      runWorkAbandon(id);
    });
  work
    .command('done <id>')
    .description(
      '완료된 워크아이템을 정리합니다 (워크트리 제거 + 상태 스냅샷 회수, 기록은 남습니다)',
    )
    .option('--force', '정리되지 않은 변경이 있어도 워크트리를 제거합니다')
    .action(async (id: string, opts: { force?: boolean }) => {
      const { runWorkDone } = await import('./commands/work.js');
      await runWorkDone(id, { force: opts.force === true });
    });

  // 사람이 치는 명령: lane (격리 레인 = worktree + 전용 AWL_HOME + 스킬 + 기동 안내, P1 멀티레인)
  const lane = program
    .command('lane')
    .description('격리 레인(worktree)으로 파이프라인을 병렬 실행합니다 (레인 생성·조회·정리)');
  lane
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runLaneList } = await import('./commands/lane.js');
      await runLaneList({ json: opts.json === true });
    });
  lane
    .command('new <name> [description]')
    .description('격리 레인을 만듭니다 (worktree + 전용 AWL_HOME + 스킬 재설치 + 기동 안내)')
    .action(async (name: string, description: string | undefined) => {
      const { runLaneNew } = await import('./commands/lane.js');
      await runLaneNew(name, description);
    });
  lane
    .command('ls')
    .description('현존 레인을 이름·경로·브랜치와 함께 나열합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runLaneList } = await import('./commands/lane.js');
      await runLaneList({ json: opts.json === true });
    });
  lane
    .command('rm <name>')
    .description('레인의 워크트리를 회수하고 디렉토리를 제거합니다')
    .option('--force', '커밋되지 않은 변경이 있어도 제거합니다')
    .action(async (name: string, opts: { force?: boolean }) => {
      const { runLaneRemove } = await import('./commands/lane.js');
      await runLaneRemove(name, { force: opts.force === true });
    });

  // 사람이 치는 명령: records (기록 조회, 사람이 읽는 목록)
  program
    .command('records')
    .description('쌓인 기록을 봅니다')
    .option('--type <type>', '타입으로 거릅니다 (attempt, blocked 등)')
    .option('--workitem <id>', '워크아이템으로 거릅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { type?: string; workitem?: string; json?: boolean }) => {
      const { runRecords } = await import('./commands/record.js');
      runRecords({ type: opts.type, workitem: opts.workitem, json: opts.json === true });
    });

  // 사람이 치는 명령: rules (적용되는 규칙 보기, rules edit 으로 편집)
  // enablePositionalOptions: 하위 명령(promote 등) 앞뒤로 옵션 경계를 분명히 한다(commander 권장 관행).
  const rules = program
    .command('rules')
    .description('이 프로젝트에 적용되는 규칙을 봅니다')
    .enablePositionalOptions();
  rules
    .option('--scope <scope>', '범위로 거릅니다 (implement 등)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { scope?: string; json?: boolean }) => {
      const { runRules } = await import('./commands/rules.js');
      runRules({ scope: opts.scope, json: opts.json === true });
    });
  rules
    .command('edit')
    .description('$EDITOR 로 규칙 파일을 엽니다')
    .action(async () => {
      const { runRules } = await import('./commands/rules.js');
      runRules({ edit: true });
    });
  // --rule-scope(부모 rules 의 --scope 필터와 다른 이름): commander(v12.1.0 실증)는 부모/자식이 같은
  // 플래그 이름을 쓰면 enablePositionalOptions 를 켜도 자식 액션의 opts 에서 그 값이 통째로 빠진다
  // (부모 --scope 와 이름이 겹쳐 조용히 유실됨 — 실측 확인, docs/decisions.md 참조). 그래서 새로 추가하는
  // 이 플래그만 이름을 달리한다. rules.ts 의 내부 필드명(scope)·frontmatter(scope:)는 그대로 둔다.
  rules
    .command('promote <gotchaId>')
    .description('교훈을 규칙으로 승격합니다 (applies/counter 필수, 사람이 실행)')
    .option('--applies <cond>', '적용 조건 (필수)')
    .option('--counter <cond>', '반증 조건 (필수)')
    .option('--rule-scope <scope>', '로드 단계 (audit/criteria/implement/commit/review)')
    .action(
      async (
        gotchaId: string,
        opts: { applies?: string; counter?: string; ruleScope?: string },
      ) => {
        const { runRulesPromote } = await import('./commands/rules.js');
        runRulesPromote(gotchaId, {
          applies: opts.applies,
          counter: opts.counter,
          scope: opts.ruleScope,
        });
      },
    );

  // 사람이 치는 명령: gotchas (아직 규칙이 되지 않은 교훈, WI-O — 예전 이름 deltas 를 개명함)
  program
    .command('gotchas')
    .description('아직 규칙이 되지 않은 함정을 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runGotchas } = await import('./commands/gotchas.js');
      runGotchas({ json: opts.json === true });
    });

  // 사람이 치는 명령: metrics (세대별 프록시 지표 추세, WI-P)
  program
    .command('metrics')
    .description('워크아이템(세대)별 프록시 지표 추세를 봅니다 (토큰 직접 측정 아님)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--compare', '실험 케이스(experiment model/mode/taskType)별로 지표를 비교합니다')
    .action(async (opts: { json?: boolean; compare?: boolean }) => {
      const { runMetrics } = await import('./commands/metrics.js');
      runMetrics({ json: opts.json === true, compare: opts.compare === true });
    });

  // 사람/스킬이 치는 명령: loop-summary (한 루프 완료를 4렌즈로 요약, loop-completion-stats)
  program
    .command('loop-summary')
    .description('루프/파이프라인 완료를 4렌즈(개입·품질·효율·산출)로 요약합니다')
    .option('--workitem <id>', '대상 워크아이템 (기본: 현재)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { workitem?: string; json?: boolean }) => {
      const { runLoopSummary } = await import('./commands/loop-summary.js');
      runLoopSummary({ workitem: opts.workitem, json: opts.json === true });
    });

  // 사람이 치는 명령: feedback (awl 도구 자체 피드백을 area 별로 모아서 본다)
  program
    .command('feedback')
    .description('awl 도구 자체 피드백을 area 별로 묶어 봅니다 (해법은 제시하지 않습니다)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--area <area>', 'area 로 거릅니다 (commit, gate, verify 등)')
    .option('--severity <sev>', 'severity 로 거릅니다 (high/medium/low)')
    .option('--since <date>', '이 ISO 날짜 이후 수집분만 봅니다 (예: 2026-07-01)')
    .action(async (opts: { json?: boolean; area?: string; severity?: string; since?: string }) => {
      const { runFeedback } = await import('./commands/feedback.js');
      runFeedback({
        json: opts.json === true,
        area: opts.area,
        severity: opts.severity,
        since: opts.since,
      });
    });

  program
    .command('changelog')
    .description('Gate 2 승인 뒤 CHANGELOG.md에 옮길 초안을 만듭니다 (파일은 쓰지 않음)')
    .option('--workitem <id>', '대상 워크아이템 (기본: 현재)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { workitem?: string; json?: boolean }) => {
      const { runChangelogDraft } = await import('./commands/changelog.js');
      runChangelogDraft({ workitem: opts.workitem, json: opts.json === true });
    });

  // 사람이 치는 명령: commit (격리 커밋 — 남의 미커밋 변경을 잃지 않는다)
  program
    .command('commit <criterion>')
    .description('완료 조건 작업을 격리 커밋합니다 (내 변경만)')
    .option('--start', '베이스라인을 잡습니다 (작업 시작 시)')
    .option('-m, --message <msg>', '커밋 메시지')
    .option('--base <ref>', '베이스 드리프트를 확인할 기준 브랜치')
    .option('--force', '보호 파일 변경 검사를 사람이 확인하고 우회합니다')
    .action(
      async (
        criterion: string,
        opts: { start?: boolean; message?: string; base?: string; force?: boolean },
      ) => {
        const { runCommit } = await import('./commands/commit.js');
        await runCommit(criterion, {
          start: opts.start,
          message: opts.message,
          base: opts.base,
          force: opts.force,
        });
      },
    );

  // 사람이 치는 명령: review (리뷰어에게 넘길 자료 조립 — awl 은 리뷰하지 않는다)
  program
    .command('review <range>')
    .description('리뷰어에게 넘길 자료를 조립합니다 (provenance 포함)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--base <ref>', 'diff 기준 (기본은 완료 조건 baseline)')
    .action(async (range: string, opts: { json?: boolean; base?: string }) => {
      const { runReview } = await import('./commands/review.js');
      await runReview(range, { json: opts.json === true, base: opts.base });
    });

  // 스킬이 치는 명령(숨김): record
  program
    .command('record <type>', { hidden: true })
    .description('구조화된 기록을 남깁니다')
    .option('--json <data>', '기록할 데이터 (JSON 문자열)')
    .option('--file <path>', '데이터 파일 경로 (큰 데이터용)')
    .option('--diff', 'git diff 를 캡처해 첨부합니다 (blocked)')
    .option('--workitem <id>', '이 기록만 다른 워크아이템으로 남깁니다(기본은 현재 워크아이템)')
    .action(
      async (
        type: string,
        opts: { json?: string; file?: string; diff?: boolean; workitem?: string },
      ) => {
        const { runRecord } = await import('./commands/record.js');
        await runRecord(type, {
          json: opts.json,
          file: opts.file,
          diff: opts.diff === true,
          workitem: opts.workitem,
        });
      },
    );

  // 스킬이 치는 명령(숨김): verify
  program
    .command('verify', { hidden: true })
    .description('검증 명령을 순서대로 실행합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--bail', '첫 실패에서 멈춥니다')
    .option('--force', '보호 파일 변경 검사를 사람이 확인하고 우회합니다')
    .option('--since-baseline', '베이스라인 대비 신규 실패만 회귀로 판정합니다')
    .option(
      '--related',
      '변경된 파일에 관련된 테스트만 실행합니다(relatedCmd 필요, 없으면 전체 테스트로 폴백)',
    )
    .action(
      async (opts: {
        json?: boolean;
        bail?: boolean;
        sinceBaseline?: boolean;
        related?: boolean;
        force?: boolean;
      }) => {
        const { runVerify } = await import('./commands/verify.js');
        await runVerify({
          json: opts.json === true,
          bail: opts.bail === true,
          sinceBaseline: opts.sinceBaseline === true,
          related: opts.related === true,
          force: opts.force === true,
        });
      },
    );

  // 스킬이 치는 명령(숨김): hold-recheck (pipeline-hold-recheck)
  program
    .command('hold-recheck', { hidden: true })
    .description('.tasks/plan 의 의존형 hold 를 재점검해 착지+합격한 의존이면 자동 un-hold 합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runHoldRecheck } = await import('./commands/hold-recheck.js');
      await runHoldRecheck({ json: opts.json === true });
    });

  // 스킬이 치는 명령(숨김): state get / set
  const state = program.command('state', { hidden: true }).description('루프 상태를 읽고 씁니다');
  state
    .command('get')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runStateGet } = await import('./commands/state.js');
      runStateGet({ json: opts.json === true });
    });
  state
    .command('set')
    .requiredOption('--json <patch>', '부분 갱신 (JSON 문자열)')
    .action(async (opts: { json: string }) => {
      const { runStateSet } = await import('./commands/state.js');
      const { hasApprovedGate1 } = await import('./commands/record.js');
      runStateSet(opts.json, {
        // phase:'loop' 로의 전이는 이 워크아이템에 "승인된" 게이트1 레코드가 있을
        // 때만 허용한다(0.6.3, 적대검증 발견). 예전엔 gate:1 레코드의 존재만 봐서
        // (decision 무관) 사람이 REJECT 한 계획도 루프에 진입할 수 있었다.
        // hasApprovedGate1 이 workitem falsy 도 fail-closed 로 처리한다.
        requireGateForLoop: (workitem) => hasApprovedGate1(workitem),
      });
    });

  // 스킬이 치는 명령(숨김): evolve (기록 → 교훈 → 규칙. awl 은 모으고 쓰고 셀 뿐 판단하지 않는다)
  program
    .command('evolve', { hidden: true })
    .description('기록을 모아 교훈으로, 교훈을 규칙으로 잇습니다')
    .option('--collect', '이번 워크아이템의 기록을 모아 JSON으로 출력합니다')
    .option('--record', '교훈을 gotchas 에 기록합니다 (--json 으로 데이터)')
    .option('--json [data]', 'collect: 출력 플래그 / record: 교훈 데이터(JSON 문자열)')
    .option('--workitem <wi>', '워크아이템으로 거릅니다 (--collect)')
    .option('--from <YYYY-MM>', '기간 시작 월로 읽기를 좁힙니다 (--collect, 없으면 전량)')
    .option('--to <YYYY-MM>', '기간 끝 월 (--collect)')
    .action(
      async (opts: {
        collect?: boolean;
        record?: boolean;
        json?: string | boolean;
        workitem?: string;
        from?: string;
        to?: string;
      }) => {
        const m = await import('./commands/evolve.js');
        if (opts.collect && opts.record) {
          process.stderr.write('\n  --collect 와 --record 는 동시에 쓸 수 없습니다.\n');
          process.exit(1);
        } else if (opts.record) {
          if (typeof opts.json !== 'string' || opts.json.trim() === '') {
            process.stderr.write("\n  --record 는 --json '<교훈>' 이 필요합니다.\n");
            process.exit(1);
          }
          m.runEvolveRecord(opts.json);
        } else if (opts.collect) {
          m.runEvolveCollect({ workitem: opts.workitem, json: true, from: opts.from, to: opts.to });
        } else {
          process.stderr.write('\n  --collect 또는 --record 를 지정하세요.\n');
          process.exit(1);
        }
      },
    );

  // 스킬이 치는 명령(숨김): defer-summary (보류 큐 최종 요약)
  program
    .command('defer-summary', { hidden: true })
    .description('보류한 중요 항목(사람 최종 확인 항목)을 최종 요약합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--workitem <wi>', '워크아이템 지정(없으면 현재)')
    .action(async (opts: { json?: boolean; workitem?: string }) => {
      const m = await import('./commands/record.js');
      m.runDeferSummary({ json: opts.json === true, workitem: opts.workitem });
    });

  // 인자 없이 `awl`만 실행하면 도움말을 보여준다. 등록되지 않은 명령(operand)이
  // 남으면 삼켜서 help 로 넘기지 않고 명확히 에러낸다 — 커맨더 루트 액션은 미등록
  // 명령을 operand 로 받아 조용히 이 액션을 태우므로, 잔여 operand 를 직접 걸러야 한다.
  // 단, commander 내장 help 명령(awl help [cmd])도 루트 액션에 가려 여기로 오므로
  // 미등록으로 오판하지 않고 되살린다.
  program.action((_opts: unknown, command: Command) => {
    const [first, second] = command.args;
    if (first === undefined) {
      program.help(); // bare awl → 전체 도움말
      return;
    }
    if (first === 'help') {
      const target =
        second !== undefined ? program.commands.find((c) => c.name() === second) : undefined;
      (target ?? program).help(); // awl help [cmd] → 해당(또는 전체) 도움말
      return;
    }
    program.error(`알 수 없는 명령입니다: '${first}'. awl --help 로 명령 목록을 보세요.`, {
      exitCode: 1,
      code: 'awl.unknownCommand',
    });
  });

  return program;
}
