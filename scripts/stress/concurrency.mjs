#!/usr/bin/env node
// 동시성/경합 스트레스 하네스 (stress-concurrency).
//
// 여러 awl 프로세스가 같은 프로젝트를 동시에 칠 때의 경합을 target-time barrier 로
// 결정적으로 유발한다. concurrency-1/2/3 방어(state.lock·원자 쓰기)가 작동하는지 보고,
// 락이 없는 경로(commit --start·record)의 유실을 관측한다.
//
// 실행:  node scripts/stress/concurrency.mjs [N] [반복]
//   N       = 케이스당 병렬 프로세스 수 (기본 8)
//   반복    = 각 케이스 반복 횟수 (기본 3, 경합 재현 안정성 확인)
// 내부:  node scripts/stress/concurrency.mjs child <case> <barrierAt> <idx> <proj> <home>
//
// 발견만 한다(범위 밖: 수정). 종료코드는 항상 0 — 관측 도구라 이슈가 있어도 실패 아님.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(path.dirname(SELF), '..', '..');
const CLI = path.join(REPO, 'dist', 'cli.js');

// --- child: barrier 까지 기다렸다가 배정된 awl 명령 하나를 실행하고 그 종료코드로 종료 ---
if (process.argv[2] === 'child') {
  const [, , , caseId, barrierAt, idx, proj, home] = process.argv;
  const env = { ...process.env, AWL_HOME: home };
  const i = Number(idx);
  // barrier: 거친 sleep 뒤 마지막 구간은 spin 으로 정밀 동기(프로세스들을 ms 내로 모은다).
  const target = Number(barrierAt);
  const coarse = target - Date.now() - 15;
  if (coarse > 0) {
    spawnSync('sleep', [String(coarse / 1000)]); // 동기 sleep(외부 명령)
  }
  while (Date.now() < target) {
    // busy-wait 마지막 ~15ms
  }
  const args = buildChildArgs(caseId, i);
  const r = spawnSync('node', [CLI, ...args], { cwd: proj, env, encoding: 'utf8' });
  process.exit(r.status ?? 1);
}

/** 케이스별로 child idx 가 실행할 awl 인자 배열. */
function buildChildArgs(caseId, i) {
  if (caseId === 'state-set') {
    return ['state', 'set', '--json', JSON.stringify({ [`k${i}`]: i })];
  }
  if (caseId === 'commit-start') {
    return ['commit', '--start', `AC-${i}`];
  }
  if (caseId === 'record') {
    return [
      'record',
      'audit',
      '--json',
      JSON.stringify({
        workitem: 'STRESS',
        scope: `s${i}`,
        findings: [{ id: `F-${i}`, what: `w${i}`, severity: 'low' }],
      }),
    ];
  }
  throw new Error(`unknown case ${caseId}`);
}

// --- orchestrator ---
const N = Number(process.argv[2] ?? 8);
const ROUNDS = Number(process.argv[3] ?? 3);

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

/** 깨끗한 임시 프로젝트 + 격리 AWL_HOME. */
function freshProject() {
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-stress-')));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-stress-home-')));
  sh('git', ['init', '-q', '-b', 'main'], { cwd: proj });
  sh('git', ['config', 'user.email', 's@s.com'], { cwd: proj });
  sh('git', ['config', 'user.name', 's'], { cwd: proj });
  sh('git', ['config', 'commit.gpgsign', 'false'], { cwd: proj });
  sh('node', [CLI, 'init', '--yes'], { cwd: proj, env: { ...process.env, AWL_HOME: home } });
  fs.writeFileSync(path.join(proj, 'f.txt'), 'base\n');
  sh('git', ['add', '-A'], { cwd: proj });
  sh('git', ['commit', '-q', '-m', 'base'], { cwd: proj });
  return { proj, home };
}

/** N개 child 를 barrier 로 동시에 띄우고 각 종료코드를 모은다. */
function runBarrier(caseId, proj, home) {
  const barrierAt = Date.now() + 300 + N * 20; // 모든 child spawn 이 끝날 여유
  const kids = [];
  for (let i = 0; i < N; i++) {
    kids.push(
      new Promise((resolve) => {
        const c = spawn('node', [SELF, 'child', caseId, String(barrierAt), String(i), proj, home], {
          stdio: 'ignore',
        });
        c.on('exit', (code) => resolve(code ?? 1));
      }),
    );
  }
  return Promise.all(kids);
}

