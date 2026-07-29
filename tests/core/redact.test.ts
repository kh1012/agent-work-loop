import { describe, expect, it } from 'vitest';
import { redactAbsolutePaths } from '../../src/core/redact.js';

describe('redactAbsolutePaths — 순수 함수', () => {
  it('프로젝트 루트 경로를 <project> 로 치환한다', () => {
    const out = redactAbsolutePaths(
      '/Users/x/proj/src/foo.ts 에서 실패',
      '/Users/x/home',
      '/Users/x/proj',
    );
    expect(out).toBe('<project>/src/foo.ts 에서 실패');
  });

  it('홈 디렉토리 경로를 <home> 으로 치환한다', () => {
    const out = redactAbsolutePaths('/Users/x/home/.awl/config.json 없음', '/Users/x/home', null);
    expect(out).toBe('<home>/.awl/config.json 없음');
  });

  it('둘 다 있으면 둘 다 치환한다', () => {
    const out = redactAbsolutePaths(
      '/Users/x/home/.awl 과 /Users/x/proj/src 모두 등장',
      '/Users/x/home',
      '/Users/x/proj',
    );
    expect(out).toBe('<home>/.awl 과 <project>/src 모두 등장');
  });

  it('경로가 전혀 없는 메시지는 그대로 보존한다', () => {
    expect(redactAbsolutePaths('알 수 없는 필드', '/Users/x/home', '/Users/x/proj')).toBe(
      '알 수 없는 필드',
    );
  });

  it('projectRoot 가 null 이어도 크래시하지 않는다', () => {
    expect(redactAbsolutePaths('메시지', '/Users/x/home', null)).toBe('메시지');
  });
});
