import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engineDir } from '../core/paths.js';

/**
 * 파이프라인 스킬 단일 정본화 (pipeline-skill-source-unify).
 *
 * 정본 = 엔진 `engine/skills/claude/awl-pipeline-{plan,exec,review}/SKILL.md`.
 * 글로벌 `~/.claude/skills/temp-loop-{plan,exec,review}/SKILL.md` 는 여기서 파생된다.
 * 두 소스가 갈라져 크로스-세션 동작이 달라지는 드리프트를 끝내려는 목적이다 —
 * 앞으로 엔진만 고치면 이 메커니즘으로 글로벌이 따라온다(수동 반복 정합 금지).
 *
 * 파생 규칙은 단 하나: 트리거·역할명 `awl-pipeline` → `temp-loop` 치환.
 * 구현 코어 `awl-loop` 는 두 소스에서 동일하다 — `awl-pipeline` 의 부분문자열이 아니라
 * 치환에 걸리지 않는다. lane(autolane)·mode(graded)·marker(.taken) 문단은 `awl-pipeline`
 * 토큰을 담지 않으므로 그대로 보존된다 → diff 가 트리거·역할명 줄에만 국한된다(AC-01).
 */

const CANONICAL_PREFIX = 'awl-pipeline';
const DERIVED_PREFIX = 'temp-loop';

/**
 * 엔진 파이프라인 스킬 본문을 글로벌 temp-loop 본문으로 파생한다.
 * `awl-pipeline` → `temp-loop` 리터럴 치환. `awl-loop`(구현 코어)은 안 건드린다.
 */
export function deriveTempLoopContent(canonical: string): string {
  return canonical.replaceAll(CANONICAL_PREFIX, DERIVED_PREFIX);
}

/**
 * 엔진 스킬 디렉토리명 → 파생 글로벌 스킬 디렉토리명. 파생 대상이 아니면 null.
 *
 * `awl-pipeline-<role>`(plan/exec/review)만 매핑한다. 오케스트레이터 bare
 * `awl-pipeline`(mode A)은 글로벌 대응 스킬이 없어 제외되고, 구현 코어 `awl-loop` 도
 * 접두어가 달라 제외된다 — `-` 를 포함한 접두어 검사가 그 경계를 만든다.
 */
export function derivedSkillName(engineSkillName: string): string | null {
  if (!engineSkillName.startsWith(`${CANONICAL_PREFIX}-`)) {
    return null;
  }
  return deriveTempLoopContent(engineSkillName);
}

// ---------------------------------------------------------------------------
// 재생성 메커니즘 (AC-02) — 엔진 정본에서 글로벌 temp-loop 스킬을 파생·갱신한다.
// ---------------------------------------------------------------------------

export interface SyncedSkill {
  /** 엔진 스킬 디렉토리명 (예: awl-pipeline-exec) */
  engineName: string;
  /** 파생된 글로벌 스킬 디렉토리명 (예: temp-loop-exec) */
  derivedName: string;
  /** 대상 내용이 파생 결과와 달라 갱신이 필요했나 (재실행 멱등의 신호) */
  changed: boolean;
  action: 'written' | 'unchanged' | 'would-change';
}

export interface SyncResult {
  from: string;
  to: string;
  skills: SyncedSkill[];
}

/**
 * `from`(엔진 스킬 소스)에서 `to`(글로벌 스킬 대상)로 파이프라인 스킬을 파생·갱신한다.
 *
 * - `awl-pipeline-<role>` 3개만 대상(derivedSkillName 경계 — 오케스트레이터·구현코어 제외).
 * - 대상 SKILL.md 내용이 파생 결과와 이미 같으면 쓰지 않는다 → 재실행 멱등.
 * - `dryRun` 이면 아무 파일도 쓰지 않고 무엇이 바뀔지만 보고한다.
 *
 * 실제 유저 글로벌(~/.claude/skills) 쓰기는 사람이 판단해 실행한다 — 테스트는 temp 경로로.
 */
