import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rulesDir } from '../core/paths.js';
import { type Caps, caps, makeColors } from '../core/tty.js';

/**
 * awl rules — ~/.awl/rules/active/*.md 를 읽어 이 프로젝트에 적용되는 규칙을 반환한다.
 * 규칙은 기본적으로 범용이다. 태그(scope)는 좁히는 용도다.
 * applies/counter 는 필수. 반증 조건(counter) 없는 규칙은 검증 불가능한 신념이 된다.
 * 0.1.0 에서는 규칙이 0개다. 그래도 크래시하지 않고 빈 배열을 반환해야 한다.
 */

export interface Rule {
  id: string;
  scope?: string;
  applies: string;
  counter: string;
  violations: number;
  createdAt?: string;
  body: string;
  file: string;
}

export interface RulesLoad {
  rules: Rule[];
  warnings: string[];
}

/** 마크다운 frontmatter 를 파싱한다(yaml 의존성 없이 key: value 만). */
export function parseRuleFile(
  text: string,
  file: string,
): { rule: Rule | null; warnings: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) {
    return { rule: null, warnings: [`${file}: frontmatter 가 없습니다`] };
  }
  const data: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv?.[1]) {
      data[kv[1]] = (kv[2] ?? '').trim();
    }
  }
  const warnings: string[] = [];
  if (!data.id) {
    warnings.push(`${file}: id 없음`);
  }
  if (!data.applies) {
    warnings.push(`${file}: applies 없음 (필수)`);
  }
  if (!data.counter) {
    warnings.push(
      `${file}: counter 없음 (필수 — 반증 조건 없는 규칙은 검증 불가능한 신념이 됩니다)`,
    );
  }
  const rule: Rule = {
    id: data.id ?? path.basename(file, '.md'),
    scope: data.scope || undefined,
    applies: data.applies ?? '',
    counter: data.counter ?? '',
    violations: data.violations ? Number(data.violations) : 0,
    createdAt: data.createdAt,
    body: (m[2] ?? '').trim(),
    file,
  };
  return { rule, warnings };
}

export function activeRulesDir(): string {
  return path.join(rulesDir(), 'active');
}

/** 활성 규칙을 모두 읽는다. 규칙이 없으면 빈 배열. */
export function loadRules(): RulesLoad {
  const dir = activeRulesDir();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return { rules: [], warnings: [] };
  }
  const rules: Rule[] = [];
  const warnings: string[] = [];
  for (const f of files.sort()) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const parsed = parseRuleFile(text, f);
    warnings.push(...parsed.warnings);
    if (parsed.rule) {
      rules.push(parsed.rule);
    }
  }
  return { rules, warnings };
}

/**
 * 이 프로젝트에 적용되는 규칙만 남긴다.
 * - scope 가 지정되면, rule.scope 가 없거나 일치하는 규칙만(무태그는 항상 포함).
 * - character 매칭은 규칙이 쌓이면 정교화한다(0.1.0 은 무태그=항상 포함이 지배).
 */
export function filterRules(rules: Rule[], opts: { scope?: string }): Rule[] {
  return rules.filter((r) => {
    if (opts.scope && r.scope && r.scope !== opts.scope) {
      return false;
    }
    return true;
  });
}

function renderRules(rules: Rule[], warnings: string[], c: Caps): string {
  const color = makeColors(c.color);
  const out: string[] = [''];
  for (const w of warnings) {
    out.push(`  ${color.yellow('경고')} ${w}`);
  }
  if (warnings.length > 0) {
    out.push('');
  }
  if (rules.length === 0) {
    out.push('  적용되는 규칙이 없습니다.');
    out.push('');
    out.push(`  ${color.dim('규칙은 작업하다 같은 실패를 두 번 할 때 쌓입니다.')}`);
    return out.join('\n');
  }
  out.push(`  규칙 ${rules.length}개`);
  out.push('');
  for (const r of rules) {
    const scope = r.scope ? color.dim(`[${r.scope}]`) : color.dim('[범용]');
    out.push(`  ${color.bold(r.id)} ${scope}`);
    out.push(`    ${r.body.split('\n')[0] ?? ''}`);
  }
  return out.join('\n');
}

export function runRules(opts: { scope?: string; json?: boolean; edit?: boolean }): void {
  if (opts.edit) {
    const dir = activeRulesDir();
    fs.mkdirSync(dir, { recursive: true });
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const r = spawnSync(editor, [dir], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
  }

  const { rules, warnings } = loadRules();
  const filtered = filterRules(rules, { scope: opts.scope });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ rules: filtered, warnings }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderRules(filtered, warnings, caps())}\n`);
}
