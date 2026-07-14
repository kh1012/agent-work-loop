import { defineConfig } from 'tsup';

// src/cli.ts 첫 줄의 shebang(#!/usr/bin/env node)은 tsup이 결과물에 보존하고
// 실행 권한(+x)까지 자동으로 붙인다.
export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  minify: false,
  sourcemap: false,
  dts: false,
  shims: false,
});
