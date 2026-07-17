import fs from 'node:fs';
import path from 'node:path';
import { globalRoot } from '../core/paths.js';
import { type Gotcha, nextGotchaId } from './evolve.js';
import { parseRuleFile } from './rules.js';

/**
 * 격리 학습 병합 — --isolated 레인/워크아이템의 학습(gotchas/rules/generations)을
 * teardown(lane rm / work done) 때 전역 ~/.awl 로 멱등 병합한다.
 *
 * 왜 필요한가:
 *   --isolated 는 AWL_HOME 을 로컬 .awl-home 으로 돌린다. records 격리가 의도였지만
 *   globalRoot() 단일 스위치라 gotchas/rules/generations(학습)까지 로컬로 따라간다.
 *   .awl-home 은 gitignored 라 teardown 때 워크트리째 삭제 → 격리 레인이 쌓은 학습이
 *   전역으로 안 이어지고 소멸했다("격리하되 학습은 이음" 위반).
 *
 * 기법 (a) teardown 병합 — (b) always-global-write 는 전역 동시쓰기 락을 전제하는데
 *   그 락 신설은 concurrency(P0) 몫이라, 여기서는 teardown 때 로컬→전역으로 병합만 한다.
 *   records/state 는 병합하지 않는다 — 로컬 격리·폐기 그대로다(병렬 안전 유지).
 *
 * ID 충돌: fresh .awl-home 의 gotcha 는 G-001 부터 매겨져 전역 G-001..G-0NN 과 겹친다.
 *   파일 이름으로 복사하면 전역 교훈을 덮어쓴다 — content(lesson) 로 dedup 하고, 새 교훈은
 *   전역 시퀀스의 새 ID 로 재부여한다. relations/sameAs/rule source 는 그 재ID 로 remap 한다.
 */

/** 생성 시점의 부모 전역 경로를 담는 마커 파일명(.awl-home 루트에 둔다). */
export const PARENT_MARKER = '.awl-parent';

/** 두 gotcha 가 같은 교훈인지 판정하는 키. 같은 lesson = 같은 학습. */
function lessonKey(g: Gotcha): string {
  return (g.lesson ?? '').trim();
}

export interface MergeGotchaResult {
  /** 병합 후 전역 전체 목록(to + 새로 추가된 것). */
  merged: Gotcha[];
  /** 새로 추가된 것만(전역에 쓸 대상). */
  added: Gotcha[];
  /** from 의 원래 id → 전역에서의 최종 id. relations/source remap 에 쓴다. */
  idMap: Record<string, string>;
}

/**
 * 순수 병합 코어. from(격리) 을 to(전역) 에 멱등 병합한다.
 * - 같은 lesson 이 전역에 이미 있으면 건너뛴다(dedup) — idMap 은 그 전역 id 를 가리킨다.
 * - 없으면 전역 시퀀스의 새 id 로 재부여해 추가한다(전역 gotcha 를 덮어쓰지 않는다).
 * - added 의 relations.target/sameAs 는 idMap 으로 remap 한다(from-로컬 id → 전역 id).
 * 입력(from/to)은 변경하지 않는다.
 */
export function mergeGotchaLists(from: Gotcha[], to: Gotcha[]): MergeGotchaResult {
  const merged: Gotcha[] = [...to];
  const added: Gotcha[] = [];
  const idMap: Record<string, string> = {};
  const byLesson = new Map<string, Gotcha>();
  for (const g of to) {
    byLesson.set(lessonKey(g), g);
  }
  // id 순으로 결정적 처리 — 재부여가 안정적이게.
  const fromSorted = [...from].sort((a, b) => a.id.localeCompare(b.id));
  for (const g of fromSorted) {
    const key = lessonKey(g);
    const dup = byLesson.get(key);
    if (dup) {
      idMap[g.id] = dup.id; // 이미 전역에 있음 — 멱등 skip.
      continue;
    }
    const newId = nextGotchaId(merged); // 커지는 merged 기준 max+1.
    idMap[g.id] = newId;
    const shell: Gotcha = { ...g, id: newId };
    merged.push(shell);
    byLesson.set(key, shell);
    added.push(shell);
  }
  // 추가분의 참조를 remap — target/sameAs 가 from-로컬 id 면 전역 id 로.
  for (const g of added) {
    if (g.relations) {
      g.relations = g.relations.map((r) => ({ ...r, target: idMap[r.target] ?? r.target }));
    }
    if (g.sameAs) {
      g.sameAs = idMap[g.sameAs] ?? g.sameAs;
    }
  }
  return { merged, added, idMap };
}

/** root/gotchas/*.json 을 읽는다(마이그레이션·env 무관, 임의 루트 대상). 없으면 빈 배열. */
function readGotchasFrom(root: string): Gotcha[] {
  const dir = path.join(root, 'gotchas');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Gotcha[] = [];
  for (const f of files.sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Gotcha);
    } catch {
      // 깨진 파일은 건너뛴다(loadGotchaList 와 같은 원칙).
    }
  }
  return out;
}

interface RawRule {
  text: string;
  body: string;
}

/** root/rules/active/*.md 를 원문+본문으로 읽는다. 없으면 빈 배열. */
function readRulesFrom(root: string): RawRule[] {
  const dir = path.join(root, 'rules', 'active');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
  const out: RawRule[] = [];
  for (const f of files.sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseRuleFile(text, f);
    if (parsed.rule) {
      out.push({ text, body: parsed.rule.body });
    }
  }
  return out;
}

