import fs from 'node:fs';
import path from 'node:path';
import { mergeSlots } from '../core/config-merge.js';
import { type Caps, caps, makeColors, makeSymbols, sectionBox, signal } from '../core/tty.js';
import { multiProjectFooter, resolveProjectScope } from './config.js';

/**
 * .awl/profile.json — 공유 가능한 프로파일(ADK stage 4, adk-reference.md:713-963).
 *
 * config.json 이 "이 저장소의 사실"(검증 명령)을 담는 것과 대칭으로, profile.json 은
 * "각 단계를 어떤 방식으로"(스킬 선택)만 담는다. 검증 명령은 여기 없다 — 남의
 * 프로파일에 `vitest run`이라 적혀 있는데 우리는 jest 를 쓰면 그냥 틀린 값이라
 * 공유 가치가 없다(reference.md:709-711).
 */

/** 파이프라인 순서 그대로(reference.md:892-899). 자리당 하나만 — 배열로 두면 조합
 * 규칙(순차·병렬·우선순위)을 프로파일이 정해야 해서 프로파일이 프로그램이 된다. */
export const SKILL_SLOTS = [
  'spec',
  'investigation',
  'clarification',
  'spike',
  'implement',
  'review',
] as const;

export type SkillSlot = (typeof SKILL_SLOTS)[number];

export type SkillRef =
  | null
  | { type: 'external'; url: string; version?: string; name?: string; install?: string }
  | { type: 'custom'; path: string; basedOn?: string; name?: string };

export interface AwlProfile {
  name: string;
  description?: string;
  skills: Record<SkillSlot, SkillRef>;
}

export function profilePath(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'profile.json');
}

/** `.awl/profile.local.json` — untracked, 개인 스킬 선택(ADK stage 4). "만드는 방식은
 * 개인이 골라도 된다"(reference.md:1173) — 검증과 달리 경고가 아니라 정보 표시다. */
export function profileLocalPath(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'profile.local.json');
}

export interface LocalProfileOverlay {
  skills?: Partial<Record<SkillSlot, SkillRef>>;
}

export type ProfileSource = 'base' | 'local';

/** 슬롯별 출처 — local overlay 가 그 슬롯을 하나라도 건드렸으면 'local'. */
export type ProfileSources = Record<SkillSlot, ProfileSource>;

function baseProfileSources(): ProfileSources {
  const sources = {} as ProfileSources;
  for (const slot of SKILL_SLOTS) {
    sources[slot] = 'base';
  }
  return sources;
}

export function emptyProfileSkills(): Record<SkillSlot, SkillRef> {
  const skills = {} as Record<SkillSlot, SkillRef>;
  for (const slot of SKILL_SLOTS) {
    skills[slot] = null;
  }
  return skills;
}

/** 새 저장소에서 처음 만드는 빈 프로파일 — 6자리 전부 null(스킬 없이도 돌아간다,
 * reference.md:950 "비어 있어도 돌아간다"). */
export function defaultProfile(projectName: string): AwlProfile {
  return { name: projectName, skills: emptyProfileSkills() };
}

function isSkillRef(v: unknown): v is SkillRef {
  if (v === null) {
    return true;
  }
  if (typeof v !== 'object') {
    return false;
  }
  const o = v as Record<string, unknown>;
  if (o.type === 'external') {
    if (typeof o.url !== 'string' || o.url.trim() === '') {
      return false;
    }
  } else if (o.type === 'custom') {
    if (typeof o.path !== 'string' || o.path.trim() === '') {
      return false;
    }
  } else {
    return false;
  }
  if ('name' in o && o.name !== undefined && typeof o.name !== 'string') {
    return false;
  }
  if (o.type === 'external' && 'version' in o && o.version !== undefined && typeof o.version !== 'string') {
    return false;
  }
  if (o.type === 'external' && 'install' in o && o.install !== undefined && typeof o.install !== 'string') {
    return false;
  }
  if (o.type === 'custom' && 'basedOn' in o && o.basedOn !== undefined && typeof o.basedOn !== 'string') {
    return false;
  }
  return true;
}

