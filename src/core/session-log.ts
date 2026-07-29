import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code 세션 로그(JSONL) 읽기 전담(ADK stage 5, WI-E — awl tokens 의 기반).
 *
 * awl 은 토큰을 직접 못 센다 — awl 이 가진 건 자기 레코드의 "시각"뿐이고, 실제 usage
 * 숫자는 여기서 읽는다. 세션 로그를 읽는 부분을 이 파일 하나로 몰아둔다 — 외부(Claude
 * Code) 포맷에 의존하므로, 형식이 바뀌면 여기만 고치면 되고 나중에 떼기도 쉽다.
 *
 * 위치: `~/.claude/projects/<맹글된 절대경로>/<세션-uuid>.jsonl`. 맹글링은 절대경로의
 * `/` 를 전부 `-` 로 바꾼 것(실측 확인, 예: `/Users/x/y` → `-Users-x-y`).
 *
 * 한 줄(JSONL)의 실제 shape(실측): `{type:"assistant", timestamp, message:{usage:{
 * input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, ...}}}`.
 * `type!=="assistant"`(user/summary 등)이거나 `message.usage` 가 없는 줄은 토큰
 * 이벤트가 아니다 — 걸러낸다.
 */

export interface SessionUsageEvent {
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** 절대경로를 세션 로그 디렉토리 이름으로 맹글한다(순수 — 슬래시를 대시로). */
export function mangleProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

/** `<projectRoot>` 에 대응하는 세션 로그 디렉토리 경로. */
export function sessionLogDir(projectRoot: string): string {
  return path.join(
    os.homedir(),
    '.claude',
    'projects',
    mangleProjectPath(path.resolve(projectRoot)),
  );
}

function toNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 세션 로그 한 줄을 파싱한다. assistant+usage 가 아니거나 깨졌으면 null(그 줄만 버린다). */
function parseSessionLine(line: string): SessionUsageEvent | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw.type !== 'assistant' || typeof raw.timestamp !== 'string') {
    return null;
  }
  const message = raw.message as Record<string, unknown> | undefined;
  const usage = message?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return {
    timestamp: raw.timestamp,
    inputTokens: toNumber(usage.input_tokens),
    outputTokens: toNumber(usage.output_tokens),
    cacheCreationTokens: toNumber(usage.cache_creation_input_tokens),
    cacheReadTokens: toNumber(usage.cache_read_input_tokens),
  };
}

/**
 * `<projectRoot>` 에 대응하는 세션 로그 디렉토리의 모든 `*.jsonl` 파일에서 usage
 * 이벤트를 뽑아 시각순으로 정렬해 돌려준다. 절대 크래시하지 않는다 — 디렉토리가
 * 없으면 빈 배열, 개별 파일을 못 읽으면 그 파일만 건너뛰고 나머지는 계속, 손상된
 * 줄은 그 줄만 버린다(core/usage.ts 와 같은 관용 원칙).
 */
export function readSessionUsageEvents(projectRoot: string): SessionUsageEvent[] {
  const dir = sessionLogDir(projectRoot);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const events: SessionUsageEvent[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      const event = parseSessionLine(trimmed);
      if (event) {
        events.push(event);
      }
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}