export function syncPipelineSkills(opts: {
  from: string;
  to: string;
  dryRun?: boolean;
}): SyncResult {
  const skills: SyncedSkill[] = [];
  let entries: string[];
  try {
    entries = fs
      .readdirSync(opts.from, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    // 소스 디렉토리가 없으면 빈 결과(claudeSkillNames 와 같은 관용).
    entries = [];
  }
  for (const engineName of entries) {
    const derivedName = derivedSkillName(engineName);
    if (derivedName === null) {
      continue;
    }
    const srcSkill = path.join(opts.from, engineName, 'SKILL.md');
    if (!fs.existsSync(srcSkill)) {
      continue;
    }
    const derived = deriveTempLoopContent(fs.readFileSync(srcSkill, 'utf8'));
    const destSkill = path.join(opts.to, derivedName, 'SKILL.md');
    const current = fs.existsSync(destSkill) ? fs.readFileSync(destSkill, 'utf8') : null;
    const changed = current !== derived;
    if (changed && opts.dryRun !== true) {
      fs.mkdirSync(path.dirname(destSkill), { recursive: true });
      fs.writeFileSync(destSkill, derived);
    }
    const action: SyncedSkill['action'] = !changed
      ? 'unchanged'
      : opts.dryRun === true
        ? 'would-change'
        : 'written';
    skills.push({ engineName, derivedName, changed, action });
  }
  return { from: opts.from, to: opts.to, skills };
}

/** 기본 소스: 설치된 엔진(~/.awl/engine/skills/claude). copyClaudeSkills 와 같은 근거. */
function defaultFrom(): string {
  return path.join(engineDir(), 'skills', 'claude');
}

/** 기본 대상: 유저 글로벌 스킬(~/.claude/skills). */
function defaultTo(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** `awl sync-skills` 핸들러. from/to 기본값을 채워 syncPipelineSkills 를 돌리고 보고한다. */
export function runSyncSkills(opts: {
  from?: string;
  to?: string;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}): void {
  const from = opts.from ?? defaultFrom();
  const to = opts.to ?? defaultTo();
  // 안전장치(리뷰 finding): 대상을 명시하지 않아 기본 라이브 글로벌(~/.claude/skills)을 덮게
  // 되는데 --dry-run·--yes 도 없으면, 실제 쓰기 대신 미리보기만 하고 --yes 를 안내한다.
  // 사용 중인 파이프라인 스킬을 낡은 엔진 파생본으로 무심코 덮는 회귀를 막는다.
  const guarded = opts.to === undefined && opts.dryRun !== true && opts.yes !== true;
  const dryRun = opts.dryRun === true || guarded;
  const result = syncPipelineSkills({ from, to, dryRun });

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ...result, guarded })}\n`);
    return;
  }

  const header = dryRun ? '파이프라인 스킬 갱신 예정' : '파이프라인 스킬 동기화';
  process.stdout.write(`\n  ${header} (엔진 정본 → 글로벌 파생)\n`);
  process.stdout.write(`    from  ${from}\n`);
  process.stdout.write(`    to    ${to}\n`);
  if (result.skills.length === 0) {
    process.stdout.write('  [!] 파생 대상(awl-pipeline-*)을 찾지 못했습니다.\n');
    return;
  }
  for (const s of result.skills) {
    const mark =
      s.action === 'written' ? '갱신  ' : s.action === 'would-change' ? '갱신예정' : '그대로';
    process.stdout.write(`    ${mark}  ${s.engineName} → ${s.derivedName}\n`);
  }
  if (guarded) {
    process.stdout.write(
      '  [!] 라이브 글로벌 대상입니다(미리보기). 실제 적용은 --yes, 미리보기는 --dry-run 을 붙이세요.\n',
    );
    return;
  }
  const changedCount = result.skills.filter((s) => s.changed).length;
  process.stdout.write(
    `  ${changedCount === 0 ? '이미 최신입니다 (멱등).' : `${changedCount}개 갱신.`}\n`,
  );
}
