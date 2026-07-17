import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { rulesDir } from '../core/paths.js';
import { type Caps, caps, card, makeColors, signal } from '../core/tty.js';
import { type Gotcha, acquireLock, loadGotchaList, releaseLock } from './evolve.js';

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
  const out: string[] = [];
  for (const w of warnings) {
    out.push(`${color.yellow('경고')} ${w}`);
  }
  if (warnings.length > 0) {
    out.push('');
  }
  if (rules.length === 0) {
    out.push('적용되는 규칙이 없습니다.');
    out.push('');
    out.push(color.dim('규칙은 작업하다 같은 실패를 두 번 할 때 쌓입니다.'));
    return card('규칙', out, c);
  }
  for (const r of rules) {
    const scope = r.scope ? color.dim(`[${r.scope}]`) : color.dim('[범용]');
    out.push(`${color.bold(r.id)} ${scope}`);
    out.push(`  ${r.body.split('\n')[0] ?? ''}`);
  }
  return card(`규칙 ${rules.length}개`, out, c);
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

// ---------------------------------------------------------------------------
// promote — 교훈을 규칙으로 승격 (사람이 명시적으로 실행)
// ---------------------------------------------------------------------------

/** 활성 규칙의 다음 id(R-001 형식). */
function nextRuleId(): string {
  let max = 0;
  try {
    for (const f of fs.readdirSync(activeRulesDir())) {
      const m = /^R-(\d+)\.md$/.exec(f);
      if (m?.[1]) {
        max = Math.max(max, Number(m[1]));
      }
    }
  } catch {
    // 디렉토리 없으면 0에서 시작.
  }
  return `R-${String(max + 1).padStart(3, '0')}`;
}

/** 규칙 내용을 보고 정적 검사로 만들 수 있으면 검사기와 안내를 돌려준다. */
export function suggestLinter(lesson: string): { rule: string; hint: string } | null {
  const l = lesson.toLowerCase();
  if (/\bany\b/.test(l)) {
    return {
      rule: '@typescript-eslint/no-explicit-any',
      hint: 'eslint 의 @typescript-eslint/no-explicit-any 규칙을 켜세요.',
    };
  }
  if (/ts-ignore|ts-expect-error/.test(l)) {
    return {
      rule: '@typescript-eslint/ban-ts-comment',
      hint: 'eslint 의 @typescript-eslint/ban-ts-comment 규칙을 켜세요.',
    };
  }
  if (/eslint-disable/.test(l)) {
    return {
      rule: 'eslint-comments/no-use',
      hint: 'eslint-comments 플러그인으로 주석 비활성화를 막을 수 있습니다.',
    };
  }
  if (/console\.log/.test(l)) {
    return { rule: 'no-console', hint: 'eslint 의 no-console 규칙을 켜세요.' };
  }
  return null;
}

export const RULE_LOAD_LIMIT = 15;

/** applies/counter 필수 검증. 빠진 필드 이름 배열을 돌려준다(빈 배열=통과). 순수 함수. */
export function validatePromoteOpts(opts: { applies?: string; counter?: string }): string[] {
  const missing: string[] = [];
  if (!opts.applies || opts.applies.trim() === '') {
    missing.push('applies');
  }
  if (!opts.counter || opts.counter.trim() === '') {
    missing.push('counter');
  }
  return missing;
}

/** 규칙 파일 내용(frontmatter + 본문)을 만든다. 쓰기는 안 한다. 순수 함수. */
export function buildRuleFile(
  ruleId: string,
  gotcha: Gotcha,
  createdAt: string,
  opts: { applies: string; counter: string; scope?: string },
): string {
  return [
    '---',
    `id: ${ruleId}`,
    ...(opts.scope ? [`scope: ${opts.scope}`] : []),
    `applies: ${opts.applies}`,
    `counter: ${opts.counter}`,
    'violations: 0',
    `createdAt: ${createdAt}`,
    `source: ${gotcha.id}`,
    '---',
    '',
    gotcha.lesson,
    '',
  ].join('\n');
}

/** 이 프로젝트에 로드되는 규칙이 상한을 넘으면 경고 문구, 아니면 null. 순수 함수. */
export function checkRuleLoadLimit(loadedCount: number): string | null {
  if (loadedCount <= RULE_LOAD_LIMIT) {
    return null;
  }
  return `이 프로젝트에 로드되는 규칙이 ${loadedCount}개입니다(${RULE_LOAD_LIMIT}개 권장). 검사기로 졸업시킬 규칙이 없는지 보세요.`;
}

export function runRulesPromote(
  gotchaId: string,
  opts: { applies?: string; counter?: string; scope?: string },
): void {
  const gotcha = loadGotchaList().find((g) => g.id === gotchaId);
  if (!gotcha) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} 교훈 ${gotchaId} 을(를) 찾을 수 없습니다.\n`,
    );
    process.exit(1);
  }
  // applies/counter 는 필수. 없으면 거부한다(적용 조건 없는 규칙은 다른 프로젝트로 잘못 끌려가고,
  // 반증 조건 없는 규칙은 검증 불가능한 신념이 된다).
  const missing = validatePromoteOpts(opts);
  if (missing.includes('applies')) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} applies(적용 조건)가 필요합니다. --applies "..." 로 주세요.\n  적용 조건 없는 규칙은 다른 프로젝트로 잘못 끌려갑니다.\n`,
    );
    process.exit(1);
  }
  if (missing.includes('counter')) {
    process.stderr.write(
      `\n  ${signal(caps(), 'error')} counter(반증 조건)가 필요합니다. --counter "..." 로 주세요.\n  반증 조건 없는 규칙은 검증 불가능한 신념이 됩니다.\n`,
    );
    process.exit(1);
  }

  const c = caps();
  const color = makeColors(c.color);

  if (!acquireLock()) {
    process.stderr.write(
      `\n  ${signal(c, 'warn')} 다른 evolve/promote 가 실행 중입니다(~/.awl/.lock).\n`,
    );
    process.exit(1);
  }
  try {
    const ruleId = nextRuleId();
    const createdAt = new Date().toISOString().slice(0, 10);
    const front = buildRuleFile(ruleId, gotcha, createdAt, {
      applies: opts.applies as string,
      counter: opts.counter as string,
      scope: opts.scope,
    });
    fs.mkdirSync(activeRulesDir(), { recursive: true });
    fs.writeFileSync(path.join(activeRulesDir(), `${ruleId}.md`), front);
    process.stdout.write(`\n  ${color.green('승격됨')}: ${ruleId}  "${gotcha.lesson}"\n`);

    // 검사기로 만들 수 있으면 안내(졸업이 룰 비대화 방지의 8할이다).
    const linter = suggestLinter(gotcha.lesson);
    if (linter) {
      process.stdout.write('\n  이 규칙은 검사기로 만들 수 있어 보입니다.\n');
      process.stdout.write(
        '  검사기로 만들면 규칙 목록에서 빠지고, awl verify 가 대신 잡아줍니다.\n',
      );
      process.stdout.write(`  ${color.dim(`안내: ${linter.hint}`)}\n`);
    }

    // 이 프로젝트에 로드되는 규칙 수 상한 경고.
    const loaded = filterRules(loadRules().rules, {});
    const warning = checkRuleLoadLimit(loaded.length);
    if (warning) {
      process.stdout.write(`\n  ${color.yellow('경고')}: ${warning}\n`);
    }
  } finally {
    releaseLock();
  }
}
