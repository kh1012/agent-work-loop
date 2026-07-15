import { Command } from 'commander';
import { version } from '../package.json';
import { installedEngineVersion } from './core/engine.js';

export const BANNER = `Agent Work Loop

같은 실패를 두 번 하지 않게 만드는 도구입니다.
awl 자체는 판단하지 않습니다. 파일과 상태만 관리합니다.
판단은 Claude Code 나 Codex 가 합니다.`;

/**
 * `awl --version` 이 보여줄 문자열을 만든다. 패키지 버전뿐 아니라 설치된
 * 엔진 버전도 보여준다 — 엔진 버전이 어긋나면 사용자의 doctor 가 아니라
 * 여기서 먼저 알아챌 수 있어야 한다.
 */
export function versionString(): string {
  const engineVer = installedEngineVersion();
  if (engineVer === null) {
    return `awl ${version}`;
  }
  if (engineVer === version) {
    return `awl ${version} (engine ${engineVer})`;
  }
  return `awl ${version} (engine ${engineVer} — 버전이 다릅니다. awl init 을 다시 실행하세요)`;
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
    .addHelpText('beforeAll', `${BANNER}\n`)
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
    .description('아직 규칙이 되지 않은 교훈을 봅니다')
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

  // 폐기 예정(0.4.0 까지 유지): deltas 는 gotchas 의 옛 이름이다.
  program
    .command('deltas', { hidden: true })
    .description('(폐기 예정 — awl gotchas 를 쓰세요) 아직 규칙이 되지 않은 교훈을 봅니다')
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
    .action(
      async (criterion: string, opts: { start?: boolean; message?: string; base?: string }) => {
        const { runCommit } = await import('./commands/commit.js');
        await runCommit(criterion, { start: opts.start, message: opts.message, base: opts.base });
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
      }) => {
        const { runVerify } = await import('./commands/verify.js');
        await runVerify({
          json: opts.json === true,
          bail: opts.bail === true,
          sinceBaseline: opts.sinceBaseline === true,
          related: opts.related === true,
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
      const { readRecords } = await import('./commands/record.js');
      runStateSet(opts.json, {
        // 리뷰 지적(WI-Q AC-01~03): readRecords 는 workitem 이 falsy 면 필터를
        // 아예 건너뛴다("필터 없음" 시맨틱) — 여기서 그대로 넘기면 현재
        // 워크아이템이 없을 때 다른 워크아이템의 gate:1 로도 통과해버린다
        // (fail-open). 워크아이템이 없으면 애초에 확인할 gate 레코드가 없다는
        // 뜻이므로 명시적으로 거부한다(fail-closed) — status.ts 의 buildGateStatus
        // 가 같은 경우를 이미 엄격 비교로 안전하게 처리하는 것과 일관되게 맞춘다.
        requireGateForLoop: (workitem) =>
          typeof workitem === 'string' &&
          readRecords({ type: 'gate', workitem }).some((r) => r.gate === 1),
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
