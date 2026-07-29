import fs from 'node:fs';
import path from 'node:path';
import { engineDir } from './paths.js';

/**
 * 엔진 정보. 0.8.7 부터 엔진은 사본이 아니라 **설치된 npm 패키지 그 자체**다
 * (설계 대조 2단계 #7, adk-prototype.md:132 "사본을 두지 않는다").
 * 그래서 이 값은 사실상 패키지 버전과 같고, 둘이 어긋날 구조가 없어졌다.
 */

/** 엔진 버전. 패키지가 깨지지 않는 한 항상 값이 있다(못 읽으면 null). */
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
