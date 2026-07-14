import fs from 'node:fs';
import path from 'node:path';
import { type Caps, caps, makeColors } from '../core/tty.js';
import { resolveProjectRoot } from './config.js';

/**
 * awl state get / set — .awl/state.json 읽기/쓰기.
 * set 은 부분 갱신을 얕게 병합한다(top-level 키 교체).
 */

export function statePath(projectRoot: string): string {
  return path.join(projectRoot, '.awl', 'state.json');
}

export function loadState(projectRoot: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 부분 갱신을 병합한다. top-level 키를 교체한다(배열/객체는 통째로 대체). */
export function mergeState(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...current, ...patch };
}

export function writeState(projectRoot: string, state: Record<string, unknown>): void {
  const p = statePath(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
}

function requireRoot(): string {
  const root = resolveProjectRoot();
  if (!root) {
    process.stderr.write('\n  프로젝트 루트를 찾을 수 없습니다. awl init 을 실행하세요.\n');
    process.exit(1);
  }
  return root;
}

function renderState(state: Record<string, unknown>, c: Caps): string {
  const color = makeColors(c.color);
  if (Object.keys(state).length === 0) {
    return '\n  상태가 비어 있습니다.\n';
  }
  const out: string[] = ['', '  현재 상태', ''];
  for (const [k, v] of Object.entries(state)) {
    const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
    out.push(`    ${k.padEnd(14, ' ')}${color.dim(val)}`);
  }
  return out.join('\n');
}

export function runStateGet(opts: { json: boolean }): void {
  const state = loadState(requireRoot());
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderState(state, caps())}\n`);
  }
}

export function runStateSet(jsonPatch: string): void {
  const root = requireRoot();
  let patch: unknown;
  try {
    patch = JSON.parse(jsonPatch);
  } catch (e) {
    process.stderr.write(`\n  갱신 JSON 을 읽지 못했습니다: ${String(e)}\n`);
    process.exit(1);
  }
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    process.stderr.write('\n  갱신은 JSON 객체여야 합니다.\n');
    process.exit(1);
  }
  const merged = mergeState(loadState(root), patch as Record<string, unknown>);
  writeState(root, merged);
  process.stdout.write(`${JSON.stringify(merged, null, 2)}\n`);
}
