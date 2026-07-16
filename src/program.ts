import { Command } from 'commander';
import { version } from '../package.json';
import { installedEngineVersion } from './core/engine.js';
import {
  type Caps,
  caps,
  gradient,
  makeColors,
  makeSymbols,
  signal,
  stringWidth,
} from './core/tty.js';

export const BANNER = `Agent Work Loop

같은 실패를 두 번 하지 않게 만드는 도구입니다.
awl 자체는 판단하지 않습니다. 파일과 상태만 관리합니다.
판단은 Claude Code 나 Codex 가 합니다.

시작하기:
  1. awl init       이 프로젝트를 설정합니다
  2. awl status     지금 어디까지 왔는지 봅니다
  3. awl doctor     설치와 환경을 점검합니다

진단 스킬: /awl-improve-loop 는 하네스의 동시성·상태 누수·게이트 우회를 점검하는
임시 피드백 도구입니다. 실제 개발 환경에서는 사용하지 말고 격리된 Mock 환경에서만 실행하세요.`;

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
  const markWidth = Math.max(...markLines.map(stringWidth));
  const rowCount = Math.max(markLines.length, copyLines.length);
  return Array.from({ length: rowCount }, (_, i) => {
    const mark = markLines[i] ?? '';
    const copy = copyLines[i] ?? '';
    return `${mark}${' '.repeat(Math.max(0, markWidth - stringWidth(mark)) + 4)}${copy}`.trimEnd();
  }).join('\n');
}

/**
 * `awl --version` 이 보여줄 문자열을 만든다. 패키지 버전뿐 아니라 설치된
 * 엔진 템플릿도 위계로 보여준다. 설치 버전이 어긋나면 경고와 갱신 방법을
 * 바로 알려줘 doctor까지 들어가지 않아도 원인을 알 수 있다.
 */
export function versionString(c: Caps = caps()): string {
  const color = makeColors(c.color);
  const s = makeSymbols(c);
  const engineVer = installedEngineVersion();
  const heading = `awl v${version}`;
  if (engineVer === null) {
    return [
      heading,
      `    ${s.lastBranch} Engine Template: ${color.dim('(설치되지 않음)')}`,
      '',
      `    ${signal(c, 'warn')} 엔진 템플릿이 없습니다.`,
      `        ${color.dim("'awl init'을 실행하여 템플릿을 설치하세요.")}`,
    ].join('\n');
  }
  const template = `    ${s.lastBranch} Engine Template: v${engineVer}`;
  if (engineVer === version) {
    return `${heading}\n${template}`;
  }
  return [
    heading,
    template,
    '',
    `    ${signal(c, 'warn')} 버전 불일치 감지!`,
    '        CLI 본체와 홈 디렉토리(~/.awl/engine)의 스킬 템플릿 버전이 다릅니다.',
    `        ${color.dim("해결하려면 'awl init'을 다시 실행하여 템플릿을 갱신하세요.")}`,
  ].join('\n');
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
    .action(async (opts: { json?: boolean }) => {
      const { runStatus } = await import('./commands/status.js');
      runStatus({ json: opts.json === true });
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
      runVersionCheck({ json: opts.json === true });
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
    .action(
      async (
        id: string,
        description: string | undefined,
        opts: { worktree?: string | boolean; skipBaseline?: boolean },
      ) => {
        const { runWorkNew } = await import('./commands/work.js');
        await runWorkNew(id, description, opts);
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
    .action(async (opts: { json?: boolean }) => {
      const { runMetrics } = await import('./commands/metrics.js');
      runMetrics({ json: opts.json === true });
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

  // 폐기 예정(0.4.0 까지 유지): deltas 는 gotchas 의 옛 이름이다.
  program
    .command('deltas', { hidden: true })
    .description('(폐기 예정 — awl gotchas 를 쓰세요) 아직 규칙이 되지 않은 함정을 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      process.stderr.write(
        '\n  경고: awl deltas 는 폐기 예정입니다(0.4.0 에서 제거). awl gotchas 를 쓰세요.\n',
      );
      const { runGotchas } = await import('./commands/gotchas.js');
      runGotchas({ json: opts.json === true });
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
    .action(
      async (opts: {
        collect?: boolean;
        record?: boolean;
        json?: string | boolean;
        workitem?: string;
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
          m.runEvolveCollect({ workitem: opts.workitem, json: true });
        } else {
          process.stderr.write('\n  --collect 또는 --record 를 지정하세요.\n');
          process.exit(1);
        }
      },
    );

  // 인자 없이 `awl`만 실행하면 도움말을 보여준다.
  program.action(() => {
    program.help();
  });

  return program;
}
