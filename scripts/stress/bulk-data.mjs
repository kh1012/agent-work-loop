#!/usr/bin/env node
// 대량 데이터 스트레스 (stress-bulk-data).
//
// records 수만건·큰 state.json(criteria 수백)·.awl-worktrees/ 하위 untracked 수천 상황에서
// awl 명령(status/evolve/commit --start/doctor)의 소요시간·정확성이 견디는지 관측한다.
// F-1 방어(listUntracked 가 .awl-worktrees/ 제외, doctor 가 state.json>1MB warn)를 실측한다.
// 발굴만. 종료코드 0(관측 도구).
//
// 실행: node scripts/stress/bulk-data.mjs [records] [criteria] [untracked]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..', '..');
const CLI = path.join(REPO, 'dist', 'cli.js');

const RECORDS = Number(process.argv[2] ?? 30000);
const CRITERIA = Number(process.argv[3] ?? 300);
const UNTRACKED = Number(process.argv[4] ?? 3000);

function log(s) {
  process.stdout.write(`${s}\n`);
}

function setup() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-bulk-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-bulk-home-')));
  const g = (args) => spawnSync('git', args, { cwd: proj, encoding: 'utf8' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 's@s.com']);
  g(['config', 'user.name', 's']);
  spawnSync('node', [CLI, 'init', '--yes'], { cwd: proj, env: { ...process.env, AWL_HOME: home } });
  fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'base']);

  // 대량 records: 한 JSONL 파일에 RECORDS 줄.
  const recDir = path.join(home, 'records');
  fs.mkdirSync(recDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < RECORDS; i++) {
    lines.push(
      JSON.stringify({
        id: `rec_${i}`,
        at: `2026-07-16T${String(i % 24).padStart(2, '0')}:00:00.${String(i % 1000).padStart(3, '0')}Z`,
        type: i % 5 === 0 ? 'attempt' : 'audit',
        project: 'bulk',
        workitem: 'BULK',
        result: 'passed',
      }),
    );
  }
  // commit --start 가 게이트 가드(hasApprovedGate1)를 통과하도록 BULK 의 gate:1 승인 기록.
  lines.push(
    JSON.stringify({
      id: 'rec_gate',
      at: '2026-07-16T00:00:00.000Z',
      type: 'gate',
      gate: 1,
      decision: 'approved',
      workitem: 'BULK',
      project: 'bulk',
      presentedCriteria: ['AC-0'],
    }),
  );
  fs.writeFileSync(path.join(recDir, '2026-07.jsonl'), `${lines.join('\n')}\n`);

  // 큰 state.json: CRITERIA 개 criterion(각 baseline/snapshot 포함).
  const criteria = Array.from({ length: CRITERIA }, (_, i) => ({
    id: `AC-${i}`,
    status: 'passed',
    attempts: 0,
    baseline: 'a'.repeat(40),
    snapshot: 'b'.repeat(40),
    untrackedAtStart: [],
  }));
  fs.writeFileSync(
    path.join(proj, '.awl', 'state.json'),
    JSON.stringify({ workitem: 'BULK', phase: 'loop', criteria }, null, 2),
  );

  // .awl-worktrees/ 하위 대량 untracked(F-1 방어 대상 — commit 이 스냅샷 안 해야).
  const wtDir = path.join(proj, '.awl-worktrees', 'w');
  fs.mkdirSync(wtDir, { recursive: true });
  for (let i = 0; i < UNTRACKED; i++) {
    fs.writeFileSync(path.join(wtDir, `u${i}.txt`), `u${i}\n`);
  }
  return { proj, home };
}

function time(label, args, proj, home) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync('node', [CLI, ...args], {
    cwd: proj,
    env: { ...process.env, AWL_HOME: home },
    encoding: 'utf8',
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  log(`  ${label}: ${ms.toFixed(0)}ms (exit ${r.status})`);
  return { ms, r };
}

log(`# 대량 데이터 스트레스 (records=${RECORDS}, criteria=${CRITERIA}, untracked=${UNTRACKED})`);
if (!fs.existsSync(CLI)) {
  log('  ! dist/cli.js 없음 — pnpm run build. 중단.');
  process.exit(0);
}
log('픽스처 생성 중...');
const { proj, home } = setup();
const stateBytes = fs.statSync(path.join(proj, '.awl', 'state.json')).size;
log(
  `  state.json 크기: ${(stateBytes / 1024).toFixed(0)}KB · records 파일: ${(fs.statSync(path.join(home, 'records', '2026-07.jsonl')).size / (1024 * 1024)).toFixed(1)}MB`,
);

log('\n## 명령 소요시간');
time('status', ['status'], proj, home);
time('status --json', ['status', '--json'], proj, home);
time('evolve --collect', ['evolve', '--collect', '--workitem', 'BULK'], proj, home);
time('doctor', ['doctor'], proj, home);

log('\n## F-1 방어 실측: commit --start 가 .awl-worktrees/ 대량 untracked 를 스냅샷 안 하는가');
time('commit --start', ['commit', '--start', 'NEW-AC'], proj, home);
const afterBytes = fs.statSync(path.join(proj, '.awl', 'state.json')).size;
log(
  `  commit --start 후 state.json: ${(afterBytes / 1024).toFixed(0)}KB (증가 ${((afterBytes - stateBytes) / 1024).toFixed(0)}KB)`,
);
log(
  `  → ${afterBytes - stateBytes < 100 * 1024 ? 'OK: .awl-worktrees/ untracked 미스냅샷(F-1 방어 유효)' : '!! 폭증 — 방어 실패'}`,
);

log('\n## doctor state.json 크기 경고(F-1)');
const doc = spawnSync('node', [CLI, 'doctor'], {
  cwd: proj,
  env: { ...process.env, AWL_HOME: home },
  encoding: 'utf8',
});
const clean = (doc.stdout + doc.stderr).replace(/\x1b\[[0-9;]*m/g, '');
log(
  `  state.json ${(afterBytes / 1024).toFixed(0)}KB ${afterBytes > 1024 * 1024 ? '(>1MB, warn 기대)' : '(<1MB, warn 없음 정상)'} — doctor 크기 warn: ${clean.includes('state.json 크기') ? '뜸' : '안 뜸'}`,
);

log('\n(관측 도구 — 발견은 stress-bulk-data 핸드오프에 수치와 기록.)');
