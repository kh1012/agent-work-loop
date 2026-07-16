import { readRecords } from './record.js';
import { resolveProjectRoot } from './config.js';
import { loadState } from './state.js';

/** Gate 2 이후 사람이 CHANGELOG.md에 옮길 수 있는 초안만 출력한다. */
export function runChangelogDraft(opts: { workitem?: string; json?: boolean }): void {
  const root = resolveProjectRoot();
  const current = root ? loadState(root) : {};
  const workitem = opts.workitem ?? (typeof current.workitem === 'string' ? current.workitem : undefined);
  if (!workitem) {
    process.stderr.write('\n  워크아이템을 찾을 수 없습니다. --workitem <id> 를 지정하세요.\n');
    process.exit(1);
  }
  const records = readRecords({ workitem });
  const details = (record: (typeof records)[number]): Record<string, unknown> =>
    record.data && typeof record.data === 'object' ? record.data as Record<string, unknown> : {};
  const gate2 = records.some((r) => {
    const data = details(r);
    return r.type === 'gate' && data.gate === 2 && data.decision === 'approved';
  });
  if (!gate2) {
    process.stderr.write('\n  ⚠️  Gate 2 승인 뒤에만 CHANGELOG 초안을 만듭니다.\n');
    process.exit(1);
  }
  const entries = records
    .filter((r) => ['attempt', 'blocked', 'gotcha', 'decision'].includes(String(r.type)))
    .map((r) => {
      const data = details(r);
      return String(data.what ?? data.lesson ?? data.decision ?? r.type);
    })
    .filter((text) => text && text !== 'undefined');
  const draft = `## [Unreleased]\n\n### 변경\n\n${entries.length ? entries.map((entry) => `- ${entry}`).join('\n') : `- ${workitem} 작업 완료`}\n`;
  process.stdout.write(opts.json ? `${JSON.stringify({ workitem, draft }, null, 2)}\n` : `\n${draft}\n`);
}
