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

/**
 * 워크아이템 레지스트리(workitems) 필드가 있는지 보장한다(WI-D).
 *
 * 최상위 workitem/phase/loop/criteria 는 건드리지 않는다 — 계속 "현재 워크아이템의
 * 실시간 뷰"다(status.ts/commit.ts/review.ts/evolve.ts/record.ts 가 그대로 읽는다).
 * "현재 워크아이템을 레지스트리에 보관"하는 일은 이 함수가 아니라 work.ts 의
 * new/switch 가 전환 시점에 한다 — 그래서 이 함수는 workitems 필드가 없을 때
 * 빈 객체로 채우기만 하면 된다. 순수 함수, 멱등(이미 있으면 그대로 반환).
 */
export function migrateState(raw: Record<string, unknown>): Record<string, unknown> {
  if ('workitems' in raw) {
    return raw;
  }
  return { ...raw, workitems: {} };
}

export function loadState(projectRoot: string): Record<string, unknown> {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(projectRoot), 'utf8')) as Record<
      string,
      unknown
    >;
    return migrateState(raw);
  } catch {
    return {};
  }
}

/**
 * 부분 갱신을 병합한다. top-level 키는 교체하되, criteria 배열만은 id 기준으로
 * 병합한다. criteria 를 통째로 교체하면 baseline 같은 기존 필드가 날아가기 때문이다
 * (WI-7 에서 고친 버그). criteria 이외의 배열/객체는 여전히 통째로 대체한다.
 */
export function mergeState(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...current, ...patch };
  if (Array.isArray(patch.criteria)) {
    let acc: Record<string, unknown> = { ...current };
    for (const c of patch.criteria as Record<string, unknown>[]) {
      if (c && typeof c.id === 'string') {
        acc = setCriterion(acc, c.id, c);
      }
    }
    merged.criteria = acc.criteria;
  }
  return merged;
}

/** state.criteria 에서 id 로 완료 조건을 찾는다. */
export function getCriterion(
  state: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  const criteria = Array.isArray(state.criteria)
    ? (state.criteria as Record<string, unknown>[])
    : [];
  return criteria.find((c) => c.id === id);
}

/**
 * 완료 조건 하나를 갱신한다(없으면 추가). criteria 배열만 바꾸고 나머지는 보존한다.
 * baseline/attempts/proceduralErrors 같은 필드를 여기로 병합한다.
 */
export function setCriterion(
  state: Record<string, unknown>,
  id: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const criteria = Array.isArray(state.criteria)
    ? [...(state.criteria as Record<string, unknown>[])]
    : [];
  const idx = criteria.findIndex((c) => c.id === id);
  if (idx >= 0) {
    criteria[idx] = { ...criteria[idx], ...patch };
  } else {
    criteria.push({ id, ...patch });
  }
  return { ...state, criteria };
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
