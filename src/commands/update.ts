import fs from 'node:fs';
import { installedEngineVersion } from '../core/engine.js';
import { engineDir } from '../core/paths.js';
import { caps, makeSymbols, sectionBox, signal } from '../core/tty.js';
import { packageEngineDir } from './init.js';

/**
 * awl update — 설치된 엔진(~/.awl/engine)을 이 패키지에 번들된 엔진으로 갱신한다.
 *
 * `awl update`는 프로젝트 질문 없이 홈 엔진만 바로 갱신하는 빠른 경로다.
 * `awl init` 재실행도 엔진 템플릿을 갱신하지만, 이 명령은 프로젝트 설정과
 * 스킬 설치 선택을 건드리지 않는다.
 */

export interface UpdateResult {
  updated: boolean;
  reason?: 'not-installed';
  fromVersion: string | null;
  toVersion: string | null;
}

export function applyUpdate(): UpdateResult {
  const fromVersion = installedEngineVersion();
  if (fromVersion === null) {
    return { updated: false, reason: 'not-installed', fromVersion: null, toVersion: null };
  }
  fs.cpSync(packageEngineDir(), engineDir(), { recursive: true });
  const toVersion = installedEngineVersion();
  return { updated: true, fromVersion, toVersion };
}

export function runUpdate(): void {
  const result = applyUpdate();
  const c = caps();
  const s = makeSymbols(c);
  if (!result.updated) {
    process.stdout.write(
      `\n${sectionBox('엔진 템플릿', [`${signal(c, 'warn')} ~/.awl 에 설치된 엔진이 없습니다.`, `${s.lastBranch} awl init 을 먼저 실행하세요.`], c)}\n`,
    );
    return;
  }
  if (result.fromVersion === result.toVersion) {
    process.stdout.write(
      `\n${sectionBox('엔진 템플릿', [`${signal(c, 'ok')} 이미 최신입니다.`, `${s.lastBranch} Engine Template: v${result.toVersion}`], c)}\n`,
    );
    return;
  }
  process.stdout.write(
    `\n${sectionBox(
      '엔진 템플릿',
      [
        `${signal(c, 'ok')} 엔진을 갱신했습니다.`,
        `${s.branch} v${result.fromVersion ?? '(없음)'} → v${result.toVersion}`,
        `${s.lastBranch} 프로젝트별 설정/스킬은 각 프로젝트에서 awl init 으로 갱신하세요.`,
      ],
      c,
    )}\n`,
  );
}
