/**
 * ADK 문서(spec/ticket/decision) 프론트매터의 최소 파서/직렬화기.
 *
 * 범용 YAML 이 아니다. 우리가 실제로 쓰는 형태만 다룬다:
 *   key: value
 *   key: [a, b, c]
 *   key: []
 *   key:            (빈 문자열)
 * 중첩 객체·멀티라인 값은 다루지 않는다 — 새 의존성(yaml 파서)을 피하기 위한
 * 의도적 축소다. 필요해지면 그때 라이브러리를 들인다.
 */

export type FrontmatterValue = string | string[];
export type FrontmatterData = Record<string, FrontmatterValue>;

export interface ParsedDoc {
  data: FrontmatterData;
  body: string;
}

function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0];
    const last = raw[raw.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseValue(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return '';
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return inner
      .split(',')
      .map((item) => unquote(item.trim()))
      .filter((item) => item !== '');
  }
  return unquote(trimmed);
}

/**
 * `---` 로 감싼 프론트매터 블록을 파싱한다. 시작 구분자가 없거나 닫는
 * 구분자를 못 찾으면 null(문서가 아니거나 형식이 깨졌다는 뜻 — 호출부가 판단).
 */
export function parseFrontmatter(content: string): ParsedDoc | null {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return null;
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return null;
  }

  const data: FrontmatterData = {};
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') {
      continue;
    }
    const sep = line.indexOf(':');
    if (sep === -1) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    if (key === '') {
      continue;
    }
    data[key] = parseValue(line.slice(sep + 1));
  }

  const body = lines.slice(end + 1).join('\n');
  return { data, body };
}

function serializeValue(value: FrontmatterValue): string {
  if (Array.isArray(value)) {
    return `[${value.join(', ')}]`;
  }
  return value;
}

/** 프론트매터 블록만 직렬화한다(`---`...`---` 포함). 본문은 호출부가 이어붙인다. */
export function serializeFrontmatter(data: FrontmatterData): string {
  const lines = Object.entries(data).map(([key, value]) => `${key}: ${serializeValue(value)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}
