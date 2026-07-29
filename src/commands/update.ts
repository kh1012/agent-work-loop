import fs from 'node:fs';
import { installedEngineVersion } from '../core/engine.js';
import { type Caps, caps, makeSymbols, sectionBox, signal } from '../core/tty.js';
import { listRegisteredProjects, syncExistingInstall } from './init.js';

/**
 * awl update — 등록된 프로젝트들의 로컬 스킬을 지금 패키지 엔진에 맞춘다(--local/--all).
 *
 * 엔진 자체는 갱신 대상이 아니다 — 사본을 두지 않으므로 엔진은 설치된 npm 패키지다
 * (2단계 #7). 엔진을 올리려면 `npm i -g agent-work-loop@latest` 하나뿐이다.
 *
 * 세 스코프는 서로 독립이다:
 * - `--global`(기본): 아무것도 안 고치고 지금 버전과 갱신 방법만 알려준다.
 * - `--local`: 등록된 프로젝트 전부(현재 프로젝트 하나가 아니다)의 `.claude/skills`·
 *   `.agents/skills`·`AGENTS.md`·`.awl/config.json`을 지금 설치된 엔진 버전에 맞춰 재동기화한다
 *   (`awl init --yes`가 이미 설정된 프로젝트에서 하는 것과 같은 동작 — syncExistingInstall
 *   재사용). 홈 엔진 자체는 안 건드린다.
 * - `--all`: 위 둘 다.
 *
 * 옵션 없이 치면 `--global`과 같다 — 기존 사용자 스크립트/습관을 안 깬다(가장 좁은
 * 범위가 기본값, 넓히는 건 명시적 opt-in — pipeline mode 의 gate-high 기본값과 같은 원칙).
 */

export interface UpdateResult {
  updated: boolean;
  reason?: 'not-installed';
  fromVersion: string | null;
  toVersion: string | null;
}

/**
 * 전역 엔진 갱신은 더 이상 awl 이 하지 않는다(설계 대조 2단계 #7).
 * 엔진 = 설치된 npm 패키지라, 갱신 방법은 하나다 — `npm i -g agent-work-loop@latest`.
 * 복사할 사본이 없으므로 이 함수는 지금 버전을 알려주기만 한다.
 */
export function applyUpdate(): UpdateResult {
  const version = installedEngineVersion();
  if (version === null) {
    return { updated: false, reason: 'not-installed', fromVersion: null, toVersion: null };
  }
  return { updated: false, fromVersion: version, toVersion: version };
}

export interface ProjectSyncResult {
  name: string;
  path: string;
  status: 'updated' | 'up-to-date' | 'skipped';
  reason?: string;
  skills: string[];
}

/**
 * ~/.awl/projects.json 에 등록된 프로젝트 전부를 순회하며 syncExistingInstall 을
 * 적용한다(awl-update-local AC-01). 경로가 없어졌거나(이동/삭제) .awl/config.json 이
 * 없는 프로젝트는 실패로 죽지 않고 'skipped'로 건너뛴다 — 등록된 프로젝트 중 하나가
 * 사라졌다고 나머지 동기화까지 막히면 안 된다.
 */
export function applyLocalUpdate(engineVersion: string, now: string): ProjectSyncResult[] {
  const results: ProjectSyncResult[] = [];
  for (const p of listRegisteredProjects()) {
    if (!fs.existsSync(p.path)) {
      results.push({
        name: p.name,
        path: p.path,
        status: 'skipped',
        reason: '경로를 찾을 수 없습니다',
        skills: [],
      });
      continue;
    }
    if (!fs.existsSync(`${p.path}/.awl/config.json`)) {
      results.push({
        name: p.name,
        path: p.path,
        status: 'skipped',
        reason: '.awl/config.json 이 없습니다(awl init 필요)',
        skills: [],
      });
      continue;
    }
    const synced = syncExistingInstall(p.path, engineVersion, now);
    // skillsStale 만 신뢰한다 — synced.skills 는 재설치된 스킬 이름 목록일 뿐(내용이
    // 같아도 항상 무조건 재복사되므로 "스킬을 쓴다"는 뜻이지 "이번에 실제로 낡았다"는
    // 뜻이 아니다, F-2와 같은 함정). skillsStale 은 재설치 전 skills-version.json
    // 스탬프가 실제로 engineVersion 과 달랐는지를 본다(예전 config.engineVersion 이
    // 하던 역할을 이제 이 필드가 한다).
    results.push({
      name: p.name,
      path: p.path,
      status: synced.skillsStale ? 'updated' : 'up-to-date',
      skills: synced.skills,
    });
  }
  return results;
}

function renderGlobal(result: UpdateResult, c: Caps): string[] {
  const s = makeSymbols(c);
  if (!result.updated) {
    return [
      `${signal(c, 'warn')} ~/.awl 에 설치된 엔진이 없습니다.`,
      `${s.lastBranch} awl init 을 먼저 실행하세요.`,
    ];
  }
  if (result.fromVersion === result.toVersion) {
    return [
      `${signal(c, 'ok')} 전역 엔진 이미 최신입니다.`,
      `${s.lastBranch} Engine Template: v${result.toVersion}`,
    ];
  }
  return [
    `${signal(c, 'ok')} 전역 엔진을 갱신했습니다.`,
    `${s.lastBranch} v${result.fromVersion ?? '(없음)'} → v${result.toVersion}`,
  ];
}

function renderLocal(results: ProjectSyncResult[], c: Caps): string[] {
  if (results.length === 0) {
    return [`${signal(c, 'info')} 등록된 프로젝트가 없습니다.`];
  }
  const updated = results.filter((r) => r.status === 'updated');
  const skipped = results.filter((r) => r.status === 'skipped');
  const lines: string[] = [];
  if (updated.length === 0) {
    lines.push(`${signal(c, 'ok')} 등록된 프로젝트 ${results.length}개 전부 이미 최신입니다.`);
  } else {
    lines.push(`${signal(c, 'ok')} 프로젝트 ${updated.length}개 로컬 스킬을 갱신했습니다:`);
    for (const r of updated) {
      lines.push(
        `    - ${r.name} (${r.path})${r.skills.length ? ` — 스킬: ${r.skills.join(', ')}` : ''}`,
      );
    }
    lines.push(
      '    이 프로젝트들의 변경(.claude/skills, .agents/skills, AGENTS.md, .awl/config.json)은 커밋 대상입니다.',
    );
  }
  for (const r of skipped) {
    lines.push(`${signal(c, 'warn')} ${r.name} (${r.path}) 건너뜀 — ${r.reason}`);
  }
  return lines;
}

export function runUpdate(opts: { global?: boolean; local?: boolean; all?: boolean } = {}): void {
  const c = caps();
  const wantGlobal = opts.all === true || opts.global === true || (!opts.local && !opts.all);
  const wantLocal = opts.all === true || opts.local === true;

  const sections: string[] = [];

  let engineVersion = installedEngineVersion();
  if (wantGlobal) {
    const result = applyUpdate();
    engineVersion = result.toVersion;
    sections.push(...renderGlobal(result, c));
  }

  if (wantLocal) {
    if (sections.length > 0) {
      sections.push('');
    }
    if (engineVersion === null) {
      sections.push(
        `${signal(c, 'warn')} ~/.awl 에 설치된 엔진이 없어 로컬 동기화를 건너뜁니다.`,
        'awl init 을 먼저 실행하세요.',
      );
    } else {
      sections.push(...renderLocal(applyLocalUpdate(engineVersion, new Date().toISOString()), c));
    }
  }

  process.stdout.write(`\n${sectionBox('엔진 템플릿', sections, c)}\n`);
}
