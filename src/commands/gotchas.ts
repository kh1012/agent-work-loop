import { type Caps, caps, makeColors } from '../core/tty.js';
import { type Gotcha, loadGotchaList } from './evolve.js';

/**
 * awl gotchas — 아직 규칙이 되지 않은 교훈 목록 (WI-O — 예전 이름 delta 를 개명함).
 * 0.1.0 에서는 조회만 한다. 생성은 WI-7 의 evolve 가 한다.
 */

/**
 * ~/.awl/gotchas/*.json 을 읽어 목록을 만든다. 없으면 빈 배열.
 * evolve.ts 의 loadGotchaList 를 그대로 재사용한다 — 예전엔 이 파일이 직접
 * fs.readdirSync 를 불러 evolve.ts 의 loadGotchaList 와 파일 읽기 로직이 중복돼
 * 있었는데, 그러면서 evolve.ts 쪽에만 있던 자동 마이그레이션(migrateDeltasToGotchas)
 * 트리거를 이 경로가 못 타는 실제 버그가 생겼다(WI-O AC-05 에서 실제 마이그레이션을
 * 실행하다 발견 — awl gotchas 가 빈 배열만 내놨다). 로직을 하나로 합쳐 재발을 막는다.
 */
export function loadGotchas(): Gotcha[] {
  return loadGotchaList();
}

function renderGotchas(gotchas: Gotcha[], c: Caps): string {
  const color = makeColors(c.color);
  if (gotchas.length === 0) {
    return '\n  교훈이 없습니다.\n';
  }
  const out: string[] = ['', `  교훈 ${gotchas.length}개 (아직 규칙 아님)`, ''];
  for (const g of gotchas) {
    out.push(`  ${color.dim('·')} ${g.lesson || '(요약 없음)'}`);
  }
  return out.join('\n');
}

export function runGotchas(opts: { json?: boolean }): void {
  const gotchas = loadGotchas();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(gotchas, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderGotchas(gotchas, caps())}\n`);
}
