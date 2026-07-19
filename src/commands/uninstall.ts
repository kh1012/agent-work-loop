import fs from 'node:fs';
import path from 'node:path';
import {
  engineDir,
  globalRoot,
  gotchasDir,
  legacyDeltasDir,
  lockFile,
  npmVersionCachePath,
  projectsFile,
  recordsDir,
  rulesDir,
  templatesDir,
} from '../core/paths.js';
import { type Caps, caps, card, makeColors, signal } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';

/**
 * awl uninstall — awl 이 손댄 모든 흔적(전역 홈 + 프로젝트 로컬 + 알려진 레거시 경로)을
 * 지운다. 기본은 드라이런이다 — --yes 없이는 파일시스템을 절대 바꾸지 않는다(AC-01).
 *
 * 목적: "완전히 새로 설치한 사용자" 상태를 재현할 수 있게 한다. 다음 `awl init` 이
 * 진짜 최초 설치처럼 동작해야 한다(AC-07).
 */

export interface UninstallItem {
  /** 사람이 읽는 카테고리 라벨(목록/JSON 공통). */
  category: string;
  scope: 'project' | 'global';
  /** 현재 코드가 만들지 않는, 과거 버전이 남긴 경로인가(F-05). */
  legacy: boolean;
  kind: 'dir' | 'file' | 'partial' | 'worktree';
  path: string;
  /** 실제로 디스크에 있는가(스캔 시점). */
  present: boolean;
  /** --yes 실행 시 이 항목을 실제로 지울 수 있는가(예: pre-push 템플릿 불일치면 false). */
  removable: boolean;
  detail?: string;
}

function requireRoot(): string {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  return root;
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** .claude/skills/ 아래 awl 소유 스킬만 고른다 — 다른 스킬(프로젝트가 따로 설치한 것)은 절대 건드리지 않는다. */
function awlSkillDirNames(root: string): string[] {
  const dir = path.join(root, '.claude', 'skills');
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) => e.isDirectory() && (e.name === 'awl-loop' || e.name.startsWith('awl-pipeline')),
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * F-05 레거시 마커 잔재: `.tasks/**\/*ㅍ*.md` (pipeline-marker-finalization 0.6.15 이전).
 * 코드가 더는 만들지 않는 패턴이라 파일명 자체로만 찾는다.
 */
export function findMarkerLegacyFiles(root: string): string[] {
  const base = path.join(root, '.tasks');
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md') && e.name.includes('ㅍ')) {
        out.push(p);
      }
    }
  };
  walk(base);
  return out;
}

/**
 * F-04 프로젝트 로컬 구성요소를 스캔한다(읽기 전용 — fs 를 쓰지 않는다). 실제로
 * 존재하는 항목만 `present:true` 로 표시한다(AC-01, "실제 발견된 것만").
 */
export function scanProjectLocal(root: string): UninstallItem[] {
  const items: UninstallItem[] = [];
  const push = (
    partial: Omit<UninstallItem, 'scope' | 'legacy' | 'removable'> &
      Partial<Pick<UninstallItem, 'legacy' | 'removable'>>,
  ): void => {
    items.push({ scope: 'project', legacy: false, removable: true, ...partial });
  };

  const dotAwl = path.join(root, '.awl');
  push({
    category: '.awl/ (config·state·skills-version·verify-baseline·state.lock·home)',
    kind: 'dir',
    path: dotAwl,
    present: exists(dotAwl),
  });

  for (const name of awlSkillDirNames(root)) {
    const p = path.join(root, '.claude', 'skills', name);
    push({ category: `.claude/skills/${name}`, kind: 'dir', path: p, present: true });
  }

  const agentsMd = path.join(root, 'AGENTS.md');
  const hasMarker =
    exists(agentsMd) && fs.readFileSync(agentsMd, 'utf8').includes('awl-loop:start');
  push({
    category: 'AGENTS.md (awl 마커 구간만 — 나머지 내용 보존)',
    kind: 'partial',
    path: agentsMd,
    present: hasMarker,
  });

  for (const sub of ['plan', 'exec', 'review', 'archive']) {
    const p = path.join(root, '.tasks', sub);
    push({ category: `.tasks/${sub}`, kind: 'dir', path: p, present: exists(p) });
  }
  const locksPath = path.join(root, '.tasks', '.locks');
  push({ category: '.tasks/.locks', kind: 'dir', path: locksPath, present: exists(locksPath) });

  const prePush = path.join(root, '.git', 'hooks', 'pre-push');
  push({
    category: '.git/hooks/pre-push (awl 템플릿과 일치할 때만)',
    kind: 'partial',
    path: prePush,
    present: exists(prePush),
  });

  const legacyAwlHome = path.join(root, '.awl-home');
  push({
    category: '.awl-home (0.6.17 이전 레거시 경로)',
    kind: 'dir',
    path: legacyAwlHome,
    present: exists(legacyAwlHome),
    legacy: true,
  });

  for (const f of findMarkerLegacyFiles(root)) {
    push({ category: 'ㅍ 마커 잔재', kind: 'file', path: f, present: true, legacy: true });
  }

  return items;
}

