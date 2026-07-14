import { Command } from 'commander';
import { version } from '../package.json';

export const BANNER = `Agent Work Loop

같은 실패를 두 번 하지 않게 만드는 도구입니다.
awl 자체는 판단하지 않습니다. 파일과 상태만 관리합니다.
판단은 Claude Code 나 Codex 가 합니다.`;

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
    .version(version, '-v, --version', '버전을 출력합니다')
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

  // 사람이 치는 명령: config (현재 설정 보기 + config set 으로 검증 저장)
  const config = program.command('config').description('이 프로젝트의 설정을 봅니다');
  config.action(async () => {
    const { runConfig } = await import('./commands/config.js');
    runConfig();
  });
  config
    .command('set <key> <value>')
    .description('설정 값을 바꿉니다 (저장 전에 검증 명령을 실제로 실행해 봅니다)')
    .option('--force', '검증에 실패해도 저장합니다')
    .action(async (key: string, value: string, opts: { force?: boolean }) => {
      const { runConfigSet } = await import('./commands/config.js');
      await runConfigSet(key, value, { force: opts.force === true });
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
    .command('promote <deltaId>')
    .description('교훈을 규칙으로 승격합니다 (applies/counter 필수, 사람이 실행)')
    .option('--applies <cond>', '적용 조건 (필수)')
    .option('--counter <cond>', '반증 조건 (필수)')
    .option('--rule-scope <scope>', '로드 단계 (audit/criteria/implement/commit/review)')
    .action(
      async (deltaId: string, opts: { applies?: string; counter?: string; ruleScope?: string }) => {
        const { runRulesPromote } = await import('./commands/rules.js');
        runRulesPromote(deltaId, {
          applies: opts.applies,
          counter: opts.counter,
          scope: opts.ruleScope,
        });
      },
    );

  // 사람이 치는 명령: deltas (아직 규칙이 되지 않은 교훈)
  program
    .command('deltas')
    .description('아직 규칙이 되지 않은 교훈을 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runDeltas } = await import('./commands/deltas.js');
      runDeltas({ json: opts.json === true });
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
    .action(async (type: string, opts: { json?: string; file?: string; diff?: boolean }) => {
      const { runRecord } = await import('./commands/record.js');
      await runRecord(type, { json: opts.json, file: opts.file, diff: opts.diff === true });
    });

  // 스킬이 치는 명령(숨김): verify
  program
    .command('verify', { hidden: true })
    .description('검증 명령을 순서대로 실행합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--bail', '첫 실패에서 멈춥니다')
    .action(async (opts: { json?: boolean; bail?: boolean }) => {
      const { runVerify } = await import('./commands/verify.js');
      await runVerify({ json: opts.json === true, bail: opts.bail === true });
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
      runStateSet(opts.json);
    });

  // 스킬이 치는 명령(숨김): evolve (기록 → 교훈 → 규칙. awl 은 모으고 쓰고 셀 뿐 판단하지 않는다)
  program
    .command('evolve', { hidden: true })
    .description('기록을 모아 교훈으로, 교훈을 규칙으로 잇습니다')
    .option('--collect', '이번 워크아이템의 기록을 모아 JSON으로 출력합니다')
    .option('--record', '교훈을 deltas 에 기록합니다 (--json 으로 데이터)')
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
