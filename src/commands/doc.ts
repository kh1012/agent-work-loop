import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type FrontmatterData,
  parseFrontmatter,
  serializeFrontmatter,
} from '../core/doc-frontmatter.js';
import { findProjectRoot } from '../core/paths.js';
import { run } from '../core/runner.js';
import { type Caps, caps, signal } from '../core/tty.js';
import { uuidv7 } from '../core/uuid.js';
import { loadConfig } from './config.js';
import { BANNED_QUALITATIVE_WORDS, includesBannedWord } from './record.js';

/**
 * `awl doc new` — ADK 문서(spec/ticket/decision) 스켈레톤 생성 (ADK stage 1).
 *
 * 판단하지 않는다. 프론트매터를 채운 파일을 만들 뿐이고, EARS 형식·용어집 준수
 * 같은 판정은 `awl doc lint`(별도 명령)가 한다.
 */

export type DocType = 'spec' | 'ticket' | 'decision';

const DOC_DIRS: Record<DocType, string> = {
  spec: 'specs',
  ticket: 'tickets',
  decision: 'decisions',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 로컬 시각 기준 YYYYMMDD-HHMMSS — 파일명 전용(사람이 디렉토리에서 순서를 눈으로 본다). */
export function localTimestampForFilename(d: Date = new Date()): string {
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}${mo}${da}-${h}${mi}${s}`;
}

/** 오프셋 포함 로컬 ISO — 프론트매터 created/updated 전용(정확한 값). */
export function localIsoWithOffset(d: Date = new Date()): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const offH = pad2(Math.floor(abs / 60));
  const offM = pad2(abs % 60);
  const y = d.getFullYear();
  const mo = pad2(d.getMonth() + 1);
  const da = pad2(d.getDate());
  const h = pad2(d.getHours());
  const mi = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  return `${y}-${mo}-${da}T${h}:${mi}:${s}${sign}${offH}:${offM}`;
}

/**
 * 제목을 kebab-case 로 바꾼다. 한글을 포함한 유니코드 글자·숫자는 보존하고
 * 그 외(공백·구두점)는 하이픈으로 접는다 — 이 팀의 문서 제목이 대부분 한글이라
 * ASCII 로 좁히면 슬러그가 비게 된다.
 */
export function kebabCase(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** git remote origin URL을 owner/repo 형태로 정규화한다(ssh/https 모두). 실패하면 ''. */
export function normalizeGitRemoteOwnerRepo(url: string): string {
  const s = url.trim().replace(/\.git$/, '');
  let m = s.match(/^[\w.-]+@[^:/]+:(.+)$/); // git@host:owner/repo
  if (m?.[1]) {
    return m[1];
  }
  m = s.match(/^ssh:\/\/[^/]+\/(.+)$/); // ssh://git@host/owner/repo
  if (m?.[1]) {
    return m[1];
  }
  m = s.match(/^https?:\/\/[^/]+\/(.+)$/); // https://[user@]host/owner/repo
  if (m?.[1]) {
    return m[1];
  }
  return '';
}

/**
 * git remote origin 에서 organization(소유 조직/계정)을 유도한다. 실패(원격 없음·git
 * 없음 등)는 조용히 빈 문자열 — 값이 없어도 문서 생성을 막지 않는다.
 */
export async function deriveOrganizationFromGitRemote(projectRoot: string): Promise<string> {
  try {
    const result = await run({
      cmd: 'git',
      args: ['config', '--get', 'remote.origin.url'],
      cwd: projectRoot,
    });
    if (result.exitCode !== 0) {
      return '';
    }
    const ownerRepo = normalizeGitRemoteOwnerRepo(result.stdout.trim());
    return ownerRepo.split('/')[0] ?? '';
  } catch {
    return '';
  }
}

/** 이 저장소의 project 이름 — 기존 AwlConfig.project 를 그대로 재사용한다(새 필드 없음). */
function resolveProjectName(projectRoot: string): string {
  return loadConfig(projectRoot).config?.project ?? path.basename(projectRoot);
}

function specFrontmatter(opts: {
  id: string;
  organization: string;
  project: string;
  title: string;
  now: string;
}): FrontmatterData {
  return {
    id: opts.id,
    revision: '',
    organization: opts.organization,
    project: opts.project,
    title: opts.title,
    status: 'draft',
    domain: '',
    terms: [],
    verification: ['binary'],
    tickets: [],
    decisions: [],
    created: opts.now,
    updated: opts.now,
  };
}

/**
 * `--request` 로 실제 사용자 원문을 받으면 그걸 인용으로 넣는다(ADK stage 1, "Request 에
 * 사용자 원문이 인용으로 남아야 한다"). 안 주면(하위호환·ticket/decision 흐름과 공유하던
 * 옛 호출부) 예전처럼 자리표시자만 남긴다 — 이 스킬이 강제하는 게 아니라 값이 있을 때만
 * 정확히 채운다. 여러 줄이면 각 줄 앞에 `>` 를 붙여 인용 블록을 유지한다.
 */
function specBody(request?: string): string {
  const quote =
    request && request.trim() !== ''
      ? request
          .trim()
          .split(/\r?\n/)
          .map((line) => `> ${line}`)
          .join('\n')
      : '> (사용자가 던진 원문 그대로)';
  return `## Request
${quote}

## Instruction

## Constraints

## Conditions

## Out of scope
`;
}

function ticketFrontmatter(opts: {
  id: string;
  spec: string;
  conditions: string[];
  dependencies: string[];
}): FrontmatterData {
  return {
    id: opts.id,
    spec: opts.spec,
    conditions: opts.conditions,
    dependencies: opts.dependencies,
    status: 'pending',
  };
}

const TICKET_BODY = `## Verification

## Clarifications

## Files
`;

function decisionFrontmatter(opts: { id: string; supersedes: string }): FrontmatterData {
  return {
    id: opts.id,
    status: 'accepted',
    supersedes: opts.supersedes || '-',
    'superseded-by': '-',
  };
}

export interface DocNewOptions {
  spec?: string;
  supersedes?: string;
  /** (ticket 전용) 이 티켓이 검증하는 조건 식별자들 — 기본은 빈 배열(수동 생성). */
  conditions?: string[];
  /** (ticket 전용) 먼저 끝나야 하는 티켓 id들 — 의존이 곧 구현 순서다. 판정은 호출자(AI) 몫, awl 은 저장만 한다. */
  dependencies?: string[];
  /** (spec 전용) 사용자가 던진 원문 그대로 — Request 절에 인용으로 들어간다. */
  request?: string;
}

export interface DocNewResult {
  path: string;
  id: string;
  title: string;
}

/** 같은 초에 같은 제목으로 또 만들어도 조용히 덮어쓰지 않게, 겹치면 -2·-3… 을 붙인다. */
function uniqueFilePath(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let candidate = path.join(dir, filename);
  for (let n = 2; fs.existsSync(candidate); n += 1) {
    candidate = path.join(dir, `${base}-${n}${ext}`);
  }
  return candidate;
}

/** 실제 파일 쓰기까지 하는 순수에 가까운 빌더 — CLI 핸들러와 테스트 양쪽이 쓴다. */
export async function createDoc(
  type: DocType,
  title: string,
  projectRoot: string,
  opts: DocNewOptions = {},
  now: Date = new Date(),
): Promise<DocNewResult> {
  const id = uuidv7(now.getTime());
  const slug = kebabCase(title);
  const filename = `${localTimestampForFilename(now)}-${slug || 'untitled'}.md`;
  const dir = path.join(projectRoot, 'docs', DOC_DIRS[type]);
  const filePath = uniqueFilePath(dir, filename);
  const iso = localIsoWithOffset(now);

  let frontmatter: FrontmatterData;
  let body: string;
  if (type === 'spec') {
    const organization = await deriveOrganizationFromGitRemote(projectRoot);
    frontmatter = specFrontmatter({
      id,
      organization,
      project: resolveProjectName(projectRoot),
      title,
      now: iso,
    });
    body = specBody(opts.request);
  } else if (type === 'ticket') {
    frontmatter = ticketFrontmatter({
      id,
      spec: opts.spec ?? '',
      conditions: opts.conditions ?? [],
      dependencies: opts.dependencies ?? [],
    });
    body = TICKET_BODY;
  } else {
    frontmatter = decisionFrontmatter({ id, supersedes: opts.supersedes ?? '' });
    body = `# ${title}\n`;
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, `${serializeFrontmatter(frontmatter)}\n${body}`);

  return { path: filePath, id, title };
}

