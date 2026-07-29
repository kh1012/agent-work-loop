import os from 'node:os';
import { Command } from 'commander';
import { version } from '../package.json';
import { installedEngineVersion } from './core/engine.js';
import { readCachedLatestVersion } from './core/npm-registry.js';
import { engineDir } from './core/paths.js';
import {
  type Caps,
  caps,
  gradient,
  makeColors,
  makeSymbols,
  makeTokens,
  sectionBox,
  signal,
  visibleWidth,
} from './core/tty.js';
import { computeUpdateAvailable } from './core/versions.js';

export const BANNER = `
[ AGENT WORK LOOP v${version} ]

판단은 Claude Code나 Codex가 하고,
awl은 파일과 상태만 관리합니다.`;

/**
 * 로고 옆이 아니라 그 아래에 좌측 정렬 카드로 따로 배치하는 시작 안내
 * (cli-banner-getting-started-card, cli-skills-help-card). 2-1/2-2는 둘 중 하나만
 * 실행해도 바로 시작되는 대등한 진입점이라 번호를 나란히 묶었다 — awl status/doctor는
 * 점검용이라 "시작하기"에서 빼고 --help 명령 목록에서 찾게 둔다.
 */
const GETTING_STARTED: { label: string; cmd: string; desc: string }[] = [
  { label: '1', cmd: 'awl init', desc: '작업 중인 프로젝트에 awl 환경을 설정합니다.' },
  {
    label: '2',
    cmd: 'awl run "<목표>" [--strict|--auto] [--review]',
    desc: '요청을 엽니다. 모드를 여기서 고릅니다(기본 semi-auto).',
  },
  {
    label: '3',
    cmd: '/awl | $awl <목표>',
    desc: '스펙→티켓→게이트 4개를 한 세션이 관통합니다. awl next 가 다음 할 일을 냅니다.',
  },
];

/** 표시폭(한글은 2칸) 기준 오른쪽 패딩. String.padEnd 는 UTF-16 코드유닛 수로만
 * 재서 한글이 섞이면 정렬이 어긋난다(cli-help-examples-card 에서 실측). */
function padVisible(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleWidth(s)));
}

function renderGettingStartedCard(c: Caps): string {
  const t = makeTokens(c);
  const prefixWidth = Math.max(...GETTING_STARTED.map((g) => `${g.label}.`.length));
  const cmdWidth = Math.max(...GETTING_STARTED.map((g) => visibleWidth(g.cmd)));
  const lines = GETTING_STARTED.map(
    (g) =>
      `${`${g.label}.`.padEnd(prefixWidth)} ${t.accent(padVisible(g.cmd, cmdWidth))}  ${g.desc}`,
  );
  lines.push(t.muted('*2 를 건너뛰고 3 부터 해도 됩니다 — 스킬이 없는 요청은 스스로 엽니다.'));
  lines.push(t.muted('*레거시(/awl-loop)는 사용자가 명시할 때만 발동합니다.'));
  return sectionBox('시작하기', lines, c);
}

/**
 * 명령 목록의 [options]/<criterion>/<range> 자리에 실제로 뭐가 들어가는지 보여주는
 * 예시 카드. 사람용 명령 전부를 다룬다(commit/review/status 4줄에서 전체 명령으로
 * 확장, cli-examples-full-coverage). 옵션 철자는 program.ts 등록값과 정확히
 * 맞췄고, docs/presentation/commands.md 에 실제 실행 기록이 있는 줄(init/status/
 * commit/review/records/loop-summary 배치 등)은 그대로 재사용했다 — work new/
 * lane new/rules promote 등 일부는 실행 기록이 없어 옵션 정의로 구성했다(지어낸
 * 플래그는 아니지만 과거 실행 로그로 검증되진 않았다는 뜻).
 */
