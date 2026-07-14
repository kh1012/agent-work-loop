import fs from 'node:fs';
import path from 'node:path';
import { engineDir } from './paths.js';

/**
 * 설치된 엔진(~/.awl/engine)의 정보.
 * doctor/init/program(--version)이 각자 따로 구현하던 것을 여기로 합쳤다.
 */

/** 설치된 엔진의 버전. 없거나 읽지 못하면 null(크래시하지 않는다). */
export function installedEngineVersion(): string | null {
  try {
    const j = JSON.parse(
      fs.readFileSync(path.join(engineDir(), 'version.json'), 'utf8'),
    ) as unknown;
    if (j && typeof j === 'object') {
      const v = (j as Record<string, unknown>).engineVersion;
      if (typeof v === 'string') {
        return v;
      }
    }
  } catch {
    // 없거나 깨졌으면 null.
  }
  return null;
}