/** 본문(프론트매터 제외)의 sha256 — revision 계산에 쓴다(저장 시점 값, 생성 시점은 빈 문자열). */
export function bodySha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export async function runDocNew(
  type: DocType,
  titleParts: string[],
  opts: DocNewOptions,
): Promise<void> {
  const c: Caps = caps();
  const title = titleParts.join(' ').trim();
  if (title === '') {
    process.stderr.write(`\n  ${signal(c, 'error')} 제목이 비어 있습니다.\n`);
    process.exit(1);
  }

  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch (error) {
    process.stderr.write(`\n  ${signal(c, 'error')} ${String(error)}\n`);
    process.exit(1);
    return;
  }

  const result = await createDoc(type, title, projectRoot, opts);
  const relative = path.relative(projectRoot, result.path);
  process.stdout.write(`\n  ${signal(c, 'ok')} ${relative}\n      id: ${result.id}\n`);
}

// ---------------------------------------------------------------------------
// awl doc lint — 5가지 검사 (ADK stage 1)
// ---------------------------------------------------------------------------

export interface LintViolation {
  file: string;
  message: string;
  /** 1-인덱스 줄 번호(파일 전체 기준, 프론트매터 포함) — 못 구했으면 없음. */
  line?: number;
}

/** 파일명이 `YYYYMMDD-HHMMSS-kebab.md` 형식인지 — kebabCase() 가 만드는 charset(유니코드 글자·숫자)과 맞춘다. */
export function lintFilename(filename: string): boolean {
  return /^\d{8}-\d{6}-[\p{L}\p{N}]+(-[\p{L}\p{N}]+)*\.md$/u.test(filename);
}