/** profile 객체의 스키마를 검증한다(config.ts 의 validateConfig 와 같은 스타일). */
export function validateProfile(obj: unknown): string[] {
  const errors: string[] = [];
  if (typeof obj !== 'object' || obj === null) {
    errors.push('profile 이 객체가 아닙니다');
    return errors;
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name.trim() === '') {
    errors.push('name 이 없습니다 (문자열 필수)');
  }
  if ('description' in o && o.description !== undefined && typeof o.description !== 'string') {
    errors.push('description 형식 오류 (문자열)');
  }
  if (typeof o.skills !== 'object' || o.skills === null) {
    errors.push('skills 가 없습니다 (객체 필수)');
  } else {
    const skills = o.skills as Record<string, unknown>;
    for (const key of Object.keys(skills)) {
      if (!(SKILL_SLOTS as readonly string[]).includes(key)) {
        errors.push(`skills 의 알 수 없는 자리: ${key} (허용: ${SKILL_SLOTS.join(', ')})`);
        continue;
      }
      if (!isSkillRef(skills[key])) {
        errors.push(`skills.${key} 형식 오류 (null 또는 {type:'external'|'custom', ...})`);
      }
    }
  }
  return errors;
}

/** JSON 파싱 오류에 대략적인 줄 번호를 붙인다(config.ts 의 jsonErrorLocation 과 같은 패턴). */
function jsonErrorLocation(text: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /position (\d+)/.exec(msg);
  if (m?.[1]) {
    const line = text.slice(0, Number(m[1])).split('\n').length;
    return `${msg} (약 ${line}번째 줄)`;
  }
  return msg;
}

/** profile.local.json 의 스키마를 검증한다(config.ts 의 validateLocalConfigOverlay 와 같은 스타일). */
export function validateLocalProfileOverlay(obj: unknown): string[] {
  const errors: string[] = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return ['profile.local.json 이 객체가 아닙니다'];
  }
  const overlay = obj as Record<string, unknown>;
  for (const key of Object.keys(overlay)) {
    if (key !== 'skills') {
      errors.push(`profile.local.json 의 지원하지 않는 키: ${key}`);
    }
  }
  if ('skills' in overlay) {
    if (typeof overlay.skills !== 'object' || overlay.skills === null) {
      errors.push('profile.local.json skills 형식 오류 (객체 필수)');
    } else {
      const skills = overlay.skills as Record<string, unknown>;
      for (const key of Object.keys(skills)) {
        if (!(SKILL_SLOTS as readonly string[]).includes(key)) {
          errors.push(`profile.local.json skills 의 알 수 없는 자리: ${key}`);
          continue;
        }
        if (!isSkillRef(skills[key])) {
          errors.push(`profile.local.json skills.${key} 형식 오류`);
        }
      }
    }
  }
  return errors;
}

export interface ProfileResult {
  /** base+local 병합 결과(있으면). */
  profile: AwlProfile | null;
  /** local overlay 를 반영하기 전의 base(.awl/profile.json) — ensureProfile 이
   * "이미 있다"를 판단할 때 overlay 오류에 흔들리지 않도록 이걸 따로 둔다. */
  base: AwlProfile | null;
  errors: string[];
  path: string;
  overlayPath: string | null;
  sources: ProfileSources;
}

/** .awl/profile.json + .awl/profile.local.json 을 읽어 병합한다(ADK stage 4). 없으면
 * errors 에 안내만 남긴다(크래시하지 않는다). */
export function loadProfile(projectRoot: string): ProfileResult {
  const p = profilePath(projectRoot);
  const baseResult = (
    profile: AwlProfile | null,
    errors: string[],
    overlayPath: string | null = null,
    sources: ProfileSources = baseProfileSources(),
    base: AwlProfile | null = profile,
  ): ProfileResult => ({ profile, base, errors, path: p, overlayPath, sources });

  if (!fs.existsSync(p)) {
    return baseResult(null, ['profile.json 이 없습니다. awl init 을 실행하세요.']);
  }
  let text: string;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    return baseResult(null, [`profile.json 을 읽지 못했습니다: ${String(e)}`]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return baseResult(null, [`profile.json JSON 파싱 오류: ${jsonErrorLocation(text, e)}`]);
  }
  const errors = validateProfile(parsed);
  if (errors.length > 0) {
    return baseResult(null, errors);
  }
  const raw = parsed as Record<string, unknown>;
  const rawSkills = raw.skills as Record<string, unknown>;
  const skills = emptyProfileSkills();
  for (const slot of SKILL_SLOTS) {
    if (slot in rawSkills) {
      skills[slot] = rawSkills[slot] as SkillRef;
    }
  }
  const profile: AwlProfile = {
    name: raw.name as string,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    skills,
  };

  const overlayPath = profileLocalPath(projectRoot);
  if (!fs.existsSync(overlayPath)) {
    return baseResult(profile, [], overlayPath);
  }
  let overlayText: string;
  try {
    overlayText = fs.readFileSync(overlayPath, 'utf8');
  } catch (e) {
    return baseResult(null, [`profile.local.json 을 읽지 못했습니다: ${String(e)}`], overlayPath);
  }
  let overlayRaw: unknown;
  try {
    overlayRaw = JSON.parse(overlayText);
  } catch (e) {
    return baseResult(
      null,
      [`profile.local.json JSON 파싱 오류: ${jsonErrorLocation(overlayText, e)}`],
      overlayPath,
    );
  }
  const overlayErrors = validateLocalProfileOverlay(overlayRaw);
  if (overlayErrors.length > 0) {
    return baseResult(null, overlayErrors, overlayPath);
  }
  const overlay = overlayRaw as LocalProfileOverlay;
  const effective: AwlProfile = { ...profile, skills: mergeSlots(profile.skills, overlay.skills) };
  const sources = baseProfileSources();
  for (const slot of SKILL_SLOTS) {
    if (overlay.skills && slot in overlay.skills) {
      sources[slot] = 'local';
    }
  }
  return baseResult(effective, [], overlayPath, sources, profile);
}

