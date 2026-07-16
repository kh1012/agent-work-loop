import fs from 'node:fs';
import path from 'node:path';
import { version as packageVersion } from '../../package.json';
import { installedEngineVersion } from '../core/engine.js';
import { type Caps, caps, card, makeColors } from '../core/tty.js';
import { type VersionCheckResult, type VersionInputs, checkVersions } from '../core/versions.js';
import { resolveProjectRoot } from './config.js';
import { packageEngineDir, skillsVersionPath } from './init.js';

/**
 * awl version-check — 버전 네 쌍을 검사한다(WI-X).
 *
 * awl 은 판단하지 않는다 — 값이 다른지만 계산한다. 계속할지는 스킬(에이전트)이
 * 사람에게 물어서 정한다.
 */

function readJson(p: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readVersionField(p: string, field: string): string | null {
  const raw = readJson(p);
  if (raw && typeof raw === 'object') {
    const v = (raw as Record<string, unknown>)[field];
    if (typeof v === 'string') {
      return v;
    }
  }
  return null;
}

/** 실제 환경에서 checkVersions 의 입력값을 모은다(I/O). projectRoot 가 null 이면 프로젝트/스킬 쌍은 건너뛴다. */
export function gatherVersionInputs(projectRoot: string | null): VersionInputs {
  const engineSourceVersion = readVersionField(
    path.join(packageEngineDir(), 'version.json'),
    'engineVersion',
  );
  const installed = installedEngineVersion();
  const projectEngineVersion = projectRoot
    ? readVersionField(path.join(projectRoot, '.awl', 'config.json'), 'engineVersion')
    : null;
  const skillsRaw = projectRoot ? readJson(skillsVersionPath(projectRoot)) : null;
  const installedSkillVersions = {
    claude:
      skillsRaw && typeof skillsRaw === 'object'
        ? typeof (skillsRaw as Record<string, unknown>).claude === 'string'
          ? ((skillsRaw as Record<string, unknown>).claude as string)
          : null
        : null,
    codex:
      skillsRaw && typeof skillsRaw === 'object'
        ? typeof (skillsRaw as Record<string, unknown>).codex === 'string'
          ? ((skillsRaw as Record<string, unknown>).codex as string)
          : null
        : null,
  };

  return {
    packageVersion,
    engineSourceVersion,
    installedEngineVersion: installed,
    projectEngineVersion,
    installedSkillVersions,
  };
}

/** 사람용 출력. 불일치는 노란색+[!] 마커(색 미지원/CI 는 마커만). */
export function renderVersionCheck(result: VersionCheckResult, c: Caps): string {
  const color = makeColors(c.color);
  if (result.ok) {
    return card('버전 확인', [color.green('버전이 전부 일치합니다.')], c);
  }
  const out: string[] = [];
  for (const m of result.mismatches) {
    out.push(`${color.yellow('[!]')} ${m.kind}: ${m.a} / ${m.b}`);
    out.push(`    ${color.dim(m.hint)}`);
  }
  return card(`버전 불일치 ${result.mismatches.length}건`, out, c);
}

export function runVersionCheck(opts: { json: boolean }): void {
  const projectRoot = resolveProjectRoot();
  const inputs = gatherVersionInputs(projectRoot);
  const result = checkVersions(inputs);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderVersionCheck(result, caps()));
  }
}
