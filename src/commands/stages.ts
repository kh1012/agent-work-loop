import { findProjectRoot } from '../core/paths.js';
import { type Caps, caps, sectionBox, signal } from '../core/tty.js';
import { type AwlProfile, type SkillSlot, loadProfile, skillRefLabel } from './profile.js';

/**
 * `awl stages` — 파이프라인 전체를 출력한다(ADK stage 2, adk-reference.md:1025-1085).
 * "얇게 만들면 스킬 파일만 봐서는 파이프라인이 안 보인다" — 요청 층과 티켓 층을
 * 나눠서 보여주고, 어느 자리가 갈아끼우는 자리(프로파일의 스킬)이고 어느 자리가
 * 내장(기계적이라 갈아낄 게 없음)인지 표시한다. `--short` 는 다섯 단계 이름만.
 *
 * skills 를 실제로 읽어 절차를 갈아끼우는 실행 경로(파이프라인/루프)는 아직 없다
 * (핵심12 "?" 항목) — 이 명령은 그 배선과 무관하게, profile.json 에 적힌 것을
 * 있는 그대로 조립해 보여줄 뿐이다(awl은 판단하지 않는다).
 */

const SHORT_STAGES: { name: string; label: string }[] = [
  { name: 'setup', label: '준비한다' },
  { name: 'spec', label: '스펙을 만든다' },
  { name: 'tickets', label: '티켓을 만든다' },
  { name: 'implement', label: '만들고 검증한다' },
  { name: 'verify', label: '요청을 닫는다' },
];

function skillOf(profile: AwlProfile, slot: SkillSlot): string {
  return skillRefLabel(profile.skills[slot]);
}

export function renderStagesShort(): string {
  return SHORT_STAGES.map((s) => `${s.name.padEnd(10, ' ')}${s.label}`).join('\n');
}

export function renderStagesFull(profile: AwlProfile, c: Caps): string {
  const out: string[] = [];
  out.push('요청 층');
  out.push(`  spec          스펙을 만든다              ${skillOf(profile, 'spec')}`);
  out.push('  tickets       티켓을 만든다              내장(derive)');
  out.push('    [게이트 1]  이 티켓들로 요청이 만족되는가');
  out.push('');
  out.push('  ... 티켓 층 반복 ...');
  out.push('');
  out.push(`  close         요청을 닫는다              ${skillOf(profile, 'close')}`);
  out.push('    [게이트 4]  실제로 만족됐는가');
  out.push('');
  out.push('티켓 층 (티켓마다)');
  out.push(`  investigation 코드를 읽는다              ${skillOf(profile, 'investigation')}`);
  out.push(`  clarification 남은 걸 묻는다              ${skillOf(profile, 'clarification')}`);
  out.push('  design        만들 것을 정한다           내장');
  out.push(`  spike         모르는 걸 판정한다          ${skillOf(profile, 'spike')}`);
  out.push('    [게이트 2]  착수');
  out.push(`  implement     만든다                     ${skillOf(profile, 'implement')}`);
  out.push('  verify        기계가 판정한다             내장');
  out.push(`  review        다른 눈이 본다              ${skillOf(profile, 'review')}`);
  out.push('    [게이트 3]  완료');
  out.push('  record        남긴다                     내장');
  return sectionBox('stages', out, c);
}

export async function runStages(opts: { short?: boolean; json?: boolean } = {}): Promise<void> {
  const c: Caps = caps();
  let projectRoot: string;
  try {
    projectRoot = findProjectRoot();
  } catch (error) {
    process.stderr.write(`\n  ${signal(c, 'error')} ${String(error)}\n`);
    process.exit(1);
    return;
  }

  if (opts.short) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(SHORT_STAGES, null, 2)}\n`);
      return;
    }
    process.stdout.write(`${renderStagesShort()}\n`);
    return;
  }

  const loaded = loadProfile(projectRoot);
  if (!loaded.profile) {
    process.stderr.write(`\n  ${signal(c, 'error')} profile.json 에 문제가 있습니다:\n`);
    for (const e of loaded.errors) {
      process.stderr.write(`    - ${e}\n`);
    }
    process.exit(1);
    return;
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ skills: loaded.profile.skills }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${renderStagesFull(loaded.profile, c)}\n`);
}