export function writeProfile(projectRoot: string, profile: AwlProfile): string {
  const p = profilePath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(profile, null, 2)}\n`);
  return p;
}

/**
 * profile.json 이 이미 있으면 그대로 둔다(팀이 고른 스킬을 절대 안 건드린다) — 없을
 * 때만 빈 프로파일을 만든다. `awl init` 최초 실행과, 이미 config.json 은 있는데
 * profile.json 이 없는 기존 설치(단계 4 이전 저장소, 이 워크트리 자신 포함)의
 * 백필 양쪽에서 같은 함수를 쓴다 — CONTEXT.md/stages.md 의 백필 패턴과 동일.
 */
export function ensureProfile(projectRoot: string, projectName: string): AwlProfile {
  // fs.existsSync 로 base 파일 자체를 본다 — loadProfile()의 병합 결과(.profile)로
  // 판단하면, base 는 멀쩡한데 profile.local.json 이 깨졌을 때 "없다"로 오판해
  // base 를 기본값으로 덮어써 버린다(local 오류가 base 를 훼손하면 안 된다).
  if (fs.existsSync(profilePath(projectRoot))) {
    return loadProfile(projectRoot).base ?? defaultProfile(projectName);
  }
  const profile = defaultProfile(projectName);
  writeProfile(projectRoot, profile);
  return profile;
}

function skillRefLabel(ref: SkillRef): string {
  if (ref === null) {
    return '(없음)';
  }
  if (ref.type === 'external') {
    return `external: ${ref.url}${ref.version ? ` @${ref.version}` : ''}`;
  }
  return `custom: ${ref.path}${ref.basedOn ? ` (원본: ${ref.basedOn})` : ''}`;
}

function renderProfile(profile: AwlProfile, c: Caps): string {
  const color = makeColors(c.color);
  const s = makeSymbols(c);
  const out: string[] = [];
  if (profile.description) {
    out.push(color.dim(profile.description));
    out.push('');
  }
  for (const slot of SKILL_SLOTS) {
    out.push(`${s.branch} ${slot.padEnd(14, ' ')}${skillRefLabel(profile.skills[slot])}`);
  }
  out.push('');
  out.push(`${s.lastBranch} ${color.dim('직접 편집: .awl/profile.json')}`);
  return sectionBox(`${profile.name} 프로파일`, out, c);
}

/** awl profile — 현재 프로파일을 보여준다(조회 전용, config.json 처럼 대화형 편집은
 * 아직 없다 — 마켓플레이스 등록 흐름 없이 편집 UI만 먼저 만들 이유가 없다). */
export async function runProfile(): Promise<void> {
  const scope = resolveProjectScope();
  if (scope.mode === 'multi' && scope.projects) {
    const c = caps();
    const blocks = scope.projects.map((p) => {
      const color = makeColors(c.color);
      const loaded = loadProfile(p.path);
      const header = color.bold(`프로젝트: ${p.name}  (${p.path})`);
      if (!loaded.profile) {
        return `${header}\n  ${signal(c, 'error')} profile.json 에 문제가 있습니다: ${loaded.errors.join(', ')}`;
      }
      return `${header}\n${renderProfile(loaded.profile, c)}`;
    });
    process.stdout.write(`${blocks.join('\n\n')}\n`);
    process.stdout.write(`${multiProjectFooter(scope.projects, 'awl profile', c)}\n`);
    return;
  }
  if (scope.mode === 'none') {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n`,
    );
    process.exit(1);
  }
  const projectRoot = scope.projectRoot as string;
  const loaded = loadProfile(projectRoot);
  if (!loaded.profile) {
    process.stderr.write(`\n  ${signal(caps(), 'error')} profile.json 에 문제가 있습니다:\n`);
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`${renderProfile(loaded.profile, caps())}\n`);
}