const EARS_PREFIXES = ['언제', '만약', '동안', '어디서', '항상'];

function isEarsForm(text: string): boolean {
  const trimmed = text.trim();
  return EARS_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * 스펙 본문의 `## <sectionHeading>` 아래 `### <slug>-N` 블록들을 뽑는다(제목·본문 텍스트).
 * `line` 은 그 블록 제목(`###`)이 본문(body) 안에서 몇 번째 줄인지(1-인덱스) — lint 가
 * 파일 전체 기준 줄 번호로 바꿀 때 이 값에 프론트매터 줄 수를 더한다. Conditions 와
 * Constraints 가 이 함수를 공유한다(구조가 동형이다 — 섹션 이름만 다르다).
 */
export function extractSubBlocks(
  body: string,
  sectionHeading: string,
): { heading: string; text: string; line: number }[] {
  const lines = body.split(/\r?\n/);
  const results: { heading: string; text: string; line: number }[] = [];
  const sectionPattern = new RegExp(`^##\\s+${sectionHeading}\\s*$`);
  let inSection = false;
  let currentHeading: string | null = null;
  let currentLine = 0;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentHeading !== null) {
      results.push({ heading: currentHeading, text: buffer.join('\n').trim(), line: currentLine });
    }
    currentHeading = null;
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (sectionPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+\S/.test(line)) {
      flush();
      inSection = false;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const headingMatch = line.match(/^###\s+(.+)$/);
    if (headingMatch?.[1]) {
      flush();
      currentHeading = headingMatch[1].trim();
      currentLine = i + 1;
      continue;
    }
    if (currentHeading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return results;
}

/** `## Conditions` 아래 `### condition-N` 블록들. extractSubBlocks 의 얇은 특수화. */
export function extractConditionBlocks(
  body: string,
): { heading: string; text: string; line: number }[] {
  return extractSubBlocks(body, 'Conditions');
}

/** `## Constraints` 아래 `### constraint-N` 블록들. extractSubBlocks 의 얇은 특수화. */
export function extractConstraintBlocks(
  body: string,
): { heading: string; text: string; line: number }[] {
  return extractSubBlocks(body, 'Constraints');
}

/** body 안의 1-인덱스 줄 번호를, 프론트매터를 포함한 파일 전체 기준 줄 번호로 바꾼다. */
function toFileLine(content: string, body: string, bodyLine: number): number | undefined {
  const idx = content.indexOf(body);
  if (idx === -1) {
    return undefined;
  }
  const frontmatterLines = content.slice(0, idx).split('\n').length - 1;
  return frontmatterLines + bodyLine;
}

/** needle 이 처음 나오는 body 안의 1-인덱스 줄 번호. 못 찾으면 undefined. */
function lineOfMatch(body: string, needle: string): number | undefined {
  const idx = body.indexOf(needle);
  if (idx === -1) {
    return undefined;
  }
  return body.slice(0, idx).split('\n').length;
}

/**
 * 스펙 본문에 파일 경로처럼 보이는 토큰이 있는지 본다(경로는 finding 전용, ADK
 * stage 2 개념이라 stage 1의 스펙 본문엔 아예 없어야 한다). 완벽한 판정이 아니라
 * 휴리스틱이다 — 흔한 소스 확장자를 붙인 토큰이나 `/` 로 이어진 경로를 잡는다.
 */
const FILE_PATH_PATTERN =
  /(?:[\w.-]+\/)+[\w.-]+\.\w+|\b[\w-]+\.(?:ts|tsx|js|jsx|json|md|py|go|rs|java|rb|css|html|yml|yaml|vue|c|cpp|h|swift|kt)(?::\d+)?\b/gi;

/** `docs/CONTEXT.md` 의 `- 쓰지 않음: a, b` 줄들에서 금칙어 집합을 만든다. */
export function parseGlossaryBannedTerms(contextMd: string): Set<string> {
  const terms = new Set<string>();
  for (const line of contextMd.split(/\r?\n/)) {
    const m = line.match(/^-\s*쓰지\s*않음:\s*(.*)$/);
    if (!m?.[1]) {
      continue;
    }
    const rest = m[1].trim();
    if (rest === '' || rest === '-') {
      continue;
    }
    for (const term of rest.split(',')) {
      const t = term.trim();
      if (t) {
        terms.add(t);
      }
    }
  }
  return terms;
}

/** 문서 하나를 검사해 위반 목록을 돌려준다(빈 배열이면 통과). */
export function lintDoc(
  type: DocType,
  filePath: string,
  bannedTerms: Set<string>,
): LintViolation[] {
  const violations: LintViolation[] = [];
  const filename = path.basename(filePath);

  if (!lintFilename(filename)) {
    violations.push({
      file: filePath,
      message: `파일명이 형식(YYYYMMDD-HHMMSS-kebab.md)에 맞지 않습니다: ${filename}`,
    });
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = parseFrontmatter(content);
  const body = parsed?.body ?? content;

  if (type === 'spec') {
    for (const block of extractConditionBlocks(body)) {
      const line = toFileLine(content, body, block.line);
      if (!isEarsForm(block.text)) {
        violations.push({
          file: filePath,
          message: `${block.heading} 이 EARS 문형(언제/만약/동안/어디서/항상)으로 시작하지 않습니다`,
          line,
        });
      }
      for (const word of BANNED_QUALITATIVE_WORDS) {
        if (includesBannedWord(block.text, word)) {
          violations.push({
            file: filePath,
            message: `${block.heading} 에 질적 표현이 있습니다: "${word}"`,
            line,
          });
        }
      }
    }

    const pathMatch = body.match(FILE_PATH_PATTERN);
    if (pathMatch) {
      violations.push({
        file: filePath,
        message: `스펙 본문에 파일 경로가 있습니다: "${pathMatch[0]}" (경로는 finding 전용입니다)`,
        line: toFileLine(content, body, lineOfMatch(body, pathMatch[0]) ?? 1),
      });
    }

    // 제약(### constraint-N)마다 verification·source·hits 가 함께 있어야 한다(ADK
    // stage 1/6). hits 는 검사기/리뷰어가 나중에 세는 값이라 "0"이어도 필드 자체는
    // 있어야 한다 — 없으면 그 제약이 실제로 몇 번 걸렸는지 추적할 자리가 없다.
    for (const block of extractConstraintBlocks(body)) {
      const line = toFileLine(content, body, block.line);
      const missing = ['verification', 'source', 'hits'].filter(
        (key) => !new RegExp(`^${key}:`, 'm').test(block.text),
      );
      if (missing.length > 0) {
        violations.push({
          file: filePath,
          message: `${block.heading} 에 ${missing.join('·')} 이(가) 없습니다(제약마다 verification·source·hits 가 함께 있어야 합니다)`,
          line,
        });
      }
    }
  }

  for (const term of bannedTerms) {
    if (includesBannedWord(body, term)) {
      violations.push({
        file: filePath,
        message: `용어집의 "쓰지 않음" 단어가 쓰였습니다: "${term}"`,
        line: toFileLine(content, body, lineOfMatch(body, term) ?? 1),
      });
    }
  }

  return violations;
}

function inferDocType(filePath: string): DocType {
  const dir = path.basename(path.dirname(path.resolve(filePath)));
  if (dir === 'tickets') {
    return 'ticket';
  }
  if (dir === 'decisions') {
    return 'decision';
  }
  return 'spec';
}

/** `docs/{specs,tickets,decisions}/*.md` 전부를 나열한다. 디렉터리가 없으면 그 타입은 건너뛴다. */
export function listDocFiles(projectRoot: string): { type: DocType; path: string }[] {
  const out: { type: DocType; path: string }[] = [];
  for (const type of Object.keys(DOC_DIRS) as DocType[]) {
    const dir = path.join(projectRoot, 'docs', DOC_DIRS[type]);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue;
    }
    for (const f of entries) {
      out.push({ type, path: path.join(dir, f) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// awl doc related — domain 기반 이전 스펙·gotcha 자동 로드 (ADK stage 1, WI-G7)
// ---------------------------------------------------------------------------

export interface RelatedSpec {
  id: string;
  title: string;
  domain: string;
  status: string;
  path: string;
}

/** 같은 domain 의 이전 스펙(closed 여부 무관, draft 포함)을 프론트매터만 훑어 찾는다.
 * awl 은 관련성을 판단하지 않는다 — domain 값이 정확히 같은 것만 기계적으로 모은다. */
export function findSpecsByDomain(projectRoot: string, domain: string): RelatedSpec[] {
  const dir = path.join(projectRoot, 'docs', 'specs');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: RelatedSpec[] = [];
  for (const f of entries.sort()) {
    const filePath = path.join(dir, f);
    let parsed: ReturnType<typeof parseFrontmatter>;
    try {
      parsed = parseFrontmatter(fs.readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || parsed.data.domain !== domain) {
      continue;
    }
    out.push({
      id: String(parsed.data.id ?? ''),
      title: String(parsed.data.title ?? ''),
      domain: String(parsed.data.domain ?? ''),
      status: String(parsed.data.status ?? ''),
      path: filePath,
    });
  }
  return out;
}

/**
 * `awl doc related --domain <domain>` — 스펙 단계 시작 시 같은 domain 의 이전 스펙과
 * gotcha 를 자동으로 읽는다(ADK stage 1). awl 은 관련성을 판단하지 않는다:
 * - 스펙은 domain 필드가 정확히 같은 것만(스펙엔 이미 domain 필드가 있다).
 * - gotcha 는 domain 필드 자체가 없다(evolve.ts Gotcha 타입 — source 는 project/
 *   workitem 뿐) — domain 별로 나눌 근거가 코드에 없으므로, 도구가 억지로 관련성을
 *   추정하지 않고 현재 gotcha 전체를 그대로 낸다. 어느 게 이 domain 과 관련 있는지는
 *   읽는 쪽(에이전트)이 lesson 내용으로 판단한다 — awl 은 판단하지 않는다.
 */
export async function runDocRelated(domain: string, opts: { json?: boolean } = {}): Promise<void> {
  const c: Caps = caps();
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch (error) {
    process.stderr.write(`\n  ${signal(c, 'error')} ${String(error)}\n`);
    process.exit(1);
    return;
  }

  const specs = findSpecsByDomain(projectRoot, domain);
  const { loadGotchaList } = await import('./evolve.js');
  const gotchas = loadGotchaList();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ domain, specs, gotchas }, null, 2)}\n`);
    return;
  }

  const out: string[] = [];
  out.push(`domain: ${domain}`);
  out.push('');
  out.push(`이전 스펙 ${specs.length}건`);
  for (const s of specs) {
    out.push(`  ${s.id}  ${s.title}  (${s.status})`);
  }
  out.push('');
  out.push(`gotcha ${gotchas.length}건(domain 무관 전체 — 관련성은 직접 판단)`);
  for (const g of gotchas) {
    out.push(`  ${g.id}  ${g.lesson}`);
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

export async function runDocLint(targetPath?: string): Promise<void> {
  const c: Caps = caps();
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch (error) {
    process.stderr.write(`\n  ${signal(c, 'error')} ${String(error)}\n`);
    process.exit(1);
    return;
  }

  const contextMdPath = path.join(projectRoot, 'docs', 'CONTEXT.md');
  const bannedTerms = fs.existsSync(contextMdPath)
    ? parseGlossaryBannedTerms(fs.readFileSync(contextMdPath, 'utf8'))
    : new Set<string>();

  const files = targetPath
    ? [{ type: inferDocType(targetPath), path: path.resolve(targetPath) }]
    : listDocFiles(projectRoot);

  const violations = files.flatMap(({ type, path: p }) => lintDoc(type, p, bannedTerms));

  if (violations.length === 0) {
    process.stdout.write(`\n  ${signal(c, 'ok')} 위반 없음 (문서 ${files.length}개)\n`);
    return;
  }

  for (const v of violations) {
    const loc = v.line ? `${path.relative(projectRoot, v.file)}:${v.line}` : path.relative(projectRoot, v.file);
    process.stderr.write(`  ${loc}: ${v.message}\n`);
  }
  process.stderr.write(`\n  ${signal(c, 'error')} 위반 ${violations.length}건\n`);
  process.exit(1);
}