/** 규칙 파일 목록에서 다음 R-0XX 번호. */
function nextRuleNum(fileNames: string[]): number {
  let max = 0;
  for (const f of fileNames) {
    const m = /^R-(\d+)\.md$/.exec(f);
    if (m?.[1]) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

/**
 * 규칙 병합: 본문(body=lesson) 으로 dedup, 새 규칙은 전역 시퀀스의 새 id 로 재부여하고
 * frontmatter 의 id/source 를 다시 쓴다(source 는 gotcha idMap 으로 remap). 추가한 수를 낸다.
 */
function mergeRules(fromRoot: string, toRoot: string, idMap: Record<string, string>): number {
  const fromRules = readRulesFrom(fromRoot);
  if (fromRules.length === 0) {
    return 0;
  }
  const toActive = path.join(toRoot, 'rules', 'active');
  const toRules = readRulesFrom(toRoot);
  const toBodies = new Set(toRules.map((r) => r.body.trim()));
  let toFiles: string[] = [];
  try {
    toFiles = fs.readdirSync(toActive).filter((f) => f.endsWith('.md'));
  } catch {
    // 전역에 규칙 폴더가 아직 없음 — 0에서 시작.
  }
  let ruleNum = nextRuleNum(toFiles);
  let added = 0;
  for (const r of fromRules) {
    if (toBodies.has(r.body.trim())) {
      continue; // 같은 규칙 이미 전역에 있음 — 멱등 skip.
    }
    const newId = `R-${String(ruleNum).padStart(3, '0')}`;
    ruleNum += 1;
    const rewritten = r.text
      .replace(/^id:[ \t]*.*$/m, `id: ${newId}`)
      .replace(
        /^source:[ \t]*(\S+)(.*)$/m,
        (_m, src: string, rest: string) => `source: ${idMap[src] ?? src}${rest}`,
      );
    fs.mkdirSync(toActive, { recursive: true });
    fs.writeFileSync(path.join(toActive, `${newId}.md`), rewritten);
    toBodies.add(r.body.trim());
    added += 1;
  }
  return added;
}

/** fromRoot/generations 하위 파일을 toRoot 로 copy-if-absent(고유 파일명이라 충돌 없음). 복사 수를 낸다. */
function copyGenerations(fromRoot: string, toRoot: string): number {
  const fromGen = path.join(fromRoot, 'generations');
  if (!fs.existsSync(fromGen)) {
    return 0;
  }
  let copied = 0;
  const walk = (rel: string): void => {
    const abs = path.join(fromGen, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile()) {
        const dest = path.join(toRoot, 'generations', childRel);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(path.join(fromGen, childRel), dest);
          copied += 1;
        }
      }
    }
  };
  walk('.');
  return copied;
}

export interface MergeLearningResult {
  gotchasAdded: number;
  rulesAdded: number;
  generationsAdded: number;
}

/**
 * fromRoot(격리 home) 의 학습을 toRoot(전역) 로 멱등 병합한다. gotchas/rules/generations 만
 * 대상 — records/state 는 안 건드린다(격리 유지). 부작용은 toRoot 아래 쓰기뿐.
 */
export function mergeIsolatedLearning(fromRoot: string, toRoot: string): MergeLearningResult {
  const fromGotchas = readGotchasFrom(fromRoot);
  const toGotchas = readGotchasFrom(toRoot);
  const { added, idMap } = mergeGotchaLists(fromGotchas, toGotchas);
  if (added.length > 0) {
    const dir = path.join(toRoot, 'gotchas');
    fs.mkdirSync(dir, { recursive: true });
    for (const g of added) {
      fs.writeFileSync(path.join(dir, `${g.id}.json`), `${JSON.stringify(g, null, 2)}\n`);
    }
  }
  const rulesAdded = mergeRules(fromRoot, toRoot, idMap);
  const generationsAdded = copyGenerations(fromRoot, toRoot);
  return { gotchasAdded: added.length, rulesAdded, generationsAdded };
}

/**
 * 생성 시점의 부모 전역 경로를 격리 home 에 마커로 남긴다. teardown 이 이 값을 목적지로 읽어,
 * teardown 시점의 AWL_HOME env 에 의존하지 않고 견고하게 전역으로 병합한다.
 * 부작용 실패는 치명적이지 않다(teardown 이 globalRoot() 로 폴백) — best-effort.
 */
export function writeParentMarker(isolatedHome: string): void {
  try {
    fs.writeFileSync(path.join(isolatedHome, PARENT_MARKER), `${globalRoot()}\n`);
  } catch {
    // best-effort: 마커 실패해도 생성은 진행. teardown 은 globalRoot() 로 폴백한다.
  }
}

/** 격리 home 의 마커에서 부모 전역 경로를 읽는다. 없으면 현재 globalRoot() 로 폴백. */
function resolveParentGlobal(isolatedHome: string): string {
  try {
    const raw = fs.readFileSync(path.join(isolatedHome, PARENT_MARKER), 'utf8').trim();
    if (raw !== '') {
      return path.resolve(raw);
    }
  } catch {
    // 마커 없음 — 폴백.
  }
  return globalRoot();
}

/**
 * teardown 진입점 — 격리 home 의 학습을 전역으로 병합한다. 워크트리 삭제 전에 호출한다.
 * 병합할 게 없거나(격리 home 부재) 출발=목적(같은 store)이면 null(할 일 없음).
 */
export function mergeIsolatedHome(isolatedHome: string): MergeLearningResult | null {
  if (!fs.existsSync(isolatedHome)) {
    return null;
  }
  const toRoot = resolveParentGlobal(isolatedHome);
  if (path.resolve(isolatedHome) === path.resolve(toRoot)) {
    return null; // 격리 home 이 곧 전역 — 자기 자신으로의 병합은 무의미.
  }
  return mergeIsolatedLearning(isolatedHome, toRoot);
}