function readState(proj) {
  try {
    return JSON.parse(fs.readFileSync(path.join(proj, '.awl', 'state.json'), 'utf8'));
  } catch (e) {
    return { __parseError: String(e) };
  }
}

function countRecordLines(home) {
  const dir = path.join(home, 'records');
  let total = 0;
  let corrupt = 0;
  let stress = 0;
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.jsonl')) continue;
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      total++;
      try {
        const r = JSON.parse(line);
        if (r.workitem === 'STRESS') stress++;
      } catch {
        corrupt++;
      }
    }
  }
  return { total, corrupt, stress };
}

const out = [];
function log(s) {
  out.push(s);
  process.stdout.write(`${s}\n`);
}

async function caseStateSet() {
  log(`\n## Case A — 동시 state set (서로 다른 키 k0..k${N - 1})`);
  for (let round = 1; round <= ROUNDS; round++) {
    const { proj, home } = freshProject();
    const codes = await runBarrier('state-set', proj, home);
    const ok = codes.filter((c) => c === 0).length;
    const rejected = codes.filter((c) => c === 1).length;
    const st = readState(proj);
    const keys = st.__parseError ? -1 : Object.keys(st).filter((k) => /^k\d+$/.test(k)).length;
    log(
      `  r${round}: 성공 ${ok} · 거부(exit1) ${rejected} · 최종 state.json 유효=${!st.__parseError} · 살아남은 k키 ${keys}/${N}`,
    );
  }
  log(
    '  기대: 락으로 직렬화 → 손상 없음(유효 JSON). 동시 획득 실패는 exit1 거부(silent loss 아님).',
  );
}

async function caseCommitStart() {
  log(`\n## Case B — 동시 commit --start (서로 다른 AC-0..AC-${N - 1})`);
  for (let round = 1; round <= ROUNDS; round++) {
    const { proj, home } = freshProject();
    // N개 criterion 을 미리 심는다(락 있는 state set 로).
    const criteria = Array.from({ length: N }, (_, i) => ({ id: `AC-${i}`, status: 'pending' }));
    sh('node', [CLI, 'state', 'set', '--json', JSON.stringify({ criteria })], {
      cwd: proj,
      env: { ...process.env, AWL_HOME: home },
    });
    const codes = await runBarrier('commit-start', proj, home);
    const ok = codes.filter((c) => c === 0).length;
    const st = readState(proj);
    const withBaseline = st.__parseError
      ? -1
      : (st.criteria ?? []).filter((c) => typeof c.baseline === 'string').length;
    log(
      `  r${round}: 성공 ${ok}/${N} · baseline 잡힌 criterion ${withBaseline}/${N} · 유효 JSON=${!st.__parseError}`,
    );
  }
  log(
    '  주목: commit --start 는 락이 없다(runStateSet 만 락). 성공했는데 baseline 잡힌 criterion 이 성공 수보다 적으면 lost update.',
  );
}

async function caseRecord() {
  log(`\n## Case C — 동시 record (같은 workitem STRESS, ${N}개)`);
  for (let round = 1; round <= ROUNDS; round++) {
    const { proj, home } = freshProject();
    const codes = await runBarrier('record', proj, home);
    const ok = codes.filter((c) => c === 0).length;
    const { stress, corrupt } = countRecordLines(home);
    log(`  r${round}: 성공 ${ok}/${N} · STRESS 레코드 줄 ${stress} · 깨진 줄 ${corrupt}`);
  }
  log('  기대: 작은 레코드 appendFileSync 는 O_APPEND 원자적 → 깨진 줄 0, 성공 수만큼 레코드.');
}

log(`# 동시성 스트레스 (N=${N} 프로세스, ${ROUNDS} 반복/케이스)  CLI=${CLI}`);
if (!fs.existsSync(CLI)) {
  log('  ! dist/cli.js 가 없습니다 — 먼저 pnpm run build. 중단.');
  process.exit(0);
}
await caseStateSet();
await caseCommitStart();
await caseRecord();
log('\n(관측 도구 — 종료코드 0. 발견 이슈는 stress-concurrency 핸드오프에 재현법·심각도로 기록.)');
