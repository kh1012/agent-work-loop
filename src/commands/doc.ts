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

const SPEC_BODY = `## Request
> (사용자가 던진 원문 그대로)

## Instruction

## Constraints

## Conditions

## Out of scope
`;

function ticketFrontmatter(opts: {
  id: string;
  spec: string;
  conditions: string[];
}): FrontmatterData {
  return {
    id: opts.id,
    spec: opts.spec,
    conditions: opts.conditions,
    dependencies: [],
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
}

export interface DocNewResult {
  path: string;
  id: string;
  title: string;
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
  const filePath = path.join(dir, filename);
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
    body = SPEC_BODY;
  } else if (type === 'ticket') {
    frontmatter = ticketFrontmatter({
      id,
      spec: opts.spec ?? '',
      conditions: opts.conditions ?? [],
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

/** 스펙 본문의 `## Conditions` 아래 `### condition-N` 블록들을 뽑는다(제목·본문 텍스트). */
export function extractConditionBlocks(body: string): { heading: string; text: string }[] {
  const lines = body.split(/\r?\n/);
  const results: { heading: string; text: string }[] = [];
  let inConditions = false;
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = (): void => {
    if (currentHeading !== null) {
      results.push({ heading: currentHeading, text: buffer.join('\n').trim() });
    }
    currentHeading = null;
    buffer = [];
  };

  for (const line of lines) {
    if (/^##\s+Conditions\s*$/.test(line)) {
      inConditions = true;
      continue;
    }
    if (inConditions && /^##\s+\S/.test(line)) {
      flush();
      inConditions = false;
      continue;
    }
    if (!inConditions) {
      continue;
    }
    const headingMatch = line.match(/^###\s+(.+)$/);
    if (headingMatch?.[1]) {
      flush();
      currentHeading = headingMatch[1].trim();
      continue;
    }
    if (currentHeading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return results;
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
      if (!isEarsForm(block.text)) {
        violations.push({
          file: filePath,
          message: `${block.heading} 이 EARS 문형(언제/만약/동안/어디서/항상)으로 시작하지 않습니다`,
        });
      }
      for (const word of BANNED_QUALITATIVE_WORDS) {
        if (includesBannedWord(block.text, word)) {
          violations.push({
            file: filePath,
            message: `${block.heading} 에 질적 표현이 있습니다: "${word}"`,
          });
        }
      }
    }

    const pathMatch = body.match(FILE_PATH_PATTERN);
    if (pathMatch) {
      violations.push({
        file: filePath,
        message: `스펙 본문에 파일 경로가 있습니다: "${pathMatch[0]}" (경로는 finding 전용입니다)`,
      });
    }
  }

  for (const term of bannedTerms) {
    if (includesBannedWord(body, term)) {
      violations.push({
        file: filePath,
        message: `용어집의 "쓰지 않음" 단어가 쓰였습니다: "${term}"`,
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
    process.stderr.write(`  ${path.relative(projectRoot, v.file)}: ${v.message}\n`);
  }
  process.stderr.write(`\n  ${signal(c, 'error')} 위반 ${violations.length}건\n`);
  process.exit(1);
}
