import fs from 'node:fs';
import path from 'node:path';
import { deltasDir } from '../core/paths.js';
import { type Caps, caps, makeColors } from '../core/tty.js';

/**
 * awl deltas — 아직 규칙이 되지 않은 교훈 목록.
 * 0.1.0 에서는 조회만 한다. 생성은 WI-7 의 evolve 가 한다.
 */

/** ~/.awl/deltas/*.json 을 읽어 목록을 만든다. 없으면 빈 배열. */
export function loadDeltas(): Record<string, unknown>[] {
  const dir = deltasDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const f of files.sort()) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>);
    } catch {
      // 깨진 파일은 건너뛴다.
    }
  }
  return out;
}

function renderDeltas(deltas: Record<string, unknown>[], c: Caps): string {
  const color = makeColors(c.color);
  if (deltas.length === 0) {
    return '\n  교훈이 없습니다.\n';
  }
  const out: string[] = ['', `  교훈 ${deltas.length}개 (아직 규칙 아님)`, ''];
  for (const d of deltas) {
    const summary = d.lesson ?? d.what ?? '(요약 없음)';
    out.push(`  ${color.dim('·')} ${String(summary)}`);
  }
  return out.join('\n');
}

export function runDeltas(opts: { json?: boolean }): void {
  const deltas = loadDeltas();
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(deltas, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderDeltas(deltas, caps())}\n`);
}
