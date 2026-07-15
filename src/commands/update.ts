import fs from 'node:fs';
import { installedEngineVersion } from '../core/engine.js';
import { engineDir } from '../core/paths.js';
import { packageEngineDir } from './init.js';

/**
 * awl update — 설치된 엔진(~/.awl/engine)을 이 패키지에 번들된 엔진으로 갱신한다.
 *
 * init.ts 의 scaffoldGlobal() 주석이 이미 "engine 갱신은 update 의 몫"이라고
 * 못박아둔 설계를 실제로 채운다(WI-X). 프로젝트별 config/스킬 재설치는 안
 * 건드린다 — 그건 기존처럼 `awl init` 재실행 몫이다.
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
  if (!result.updated) {
    process.stdout.write('\n  ~/.awl 에 설치된 엔진이 없습니다. 먼저 awl init 을 실행하세요.\n');
    return;
  }
  if (result.fromVersion === result.toVersion) {
    process.stdout.write(`\n  이미 최신입니다 (engine ${result.toVersion}).\n`);
    return;
  }
  process.stdout.write(
    `\n  엔진을 갱신했습니다: ${result.fromVersion ?? '(없음)'} -> ${result.toVersion}\n`,
  );
  process.stdout.write(
    '  프로젝트별 설정/스킬을 최신으로 맞추려면 각 프로젝트에서 awl init 을 다시 실행하세요.\n',
  );
}
