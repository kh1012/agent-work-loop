import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 한 테스트가 멈추면 그 자리에서 실패시킨다. 0.7.5~0.8.12 동안 CI 가 매번
    // 9분씩 무출력으로 매달리다 죽었는데(1MB 를 파이프 stdout 에 쓰다 교착),
    // 타임아웃이 없으면 "무엇이 멈췄나"가 로그에 안 남아 원인 추적이 어렵다.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
