import fs from 'node:fs';
import path from 'node:path';
import { globalConfigPath } from './paths.js';
import { run } from './runner.js';

/**
 * ~/.awl/config.json — 사람마다 한 번 설정하는 전역 값(author · sync).
 * 저장소 사실(.awl/config.json)과 다른 파일이다 — 혼동 방지는 두 함수 이름
 * (Global 접두) 과 경로(paths.ts 의 globalConfigPath)로 한다.
 *
 * "관용적으로 읽는다" 원칙(ADK): 모르는 키는 무시하고, 파일이 없거나 깨졌으면
 * 예외를 던지지 않고 null 을 돌려준다. 그래야 전역 config 가 없어도 나머지
 * 흐름(record 등)이 막히지 않는다.
 */

export interface GlobalAwlConfig {
  author?: string;
  sync?: {
    records?: { endpoint?: string; token?: string };
    feedback?: { endpoint?: string };
  };
}

export function readGlobalAwlConfig(): GlobalAwlConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(globalConfigPath(), 'utf8')) as unknown;
    if (raw && typeof raw === 'object') {
      return raw as GlobalAwlConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 원자적 쓰기(npm-registry.ts 의 writeCache() 와 같은 패턴) — temp 에 쓰고
 * rename 으로 교체해 병렬 세션이 동시에 써도 부분 쓰기로 남지 않는다.
 */
export function writeGlobalAwlConfig(config: GlobalAwlConfig): void {
  const target = globalConfigPath();
  const tmp = `${target}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, target);
}

/**
 * git config user.email 을 시드값으로 읽는다. 실패(git 없음·설정 없음·실행 실패)는
 * 전부 빈 문자열 — 이 값은 "미리 채워주는 기본값"일 뿐이라 실패해도 진행을 막지
 * 않는다. 이후 런타임은 이 함수를 다시 안 부른다 — 저장된 config 만 읽는다.
 */
export async function seedAuthorFromGitConfig(cwd?: string): Promise<string> {
  try {
    const result = await run({ cmd: 'git', args: ['config', 'user.email'], cwd });
    if (result.exitCode === 0) {
      return result.stdout.trim();
    }
    return '';
  } catch {
    return '';
  }
}