function renderExamplesCard(c: Caps): string {
  const t = makeTokens(c);
  const groups: { label: string; examples: { cmd: string; note: string }[] }[] = [
    {
      label: '시작·점검',
      examples: [
        { cmd: 'awl init --yes', note: '감지된 값으로 자동 설정' },
        { cmd: 'awl status --pipeline', note: '[options] 자리엔 --json/--pipeline 같은 플래그' },
        { cmd: 'awl doctor --json', note: '설치·환경 점검 결과를 JSON으로' },
        { cmd: 'awl version-check --json', note: '설치 버전과 npm 최신 버전 비교' },
      ],
    },
    {
      label: '완료조건 게이트',
      examples: [
        { cmd: 'awl commit condition-1 --start', note: '구현 시작 시 베이스라인부터 잡는다' },
        {
          cmd: 'awl commit condition-1 -m "완료 조건 설명"',
          note: '<criterion> 자리엔 완료조건 ID(condition-1)',
        },
        { cmd: 'awl review condition-1..condition-3', note: '<range> 자리엔 완료조건 범위' },
      ],
    },
    {
      label: '워크아이템·레인',
      examples: [
        {
          cmd: 'awl work new WI-01 "여백 시스템 추가" --worktree',
          note: '격리 워크트리로 새 워크아이템 시작',
        },
        { cmd: 'awl work list --json', note: '현재+보관된 워크아이템 전부' },
        { cmd: 'awl work done WI-01', note: '완료 처리 + 상태 스냅샷 회수' },
        { cmd: 'awl lane new my-lane', note: '격리 레인(worktree+전용 home) 생성' },
        { cmd: 'awl lane ls --json', note: '레인 목록' },
        { cmd: 'awl lane rm my-lane', note: '미머지 커밋 있으면 --force 없이 거부' },
      ],
    },
    {
      label: '기록·규칙·교훈',
      examples: [
        {
          cmd: 'awl records --type narrative --workitem WI-01 --json',
          note: '기록 종류·워크아이템으로 필터',
        },
        { cmd: 'awl gotchas --json', note: '아직 규칙 안 된 교훈 목록' },
        {
          cmd: 'awl rules promote G-001 --applies "..." --counter "..."',
          note: '반복되는 교훈을 규칙으로 승격',
        },
        {
          cmd: 'awl loop-summary --workitems WI-01,WI-02',
          note: '여러 워크아이템 배치 요약',
        },
      ],
    },
    {
      label: '설정·관리',
      examples: [
        { cmd: 'awl config set verify.lint.cmd "biome check ."', note: '검증 명령어 직접 지정' },
        { cmd: 'awl update --all', note: '등록된 모든 프로젝트 스킬 동기화' },
        { cmd: 'awl remove --project', note: '로컬만 스캔(드라이런 기본, --yes 로 실행)' },
      ],
    },
    {
      label: '그 외 조회',
      examples: [
        { cmd: 'awl brief --today', note: '오늘 하루 요약' },
        { cmd: 'awl metrics --compare', note: '세대 간 비교' },
        { cmd: 'awl feedback-log --severity high', note: 'awl 자체에 대한 피드백, 심각도 필터' },
        { cmd: 'awl changelog --workitem WI-01', note: '그 워크아이템의 변경 이력' },
      ],
    },
  ];

  const lines: string[] = [];
  groups.forEach((group, i) => {
    if (i > 0) {
      lines.push('');
    }
    lines.push(t.muted(group.label));
    const cmdWidth = Math.max(...group.examples.map((e) => visibleWidth(e.cmd)));
    for (const e of group.examples) {
      lines.push(`  ${t.accent(padVisible(e.cmd, cmdWidth))}  ${t.muted(`# ${e.note}`)}`);
    }
  });
  return sectionBox('예시', lines, c);
}

/**
 * awl --skills — awl/awl-loop 스킬을 부연설명한다(cli-skills-help-card).
 * --examples와 달리 명령 예시가 아니라 개념(진입점·레인·격리 범위)이 중심이다 —
 * 이 스킬들은 awl 혼자가 아니라 Claude Code나 Codex 안에서 실행해야 의미가 있다.
 * 내용은 engine/skills/{claude,codex}/의 loop/pipeline 역할 계약을 요약한 것 — 그 문서가
 * 바뀌면 여기도 같이 바뀌어야 한다(단일 출처 아님, 사람이 손으로 맞춰야 함).
 */
export function renderSkillsCard(c: Caps): string {
  const t = makeTokens(c);
  const lines: string[] = [
    t.muted('Claude Code 또는 Codex 안에서 실행하세요 — awl 혼자서는 판단하지 않습니다.'),
    '',
    t.muted('Claude: /awl <목표>  |  Codex: $awl <목표>   — 정식 진입점(ADK 0.8.0)'),
    '  스펙(docs/specs/)에서 티켓을 도출하고 게이트 4개로 진행합니다. 지시는 CLI가',
    '  만들어서(awl next) 스킬은 그 출력을 따르기만 하는 얇은 구조입니다.',
    '  모드는 awl run 의 --strict/--auto 로 고르고 state.json 의 loopMode 에 남습니다',
    '  (기본 semi-auto). --review 는 교차 검증을 켜는 별개 축입니다.',
    '  전체 흐름은 awl stages, 다음 할 일은 awl next 로 봅니다.',
    '',
    t.muted('Claude: /awl-loop <목표>  |  Codex: $awl-loop <목표>   — 레거시'),
    '  완료조건 단위의 2게이트 흐름입니다. 사용자가 명시할 때만 발동합니다.',
    '  이미 이 방식으로 돌던 작업을 이어갈 때만 쓰세요 — 게이트 번호의 뜻이 다릅니다',
    '  (여기 게이트 2 = 워크아이템 완료 / ADK 게이트 2 = 티켓 착수).',
    '',
    t.muted('레인(lane) — 요청 여럿을 나란히'),
    '  awl run --lanes "A" "B" "C" 로 레인을 열면 .awl-worktrees/<이름> 격리 워크트리가',
    '  레인마다 하나씩 생깁니다. 그 다음은 사람이 터미널을 레인 수만큼 열어 각각 /awl 을',
    '  돕니다 — awl 은 세션을 대신 띄우지 않습니다(판단도 스폰도 안 하는 것이 원칙입니다).',
    '  한 세션이 한 레인을 스펙부터 검증까지 혼자 끝냅니다. 현황은 awl lanes 로 봅니다.',
    '',
    t.muted('격리하는 것과 공유하는 것'),
    '  격리: 워크트리 · state.json · 포트 오프셋',
    '  공유: config.json · profile.json · 기록 · 교훈 (읽기는 전부, 쓰기만 나눕니다)',
  ];
  return sectionBox('스킬', lines, c);
}

/**
 * awl --help 맨 아래에 붙는 짧은 요약 + LLM 병용 경고(cli-skills-help-card). renderSkillsCard의
 * 축약판이다 — 상세(레인·파이프라인 구조·<mode> 게이트 밀도)는 중복해 옮기지 않고
 * awl --skills 로 유도한다(같은 내용을 두 곳에 다른 말로 적으면 나중에 어긋난다).
 */
function renderSkillsHelpFooter(c: Caps): string {
  const t = makeTokens(c);
  const color = makeColors(c.color);
  const lines: string[] = [
    t.muted('Claude Code 또는 Codex 안에서 실행하세요 — awl 혼자서는 판단하지 않습니다.'),
    '',
    `  ${t.accent('Claude /awl <목표>  |  Codex $awl <목표>')}`,
    '    정식 진입점 — 스펙에서 티켓을 도출하고 게이트 4개로 갑니다.',
    '    지시는 awl next 가 만들고 스킬은 따르기만 합니다(awl stages 로 전체 흐름).',
    `  ${t.accent('/awl-loop')}  ${color.dim('(레거시)')}`,
    '    사용자가 명시할 때만 발동합니다. 이미 그 방식으로 돌던 작업에만 쓰세요.',
    '',
    color.dim('레인·격리 범위·모드(strict/semi-auto/auto)는 awl --skills 로 봅니다.'),
  ];
  return sectionBox('skills 부연설명', lines, c);
}

const DENSE_AWL = `
 █████╗ ██╗    ██╗██╗
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
  const header = Array.from({ length: rowCount }, (_, i) => {
    const mark = markLines[i] ?? '';
    const copy = copyLines[i] ?? '';
    return `${mark}${' '.repeat(Math.max(0, markWidth - visibleWidth(mark)) + 4)}${copy}`.trimEnd();
  }).join('\n');
  // 시작 안내는 로고 옆이 아니라 그 아래에, 한 칸 띄우고 좌측 정렬 카드로 배치한다.
  // 명령×옵션 예시는 --help 본문에 안 넣고 awl --examples 로 뺐다(cli-help-examples-card)
  // — 여기서 짧게 그쪽으로 유도만 한다.
  const color = makeColors(c.color);
  return `${header}\n\n${renderGettingStartedCard(c)}\n\n  ${color.dim('예시는 awl --examples 로, 스킬 설명은 awl --skills 로 봅니다.')}`;
}

/** 홈 디렉토리 하위 경로면 '~'로 줄인다(AWL_HOME 오버라이드 시엔 실제 경로 그대로 보여준다). */
function displayHomePath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * `awl --version` 이 보여줄 문자열을 만든다. 패키지 버전뿐 아니라 설치된
 * 엔진 템플릿도 위계로 보여준다. 설치 버전이 어긋나면 경고와 갱신 방법을
 * 바로 알려줘 doctor까지 들어가지 않아도 원인을 알 수 있다.
 *
 * 각 줄에 그 버전이 무엇을 가리키는지 괄호로 덧붙인다 — CLI 본체(npm 패키지)와
 * 엔진 템플릿(engineDir, 기본 ~/.awl/engine)은 서로 다른 설치 단위라 숫자만 봐서는
 * 헷갈리기 쉽다. 경로는 하드코딩하지 않고 engineDir()을 그대로 써서, AWL_HOME으로
 * 재정의된 격리 레인(lane)에서도 실제 위치를 보여준다.
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
  const heading = `awl v${version} ${color.dim('(설치된 npm 패키지 버전 — CLI 본체)')}`;

  // 엔진은 사본이 아니라 설치된 패키지 그 자체다(설계 대조 2단계 #7,
  // adk-prototype.md:132 "사본을 두지 않는다. npm 패키지가 유일한 엔진이다").
  // 그래서 "엔진 템플릿 버전"이라는 별도 숫자도, 그것과의 불일치 경고도 없어졌다.
  const base = [
    heading,
    `    ${s.lastBranch} Engine: ${color.dim(displayHomePath(engineDir()))}`,
  ].join('\n');

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
 * loop-summary --workitems 콤마 목록을 파싱한다(순수, 테스트 가능하게 커맨더 액션에서
 * 분리 — parseExperimentOption 과 같은 패턴, pipeline-cycle-summary 리뷰 지적 #1).
 * 각 항목을 trim 하고 빈 문자열은 버린다. 미지정/빈 문자열/전부 공백이면 undefined
 * (미지정과 동일하게 취급 — runLoopSummary 가 단일모드로 폴백한다).
 */
export function parseWorkitemsOption(input: string | undefined): string[] | undefined {
  if (typeof input !== 'string' || input.trim() === '') {
    return undefined;
  }
  const ids = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * `awl record <type> --help`에 보여줄 타입별 필수 필드 표(exec-tooling-friction AC-04).
 * `src/commands/record.ts`의 `SCHEMAS`를 손으로 옮긴 것이다 — 시행착오로만 타입·필수필드를
 * 발견하던 문제(타입 4회 거부 재현)의 대응으로, `--help` 한 번으로 전체를 보여준다.
 * `SCHEMAS`를 바꾸면 이 표도 같이 고친다 — `tests/commands/record.test.ts`가 둘의 일치를
 * 확인한다(모든 RecordType 이름과 그 required 필드가 이 문자열에 나타나는지).
 */
export const RECORD_TYPES_HELP_TABLE = [
  '  audit           scope, findings',
  '  spike           question, found',
  '  criteria        items',
  '  attempt         what, result',
  '  blocked         what, why, tried, lesson',
  '  review          reviewId, criteria, findings, cheatingDetected, verifyPassedBefore',
  '  decision        question, decision, rationale',
  '  gotcha-applied  gotchaId, what',
  '  gotcha-missed   gotchaId, what, why',
  '  narrative       kind, counterfactual  (kind: gate-caught|reviewer-caught|spike-prevented|blocked-discarded|tool-failed)',
  '  gate            gate, decision, presentedCriteria',
  '  clarify         questions',
  '  awl-feedback    area, what, impact, severity',
  '  defer           severity, what, why',
  '  refactor        what, kind',
].join('\n');

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
    // --help 맨 아래에 스킬(awl/awl-loop) 부연설명 + LLM 병용 경고를 붙인다
    // (cli-skills-help-card) — beforeAll이 위에 배너를 붙이는 것과 대칭으로 after를 쓴다.
    // 이것도 루트에서만(서브커맨드 help마다 반복 안 함).
    .addHelpText('after', (ctx) =>
      ctx.command === program ? `\n${renderSkillsHelpFooter(caps())}\n` : '',
    )
    // 명령 목록의 [options]/<criterion>/<range> 가 뭘 뜻하는지 감이 안 잡히는 문제
    // (cli-help-examples-card)의 대응은 --help 본문이 아니라 별도 --examples 로 뺐다 —
    // 모든 명령×옵션 조합까지 --help 에 다 욱여넣으면 분기가 너무 많아진다(사용자 판단).
    .option('--examples', '자주 쓰는 명령 예시를 보여줍니다')
    .option('--skills', 'awl/awl-loop 스킬을 부연설명합니다')
    .showHelpAfterError();

  // 사람이 치는 명령: init (처음 설정)
  program
    .command('init')
    .description('이 프로젝트에 Agent Work Loop 를 설정합니다')
    .option('--yes', '질문 없이 자동 감지된 값으로 진행합니다 (비대화형)')
    .option(
      '--push-guard',
      '비대화형 git push를 막는 pre-push 훅을 설치합니다 (기본은 미설치, 무인 파이프라인 전용)',
    )
    .action(async (opts: { yes?: boolean; pushGuard?: boolean }) => {
      const { runInit } = await import('./commands/init.js');
      await runInit({ yes: opts.yes === true, pushGuard: opts.pushGuard === true });
    });

  // 사람이 치는 명령: status (지금 어디까지 왔는지 한눈에)
  program
    .command('status')
    .description('지금 어디까지 왔는지 한눈에 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runStatus } = await import('./commands/status.js');
      await runStatus({ json: opts.json === true });
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
    .option('--links', '스킬 링크가 실제로 열리는지까지 확인합니다 (네트워크를 씁니다)')
    .action(async (opts: { json?: boolean; links?: boolean }) => {
      const { runDoctor } = await import('./commands/doctor.js');
      await runDoctor({ json: opts.json === true, links: opts.links === true });
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

  // 사람이 치는 명령: update (설치된 엔진을 갱신, 프로젝트 로컬은 --local/--all — awl-update-local)
  program
    .command('update')
    .description(
      '설치된 엔진(~/.awl/engine)을 갱신합니다 (기본은 전역만, --local/--all 로 프로젝트까지)',
    )
    .option('-g, --global', '전역 엔진(~/.awl/engine)만 갱신합니다 (기본값)')
    .option(
      '-l, --local',
      '등록된 프로젝트 전부의 로컬 스킬을 지금 설치된 엔진에 맞춰 재동기화합니다',
    )
    .option('-a, --all', '전역과 등록된 프로젝트 로컬을 모두 갱신합니다')
    .action(async (opts: { global?: boolean; local?: boolean; all?: boolean }) => {
      const { runUpdate } = await import('./commands/update.js');
      runUpdate(opts);
    });

  const skills = program
    .command('skills')
    .description('tracked 프로젝트 스킬을 agent catalog surface에 동기화합니다');
  skills
    .command('sync')
    .description('.awl/skills.json 선언을 현재 worktree에 materialize합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runSkillsSync } = await import('./commands/skills.js');
      const report = runSkillsSync({ json: opts.json === true });
      if (!report.ok) {
        process.exitCode = 1;
      }
    });

  const port = program
    .command('port')
    .description('공유 서비스 포트를 installation-scoped lease 로 조정합니다')
    .enablePositionalOptions();
  const portLease = port
    .command('lease')
    .description('서비스 포트 lease 실행·검사 수명주기를 관리합니다')
    .enablePositionalOptions();
  portLease
    .command('run')
    .description('lease 를 원자적으로 확보한 뒤 서비스 명령을 실행합니다')
    .requiredOption('--port <number>', '서비스 포트')
    .requiredOption('--workitem <id>', 'lease 소유 워크아이템')
    .option('--url <url>', '서비스 URL ({port} 치환 가능)')
    .option('--json', '기계가 읽을 수 있는 JSON 줄을 출력합니다')
    .argument('<command...>', '-- 뒤에 실행할 서비스 명령')
    .passThroughOptions()
    .action(
      async (
        command: string[],
        opts: { port: string; workitem: string; url?: string; json?: boolean },
      ) => {
        const { runPortLeaseCommand } = await import('./commands/port-lease.js');
        await runPortLeaseCommand(command, opts);
      },
    );
  portLease
    .command('inspect')
    .description('현재 lane/branch/HEAD/workitem 과 lease/listener 소유권을 비교합니다')
    .requiredOption('--port <number>', '검사할 서비스 포트')
    .requiredOption('--workitem <id>', '요청 워크아이템')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { port: string; workitem: string; json?: boolean }) => {
      const { runPortLeaseInspectCommand } = await import('./commands/port-lease.js');
      await runPortLeaseInspectCommand(opts);
    });

  // 사람이 치는 명령: remove (awl 이 손댄 흔적을 지운다 — 기본은 드라이런, 이전 이름 uninstall)
  program
    .command('remove')
    .description('awl 이 손댄 흔적을 지웁니다 (기본은 드라이런 — --yes 없이는 삭제하지 않습니다)')
    .option('--yes', '실제로 삭제합니다 (기본은 드라이런)')
    .option('--project', '이 프로젝트 로컬만 정리합니다 (기본값)')
    .option('--global', '전역(~/.awl)만 정리합니다 — 다른 프로젝트의 학습도 함께 사라집니다')
    .option('--all', '프로젝트 로컬 + 전역을 모두 정리합니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(
      async (opts: {
        yes?: boolean;
        project?: boolean;
        global?: boolean;
        all?: boolean;
        json?: boolean;
      }) => {
        const { runRemove } = await import('./commands/remove.js');
        await runRemove({
          yes: opts.yes === true,
          project: opts.project === true,
          global: opts.global === true,
          all: opts.all === true,
          json: opts.json === true,
        });
      },
    );

  // 사람이 치는 명령: config (현재 설정 보기, TTY 면 항목을 골라 수정)
  const config = program
    .command('config')
    .description('이 프로젝트의 설정을 봅니다 (TTY 면 수정도)')
    .option('--json', 'effective 설정과 base/local source를 JSON으로 출력합니다')
    .option('--show-origin', '값별로 전역/저장소/개인 중 어디서 왔는지 보여줍니다');
  config.action(async (opts: { json?: boolean; showOrigin?: boolean }) => {
    const { runConfig } = await import('./commands/config.js');
    await runConfig({ json: opts.json === true, showOrigin: opts.showOrigin === true });
  });
  config
    .command('set [key] [value]')
    .description('설정 값을 바꿉니다 (키 생략 시 목록, cmd 는 실제로 실행해 봅니다)')
    .option('--force', '검증에 실패해도 저장합니다')
    .option('--local', 'worktree-local overlay에 project/feedback 값을 저장합니다')
    .action(
      async (
        key: string | undefined,
        value: string | undefined,
        opts: { force?: boolean; local?: boolean },
      ) => {
        const { runConfigSet } = await import('./commands/config.js');
        await runConfigSet(key, value, {
          force: opts.force === true,
          local: opts.local === true,
        });
      },
    );

  // 사람이 치는 명령: profile (이 저장소의 공유 가능한 스킬 선택을 봅니다, ADK stage 4)
  const profile = program
    .command('profile')
    .description('이 프로젝트의 프로파일(스킬 선택)을 봅니다');
  profile.action(async () => {
    const { runProfile } = await import('./commands/profile.js');
    await runProfile();
  });
  profile
    .command('install <path>')
    .description('공유 프로파일을 받습니다 (config.json은 안 건드리고, 설치 안 된 스킬만 받습니다)')
    .action(async (sourcePath: string) => {
      const { runProfileInstall } = await import('./commands/profile.js');
      await runProfileInstall(sourcePath);
    });

  // 사람이 치는 명령: work (워크아이템 여러 개를 오간다, WI-D)
  // 레거시(설계 대조 2단계 #5): ADK 는 워크아이템을 티켓으로 대체했다
  // (adk-reference.md 에 workitem 0회). 정식 경로는 awl doc new spec → awl tickets
  // derive → awl commit <ticket-id> 라 work 없이 돈다. /awl-loop 를 이어 쓰는 경우가
  // 있어 지우지 않고 도움말에서만 내린다.
  const work = program
    .command('work', { hidden: true })
    .description('[레거시] 워크아이템을 관리합니다 — ADK 는 티켓(awl tickets)을 씁니다');
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
  // 사람이 치는 명령: run (요청을 연다 — ADK 0.8.0 의 CLI 진입점)
  program
    .command('run <goals...>')
    .description(
      '요청을 엽니다 — 목표·모드를 상태에 쓰고 다음 단계를 안내합니다 (에이전트는 띄우지 않습니다)',
    )
    .option('--strict', '네 게이트에서 다 멈춥니다')
    .option('--auto', '전부 자동으로 진행합니다 (기본은 semi-auto)')
    .option('--review', '교차 검증을 켭니다 (게이트 모드와 다른 축입니다)')
    .option('--lanes', '목표마다 격리 레인을 만듭니다')
    .action(
      async (
        goals: string[],
        opts: { strict?: boolean; auto?: boolean; review?: boolean; lanes?: boolean },
      ) => {
        const { runRun } = await import('./commands/run.js');
        await runRun(goals, {
          strict: opts.strict === true,
          auto: opts.auto === true,
          review: opts.review === true,
          lanes: opts.lanes === true,
        });
      },
    );

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
  lane
    .command('sync <name>')
    .description('레인을 지우지 않고, 그 레인이 쌓은 학습(교훈·규칙)만 지금 전역에 합칩니다')
    .action(async (name: string) => {
      const { runLaneSync } = await import('./commands/lane.js');
      await runLaneSync(name);
    });

  // 설계(adk-reference.md:2244)가 쓰는 이름. awl lane ls 와 같은 것을 가리킨다.
  program
    .command('lanes')
    .description('현존 레인을 나열합니다 (awl lane ls 와 같습니다)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runLaneList } = await import('./commands/lane.js');
      await runLaneList({ json: opts.json === true });
    });

  // 사람이 치는 명령: doc (ADK 문서 — spec/ticket/decision, ADK stage 1)
  const doc = program.command('doc').description('ADK 문서(spec/ticket/decision)를 관리합니다');
  doc
    .command('new <type> <title...>')
    .description('스펙/티켓/결정 스켈레톤을 만듭니다 (type: spec, ticket, decision)')
    .option('--spec <id>', '(ticket 전용) 소속 스펙 id')
    .option(
      '--dependencies <ids>',
      '(ticket 전용) 먼저 끝나야 하는 티켓 id들, 쉼표로 구분 — 의존이 곧 구현 순서',
    )
    .option('--supersedes <id>', '(decision 전용) 대체하는 이전 결정 id')
    .option(
      '--request <text>',
      '(spec 전용) 사용자가 던진 원문 그대로 — Request 절에 인용으로 들어간다',
    )
    .action(
      async (
        type: string,
        titleParts: string[],
        opts: { spec?: string; dependencies?: string; supersedes?: string; request?: string },
      ) => {
        if (type !== 'spec' && type !== 'ticket' && type !== 'decision') {
          process.stderr.write(
            `\n  ${signal(caps(), 'error')} type 은 spec, ticket, decision 중 하나여야 합니다: ${type}\n`,
          );
          process.exit(1);
          return;
        }
        const { runDocNew } = await import('./commands/doc.js');
        await runDocNew(type, titleParts, {
          spec: opts.spec,
          dependencies: opts.dependencies
            ? opts.dependencies
                .split(',')
                .map((s) => s.trim())
                .filter((s) => s !== '')
            : undefined,
          supersedes: opts.supersedes,
          request: opts.request,
        });
      },
    );
  doc
    .command('lint [path]')
    .description(
      'EARS 문형·질적 표현·파일경로·파일명·용어집을 검사합니다 (path 생략 시 docs/ 전체)',
    )
    .action(async (targetPath: string | undefined) => {
      const { runDocLint } = await import('./commands/doc.js');
      await runDocLint(targetPath);
    });
  doc
    .command('related')
    .description('같은 domain 의 이전 스펙과 gotcha 를 보여줍니다(스펙 단계 시작 시 참고)')
    .requiredOption('--domain <domain>', '찾을 domain 값')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { domain: string; json?: boolean }) => {
      const { runDocRelated } = await import('./commands/doc.js');
      await runDocRelated(opts.domain, { json: opts.json === true });
    });

  // 사람이 치는 명령: tickets (스펙 조건 → 티켓 도출, ADK stage 2a)
  const tickets = program.command('tickets').description('스펙에서 티켓을 도출합니다');
  tickets
    .command('derive <spec-id>')
    .description(
      '스펙의 조건 하나당 티켓 파일 하나를 기계적으로 만듭니다(이미 도출된 조건은 건너뜁니다)',
    )
    .action(async (specId: string) => {
      const { runDeriveTickets } = await import('./commands/tickets.js');
      await runDeriveTickets(specId);
    });

  // 사람이 치는 명령: next (티켓의 지금 상태 + 다음 할 일 조립, ADK stage 2c, 읽기 전용)
  // ticket-id 생략 시 "지금" 티켓을 자동판정한다(WI-H1) — 얇은 오케스트레이션 스킬이
  // 인자 없이 부르는 게 기본 사용법이다(adk-prototype.md:330 "목표를 받으면 `awl next` 를 호출한다").
  program
    .command('next [ticket-id]')
    .description(
      '티켓의 조건·제약·게이트 이력·다음 할 일을 조립해 보여줍니다(읽기 전용, 생략하면 지금 티켓 자동판정)',
    )
    .action(async (ticketId: string | undefined) => {
      const { runNext } = await import('./commands/next.js');
      await runNext(ticketId);
    });

  // 사람이 치는 명령: stages (파이프라인 전체 조립, ADK stage 2, 읽기 전용)
  program
    .command('stages')
    .description('요청 층/티켓 층 파이프라인 전체를 보여줍니다(--short 는 다섯 줄만)')
    .option('--short', '다섯 단계 이름만 보여줍니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { short?: boolean; json?: boolean }) => {
      const { runStages } = await import('./commands/stages.js');
      await runStages({ short: opts.short === true, json: opts.json === true });
    });

  // 사람이 치는 명령: tokens (티켓별·단계별 토큰 사용량, ADK stage 5, 읽기 전용)
  program
    .command('tokens [ticket-id]')
    .description(
      '티켓의 기록 시간창을 세션 로그 usage 와 엮어 단계별 토큰 사용량을 보여줍니다(읽기 전용)',
    )
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--lanes', '레인별 합계와 총합을 보여줍니다(ticket-id 대신)')
    .action(async (ticketId: string | undefined, opts: { json?: boolean; lanes?: boolean }) => {
      if (opts.lanes) {
        const { runTokensByLane } = await import('./commands/tokens.js');
        await runTokensByLane({ json: opts.json === true });
        return;
      }
      if (!ticketId) {
        process.stderr.write(
          `\n  ${signal(caps(), 'error')} ticket-id 를 주거나 --lanes 를 쓰세요.\n`,
        );
        process.exit(1);
        return;
      }
      const { runTokens } = await import('./commands/tokens.js');
      await runTokens(ticketId, { json: opts.json === true });
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
  rules
    .command('hit <id>')
    .description('이 규칙이 걸렸다고 알립니다 — hits 를 1 늘립니다 (검사기/사람이 실행)')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (id: string, opts: { json?: boolean }) => {
      const { runRulesHit } = await import('./commands/rules.js');
      runRulesHit(id, { json: opts.json === true });
    });

  // 사람이 치는 명령: gotchas (아직 규칙이 되지 않은 교훈, WI-O — 예전 이름 deltas 를 개명함)
  program
    .command('gotchas')
    .description('아직 규칙이 되지 않은 함정을 봅니다')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(async (opts: { json?: boolean }) => {
      const { runGotchas } = await import('./commands/gotchas.js');
      runGotchas({ json: opts.json === true });
    });

  // 사람이 치는 명령: backlog (정리 신호, ADK stage 6). awl 은 판단하지 않는다 — 3회
  // 반복된 승격 후보를 세고 보여줄 뿐, 무엇을 승격할지는 사람이 정한다.
  program
    .command('backlog')
    .description('정리 신호를 봅니다 — 3회 반복된 승격 후보, hits 0인 규칙')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--reset', '정리를 마쳤다고 표시합니다(커서를 지금 시각으로 갱신)')
    .action(async (opts: { json?: boolean; reset?: boolean }) => {
      const { runBacklog } = await import('./commands/backlog.js');
      runBacklog({ json: opts.json === true, reset: opts.reset === true });
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
  // 배치모드(pipeline-cycle-summary): --workitems(명시 목록) 또는 --since(그 시각 이후 완료)로
  // 여러 워크아이템을 항목별+전체집계로 함께 낸다. 단일모드(--workitem)는 그대로 동작(AC-05).
  program
    .command('loop-summary')
    .description('루프/파이프라인 완료를 4렌즈(개입·품질·효율·산출)로 요약합니다')
    .option('--workitem <id>', '대상 워크아이템 (기본: 현재)')
    .option('--workitems <ids>', '배치 모드: 콤마로 구분한 워크아이템 목록')
    .option('--since <iso>', '배치 모드: 이 시각(ISO) 이후 완료된 워크아이템 전부')
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .action(
      async (opts: { workitem?: string; workitems?: string; since?: string; json?: boolean }) => {
        const { runLoopSummary } = await import('./commands/loop-summary.js');
        runLoopSummary({
          workitem: opts.workitem,
          workitems: parseWorkitemsOption(opts.workitems),
          since: opts.since,
          json: opts.json === true,
        });
      },
    );

  // 사람이 치는 명령: feedback (awl 도구 자체에 짧게 남기는 단축 쓰기, ADK stage 6)
  program
    .command('feedback <text>')
    .description('awl 도구 자체가 아팠던 점을 짧게 남깁니다 (awl-feedback 기록, source:manual)')
    .option(
      '--area <area>',
      'commit, review, gate, verify, state, init, cli, 기타 중 하나(기본: 기타)',
    )
    .option('--impact <text>', '영향(생략하면 text 를 그대로 씁니다)')
    .option('--severity <sev>', 'high/medium/low 중 하나(기본: low)')
    .action(async (text: string, opts: { area?: string; impact?: string; severity?: string }) => {
      const { runFeedback } = await import('./commands/feedback-log.js');
      await runFeedback(text, opts);
    });

  // 사람이 치는 명령: feedback-log (이미 남겨진 awl-feedback 기록을 area 별로 모아서 본다.
  // `awl config`의 feedback.*(다른 프로젝트로 실시간 라우팅하는 파이프라인 모드)와는 별개다.)
  program
    .command('feedback-log')
    .description(
      'awl 도구 자체에 남겨진 피드백 기록(awl-feedback)을 area 별로 묶어 검토합니다 (해법은 제시하지 않습니다)',
    )
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--area <area>', 'area 로 거릅니다 (commit, gate, verify 등)')
    .option('--severity <sev>', 'severity 로 거릅니다 (high/medium/low)')
    .option('--since <date>', '이 ISO 날짜 이후 수집분만 봅니다 (예: 2026-07-01)')
    .action(async (opts: { json?: boolean; area?: string; severity?: string; since?: string }) => {
      const { runFeedbackLog } = await import('./commands/feedback-log.js');
      runFeedbackLog({
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
    .option(
      '--at <ref>',
      '(--start와 함께) 베이스라인을 지금이 아니라 이 ref로 사후 지정합니다 — --start를 잊고 작업부터 한 경우의 복구용, 공유 stash 스택을 안 건드립니다',
    )
    .option('-m, --message <msg>', '커밋 메시지')
    .option('--base <ref>', '베이스 드리프트를 확인할 기준 브랜치')
    .option('--force', '보호 파일 변경 검사를 사람이 확인하고 우회합니다')
    .option('--files <paths...>', '이 파일들만 커밋 대상으로 좁힙니다(안전장치)')
    .action(
      async (
        criterion: string,
        opts: {
          start?: boolean;
          at?: string;
          message?: string;
          base?: string;
          force?: boolean;
          files?: string[];
        },
      ) => {
        const { runCommit } = await import('./commands/commit.js');
        await runCommit(criterion, {
          start: opts.start,
          at: opts.at,
          message: opts.message,
          base: opts.base,
          force: opts.force,
          files: opts.files,
        });
      },
    );

  // 사람이 치는 명령: review (리뷰어에게 넘길 자료 조립 — awl 은 리뷰하지 않는다)
  // "pack <ticket-id>" 는 4게이트 티켓 모델 전용 경로다(WI-G23) — 첫 인자가 'pack'
  // 이면 두 번째 인자를 티켓 id 로, 아니면 첫 인자를 그대로 AC-range 로 다룬다.
  // 레거시 `awl review AC-01..AC-03` 호출을 한 글자도 안 바꾸려고 별도 서브커맨드
  // 그룹 대신 이 방식을 골랐다(SKILL.md/reference.md 가 이미 이 형태를 예시로 쓴다).
  program
    .command('review <rangeOrPack> [ticketId]')
    .description(
      '리뷰어에게 넘길 자료를 조립합니다 (provenance 포함). "pack <ticket-id>" 로 4게이트 티켓 모델도 지원합니다',
    )
    .option('--json', '기계가 읽을 수 있는 JSON으로 출력합니다')
    .option('--base <ref>', 'diff 기준 (기본은 완료 조건/티켓 baseline)')
    .action(
      async (
        rangeOrPack: string,
        ticketId: string | undefined,
        opts: { json?: boolean; base?: string },
      ) => {
        if (rangeOrPack === 'pack') {
          if (!ticketId) {
            process.stderr.write(
              `\n  ${signal(caps(), 'error')} awl review pack <ticket-id> 처럼 티켓 id 를 주세요.\n`,
            );
            process.exit(1);
            return;
          }
          const { runReviewPack } = await import('./commands/review.js');
          await runReviewPack(ticketId, { json: opts.json === true, base: opts.base });
          return;
        }
        const { runReview } = await import('./commands/review.js');
        await runReview(rangeOrPack, { json: opts.json === true, base: opts.base });
      },
    );

  // 스킬이 치는 명령(숨김): record
  // 타입·필수필드 표(RECORD_TYPES_HELP_TABLE, exec-tooling-friction AC-04)는
  // src/commands/record.ts 의 SCHEMAS 를 손으로 옮긴 것이다 — SCHEMAS 를 바꾸면 이 표도
  // 같이 고친다(단위 테스트가 둘의 일치를 확인한다, tests/commands/record.test.ts).
  program
    .command('record <type>', { hidden: true })
    .description('구조화된 기록을 남깁니다')
    .option('--json <data>', '기록할 데이터 (JSON 문자열)')
    .option('--file <path>', '데이터 파일 경로 (큰 데이터용)')
    .option('--diff', 'git diff 를 캡처해 첨부합니다 (blocked)')
    .option('--workitem <id>', '이 기록만 다른 워크아이템으로 남깁니다(기본은 현재 워크아이템)')
    .addHelpText('after', `\n타입별 필수 필드:\n${RECORD_TYPES_HELP_TABLE}\n`)
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
    .option(
      '--level <level>',
      'ticket 또는 request 레벨 검증만 골라 돕니다(안 주면 레벨 무관하게 전부)',
    )
    .action(
      async (opts: {
        json?: boolean;
        bail?: boolean;
        sinceBaseline?: boolean;
        related?: boolean;
        force?: boolean;
        level?: string;
      }) => {
        if (opts.level !== undefined && opts.level !== 'ticket' && opts.level !== 'request') {
          process.stderr.write(
            `\n  ${signal(caps(), 'error')} --level 은 ticket 또는 request 여야 합니다: ${opts.level}\n`,
          );
          process.exit(1);
          return;
        }
        const { runVerify } = await import('./commands/verify.js');
        await runVerify({
          json: opts.json === true,
          bail: opts.bail === true,
          sinceBaseline: opts.sinceBaseline === true,
          related: opts.related === true,
          force: opts.force === true,
          level: opts.level,
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
    .option('--workitem <id>', '활성 워크아이템 일치 가드(불일치 시 갱신 거부)')
    .action(async (opts: { json: string; workitem?: string }) => {
      const { runStateSet } = await import('./commands/state.js');
      const { hasApprovedGate1 } = await import('./commands/record.js');
      const { resolveProjectRoot } = await import('./commands/config.js');
      runStateSet(opts.json, {
        workitem: opts.workitem,
        // phase:'loop' 로의 전이는 이 워크아이템에 "승인된" 게이트1 레코드가 있을
        // 때만 허용한다(0.6.3, 적대검증 발견). 예전엔 gate:1 레코드의 존재만 봐서
        // (decision 무관) 사람이 REJECT 한 계획도 루프에 진입할 수 있었다.
        // hasApprovedGate1 이 workitem falsy 도, 프로젝트 루트를 못 찾아도 fail-closed.
        requireGateForLoop: (workitem) => hasApprovedGate1(workitem, resolveProjectRoot()),
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
  program.action((opts: { examples?: boolean; skills?: boolean }, command: Command) => {
    if (opts.examples) {
      process.stdout.write(`${renderExamplesCard(caps())}\n`);
      return;
    }
    if (opts.skills) {
      process.stdout.write(`${renderSkillsCard(caps())}\n`);
      return;
    }
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