function findDeltasBackups(gRoot: string): string[] {
  try {
    return fs
      .readdirSync(gRoot)
      .filter((n) => n.startsWith('deltas.backup-'))
      .map((n) => path.join(gRoot, n));
  } catch {
    return [];
  }
}

/**
 * F-02 전역 구성요소를 스캔한다(읽기 전용). globalRoot() 를 호출 시점에 읽으므로
 * AWL_HOME 재정의(테스트 격리)를 그대로 존중한다.
 */
export function scanGlobal(): UninstallItem[] {
  const items: UninstallItem[] = [];
  const push = (
    category: string,
    p: string,
    kind: UninstallItem['kind'] = 'dir',
    legacy = false,
  ): void => {
    items.push({
      scope: 'global',
      legacy,
      kind,
      path: p,
      present: exists(p),
      removable: true,
      category,
    });
  };
  push('engine/', engineDir());
  push('records/', recordsDir());
  push('gotchas/', gotchasDir());
  push('rules/', rulesDir());
  push('generations/', path.join(globalRoot(), 'generations'));
  push('templates/', templatesDir());
  push('projects.json', projectsFile(), 'file');
  push('.lock', lockFile(), 'file');
  push('npm-latest-cache.json', npmVersionCachePath(), 'file');
  push('deltas/ (레거시, gotchas 개명 이전)', legacyDeltasDir(), 'dir', true);
  for (const b of findDeltasBackups(globalRoot())) {
    items.push({
      scope: 'global',
      legacy: true,
      kind: 'file',
      path: b,
      present: true,
      removable: true,
      category: 'deltas.backup-* (레거시)',
    });
  }
  return items;
}

function renderPlan(project: UninstallItem[], global: UninstallItem[], c: Caps): string {
  const color = makeColors(c.color);
  const lines: string[] = [];

  lines.push(color.bold('프로젝트 로컬'));
  const pFound = project.filter((i) => i.present);
  if (pFound.length === 0) {
    lines.push('  (발견된 것 없음)');
  }
  for (const it of pFound) {
    lines.push(`  ${signal(c, 'ok')} ${it.legacy ? '[레거시] ' : ''}${it.category}`);
  }

  lines.push('');
  lines.push(color.bold('전역 (~/.awl, 다른 프로젝트와 공유)'));
  const gFound = global.filter((i) => i.present);
  if (gFound.length === 0) {
    lines.push('  (발견된 것 없음)');
  }
  for (const it of gFound) {
    lines.push(`  ${signal(c, 'ok')} ${it.legacy ? '[레거시] ' : ''}${it.category}`);
  }

  lines.push('');
  lines.push(
    color.dim(
      'npm 패키지 자체는 이 명령으로 지우지 않습니다. 필요하면 npm uninstall -g agent-work-loop 를 직접 실행하세요.',
    ),
  );
  return card('awl uninstall — 드라이런(dry run)', lines, c, 40);
}

export interface UninstallOpts {
  yes?: boolean;
  json?: boolean;
  /** 스코프 플래그(AC-02) — CLI 표면은 여기서 함께 등록하되, 실제 스코프 분리
   * 로직은 AC-02 커밋에서 구현한다. 여기서는 아직 안 쓴다(무시). */
  project?: boolean;
  global?: boolean;
  all?: boolean;
}

/**
 * awl uninstall 오케스트레이터. `--yes` 가 없으면 스캔·출력만 하고 반환한다
 * (fs 쓰기 0건, AC-01). `--yes` 가 있으면 스캔된 항목을 실제로 지운다.
 */
export async function runUninstall(opts: UninstallOpts): Promise<void> {
  const root = requireRoot();
  const c = caps();
  const project = scanProjectLocal(root);
  const global = scanGlobal();

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: !opts.yes,
          project: project.filter((i) => i.present),
          global: global.filter((i) => i.present),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`\n${renderPlan(project, global, c)}\n`);
  }

  if (!opts.yes) {
    return;
  }

  for (const item of [...project, ...global]) {
    if (!item.present) {
      continue;
    }
    fs.rmSync(item.path, { recursive: true, force: true });
  }
  const color = makeColors(c.color);
  process.stdout.write(`\n  ${signal(c, 'ok')} ${color.bold('삭제 완료')}\n`);
}
