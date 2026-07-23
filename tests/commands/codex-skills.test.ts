import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(process.cwd(), 'engine', 'skills', 'codex');
const claudeLoopPath = path.join(
  process.cwd(),
  'engine',
  'skills',
  'claude',
  'awl-loop',
  'SKILL.md',
);
const skillNames = [
  'awl-loop',
  'awl-pipeline',
  'awl-pipeline-exec',
  'awl-pipeline-plan',
  'awl-pipeline-review',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function frontmatterDescription(skill: string): string {
  const match = skill.match(/^---\n[\s\S]*?\ndescription: (?:>-|\|)\n([\s\S]*?)\n---/);
  const description = match?.[1];
  if (!description) throw new Error('SKILL.md frontmatter description을 찾지 못했습니다.');
  return description.replace(/\s+/g, ' ').trim();
}

function triggerExamples(description: string): { excluded: string[]; included: string[] } {
  const includeMarker = 'AUTO-INCLUDE-AFTER-EXCLUSIONS';
  const includeAt = description.indexOf(includeMarker);
  if (includeAt < 0) throw new Error(`${includeMarker}가 없습니다.`);
  const quoted = (value: string): string[] =>
    [...value.matchAll(/"([^"]+)"/g)]
      .map((match) => match[1])
      .filter((example): example is string => example !== undefined);
  return {
    excluded: quoted(description.slice(0, includeAt)),
    included: quoted(description.slice(includeAt)),
  };
}

function triggerDecision(
  description: string,
  prompt: string,
  explicitInvocation: string,
): 'trigger' | 'skip' {
  if (prompt.includes(explicitInvocation)) return 'trigger';
  const examples = triggerExamples(description);
  if (examples.excluded.includes(prompt)) return 'skip';
  if (examples.included.includes(prompt)) return 'trigger';
  throw new Error(`발동 계약에 고정되지 않은 테스트 문장입니다: ${prompt}`);
}

function commandBoundary(description: string): {
  preSelection: string;
  postSelectionFirst: string;
  otherSkillOnlyVersionCheck: string;
} {
  const preSelection = description.match(/PRE-SELECTION-AWL=([^;]+);/)?.[1];
  const postSelectionFirst = description.match(/POST-SELECTION-FIRST-AWL=([^;]+);/)?.[1];
  const otherSkillOnlyVersionCheck = description.match(
    /OTHER-SKILL-ONLY-AWL-VERSION-CHECK=([^.;]+)[.;]/,
  )?.[1];
  if (!preSelection || !postSelectionFirst || !otherSkillOnlyVersionCheck) {
    throw new Error('awl 명령 실행 경계를 찾지 못했습니다.');
  }
  return { preSelection, postSelectionFirst, otherSkillOnlyVersionCheck };
}

describe('Codex AWL skills', () => {
  it('loop + pipeline 역할 5개가 각각 유효한 repo skill 골격을 가진다', () => {
    for (const name of skillNames) {
      const skill = read(`${name}/SKILL.md`);
      expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: [\\s\\S]+?\\n---`));
      expect(fs.existsSync(path.join(root, name, 'agents', 'openai.yaml'))).toBe(true);
      const metadata = read(`${name}/agents/openai.yaml`);
      expect(metadata).toContain(`$${name}`);
      const shortDescription = metadata.match(/short_description: "(.+)"/)?.[1] ?? '';
      expect([...shortDescription].length).toBeGreaterThanOrEqual(25);
      expect([...shortDescription].length).toBeLessThanOrEqual(64);
    }
  });

  it('Pipeline UI 설명과 본문이 lane/mode 호출 계약과 대표 예시를 바로 노출한다', () => {
    const metadata = read('awl-pipeline/agents/openai.yaml');
    const pipeline = read('awl-pipeline/SKILL.md');
    for (const token of ['<lane명>', '<mode>', '--gh', '--gm', '--gl']) {
      expect(metadata).toContain(token);
      expect(pipeline).toContain(token);
    }
    expect(pipeline).toContain('$awl-pipeline design-tokens --gh');
    expect(pipeline).toContain('$awl-pipeline --gm');
    expect(pipeline).toContain('$awl-pipeline . --gl');
  });

  it('Codex pipeline은 선택적 --poll interval과 30분 대표 예시를 노출한다', () => {
    const metadata = read('awl-pipeline/agents/openai.yaml');
    const pipeline = read('awl-pipeline/SKILL.md');

    expect(metadata).toContain('--poll <interval>');
    expect(metadata).toContain('--poll 30m');
    expect(pipeline).toContain('--poll <interval>');
    expect(pipeline).toContain('$awl-pipeline feedback-loop --gl --poll 30m');
    expect(pipeline).toContain('Parse `--poll <interval>` before lane and mode');
    expect(pipeline).toContain('natural-language cadence');
  });

  it('Codex pipeline은 native current-chat Scheduled lifecycle과 안전한 fallback을 명시한다', () => {
    const pipeline = read('awl-pipeline/SKILL.md');
    const normalized = pipeline.replace(/\s+/g, ' ');

    for (const contract of [
      'Native Scheduled task lifecycle',
      'current chat',
      'exact requested cadence',
      'confirmed schedule result',
      'absolute lane path',
      'gate mode',
      'awl status --pipeline',
      'plan/exec/review',
      'Never push',
      'does not reschedule itself',
      'stop polling',
    ]) {
      expect(pipeline).toContain(contract);
    }
    expect(normalized).toContain(
      'Never emulate polling with an active goal, `sleep`, a shell watcher, cron, or `codex exec resume`.',
    );
    expect(pipeline).toContain('Scheduled capability is unavailable');
  });

  it('Codex와 Claude pipeline bootstrap은 absolute lane 재개와 missing config 초기화 순서를 고정한다', () => {
    const codex = read('awl-pipeline/SKILL.md');
    const claude = fs.readFileSync(
      path.join(process.cwd(), 'engine', 'skills', 'claude', 'awl-pipeline', 'SKILL.md'),
      'utf8',
    );

    for (const skill of [codex, claude]) {
      expect(skill).toContain('absolute-lane-resume');
      expect(skill).toContain('.awl/config.json');
      expect(skill).toContain('awl init --yes');
      expect(skill.indexOf('absolute-lane-resume')).toBeLessThan(skill.indexOf('awl doctor'));
    }
  });

  it('Codex 문서에 Claude 전용 도구·설치 경로가 남아있지 않다', () => {
    const all = skillNames.map((name) => read(`${name}/SKILL.md`)).join('\n');
    for (const stale of [
      '.claude/skills',
      'AskUserQuestion',
      'ScheduleWakeup',
      'CronCreate',
      'ToolSearch',
      'TaskStop',
      'SendMessage',
      'Skill(',
      '/loop',
    ]) {
      expect(all).not.toContain(stale);
    }
  });

  it('native Scheduled만 idle polling으로 허용하고 비관리형 timer 구현은 거부한다', () => {
    const pipeline = read('awl-pipeline/SKILL.md');
    const normalized = pipeline.replace(/\s+/g, ' ');

    expect(normalized).toContain(
      'The native Scheduled task is the only supported idle polling mechanism.',
    );
    expect(normalized).toContain(
      'Never emulate polling with an active goal, `sleep`, a shell watcher, cron, or `codex exec resume`.',
    );
    for (const unmanaged of ['setTimeout(', 'setInterval(', 'while true', 'sleep 1800']) {
      expect(pipeline).not.toContain(unmanaged);
    }
    expect(pipeline.match(/`codex exec resume`/g)).toHaveLength(1);
  });

  it('오케스트레이터는 Codex 멀티에이전트 생명주기와 single-writer 계약을 명시한다', () => {
    const pipeline = read('awl-pipeline/SKILL.md');
    for (const tool of ['spawn_agent', 'wait_agent', 'followup_task', 'list_agents']) {
      expect(pipeline).toContain(tool);
    }
    expect(pipeline).toContain('one writer');
    expect(pipeline).toContain('Do not ask role agents to spawn their own agents');
  });

  it('Codex와 Claude pipeline은 coordinator만 gate record를 소유한다', () => {
    const surfaces = ['codex', 'claude'].map((surface) => {
      const base = path.join(process.cwd(), 'engine', 'skills', surface);
      return {
        coordinator: fs.readFileSync(path.join(base, 'awl-pipeline', 'SKILL.md'), 'utf8'),
        exec: fs.readFileSync(path.join(base, 'awl-pipeline-exec', 'SKILL.md'), 'utf8'),
        loop: fs.readFileSync(path.join(base, 'awl-loop', 'SKILL.md'), 'utf8'),
      };
    });

    for (const { coordinator, exec, loop } of surfaces) {
      expect(coordinator).toContain('pipeline-gate-owner: coordinator');
      expect(exec).toContain('pipeline-gate-recorder: coordinator-only');
      expect(loop).toContain('pipeline-gate-recorder: coordinator-only');
      expect(exec).not.toMatch(/awl record gate/);
    }
  });

  it('자동 pipeline gate는 plan과 독립 review evidence를 붙여 각각 한 번 기록한다', () => {
    const coordinators = ['codex', 'claude'].map((surface) =>
      fs.readFileSync(
        path.join(process.cwd(), 'engine', 'skills', surface, 'awl-pipeline', 'SKILL.md'),
        'utf8',
      ),
    );

    for (const coordinator of coordinators) {
      expect(coordinator.match(/automatic-gate-1: auto=true; evidence=plan/g)).toHaveLength(1);
      expect(
        coordinator.match(
          /automatic-gate-2: auto=true; evidence=implementation-handoff\+independent-review/g,
        ),
      ).toHaveLength(1);
      expect(coordinator).toContain('"actor":"coordinator"');
      expect(coordinator).toContain('"source":"pipeline-mode"');
      expect(coordinator).toContain('"plan"');
      expect(coordinator).toContain('"implementationHandoff"');
      expect(coordinator).toContain('"independentReview"');
    }
  });

  it('gate-low/medium은 coordinator 단일 record에 auto와 단계별 evidence를 보존한다', () => {
    const surfaces = ['codex', 'claude'].map((surface) => {
      const base = path.join(process.cwd(), 'engine', 'skills', surface);
      return {
        coordinator: fs.readFileSync(path.join(base, 'awl-pipeline', 'SKILL.md'), 'utf8'),
        exec: fs.readFileSync(path.join(base, 'awl-pipeline-exec', 'SKILL.md'), 'utf8'),
      };
    });

    for (const { coordinator, exec } of surfaces) {
      const contract =
        'pipeline-auto-gate-records: gate1=once(auto:true,plan-evidence); gate2=once(auto:true,exec+review-evidence)';
      expect(coordinator.match(new RegExp(contract.replace(/[+()]/g, '\\$&'), 'g'))).toHaveLength(
        1,
      );
      expect(coordinator).toMatch(/gate-medium[\s\S]*gate-low/);
      expect(exec).toContain('## Gate evidence');
      expect(exec).toContain('gate 1:');
      expect(exec).toContain('gate 2: pending coordinator');
    }
  });

  it('gate-high human decision은 auto로 오표기하지 않고 independent review 뒤 coordinator가 기록한다', () => {
    const coordinators = ['codex', 'claude'].map((surface) =>
      fs.readFileSync(
        path.join(process.cwd(), 'engine', 'skills', surface, 'awl-pipeline', 'SKILL.md'),
        'utf8',
      ),
    );

    for (const coordinator of coordinators) {
      expect(
        coordinator.match(/human-gate-1: auto=false; evidence=human-decision\+plan/g),
      ).toHaveLength(1);
      expect(
        coordinator.match(/human-gate-2: auto=false; evidence=human-decision\+independent-review/g),
      ).toHaveLength(1);
      expect(coordinator).toContain('"auto":false');
      expect(coordinator).toContain('"source":"human-decision"');
      expect(coordinator.indexOf('fresh independent review')).toBeLessThan(
        coordinator.indexOf('human-gate-2:'),
      );
    }
  });

  it('AGENTS 블록은 긴 워크플로우 복제 대신 실제 스킬로 라우팅한다', () => {
    const agents = read('AGENTS.awl.md');
    expect(agents).toContain('$awl-loop');
    expect(agents).toContain('$awl-pipeline');
    expect(agents.indexOf('AUTO-EXCLUDE-FIRST')).toBeLessThan(
      agents.indexOf('AUTO-INCLUDE-AFTER-EXCLUSIONS'),
    );
    expect(agents).toContain('PRE-SELECTION-AWL=none');
    expect(agents).toContain('POST-SELECTION-FIRST-AWL=awl version-check --json');
    expect(agents).toContain('OTHER-SKILL-ONLY-AWL-VERSION-CHECK=forbidden');
    expect(agents.split('\n').length).toBeLessThan(20);
  });

  it('CLI 시작/스킬 도움말도 Codex의 $ 트리거를 노출한다', () => {
    const program = fs.readFileSync(path.join(process.cwd(), 'src', 'program.ts'), 'utf8');
    expect(program).toContain('$awl-loop');
    expect(program).toContain('$awl-pipeline');
    expect(program).toContain('wait_agent');
    expect(program).toContain('followup_task');
  });

  it('공개 README·template·프레젠테이션이 --poll 계약을 함께 노출한다', () => {
    const docs = [
      fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8'),
      read('awl-pipeline/templates/README.md'),
      fs.readFileSync(path.join(process.cwd(), 'docs', 'presentation', 'commands.md'), 'utf8'),
    ];

    for (const doc of docs.map((value) => value.replace(/\s+/g, ' '))) {
      expect(doc).toContain('--poll <interval>');
      expect(doc).toContain('--poll 30m');
      expect(doc).toContain('native Scheduled');
    }
    expect(docs.join('\n')).toContain('Scheduled capability');
  });
});

describe('awl-loop 자동 발동 계약', () => {
  const codexDescription = frontmatterDescription(read('awl-loop/SKILL.md'));
  const claudeDescription = frontmatterDescription(fs.readFileSync(claudeLoopPath, 'utf8'));
  const targets = [
    { name: 'Codex', description: codexDescription, explicitInvocation: '$awl-loop' },
    { name: 'Claude', description: claudeDescription, explicitInvocation: '/awl-loop' },
  ];

  it.each(targets)('$name: 명시적 호출은 항상 발동한다', ({ description, explicitInvocation }) => {
    expect(
      triggerDecision(
        description,
        `${explicitInvocation} 이 버튼의 radius만 바꿔줘`,
        explicitInvocation,
      ),
    ).toBe('trigger');
  });

  it.each(targets)(
    '$name: 좁고 구체적인 radius 변경은 자동 발동하지 않는다',
    ({ description, explicitInvocation }) => {
      expect(
        triggerDecision(
          description,
          'Dialog에 pilled radius를 적용하고 내부 영역도 동일하게 바꿔줘',
          explicitInvocation,
        ),
      ).toBe('skip');
    },
  );

  it.each(targets)(
    '$name: 단순 문구 변경은 자동 발동하지 않는다',
    ({ description, explicitInvocation }) => {
      expect(triggerDecision(description, "레이블을 '저장'으로 바꿔줘", explicitInvocation)).toBe(
        'skip',
      );
    },
  );

  it.each(targets)(
    '$name: 완료 기준 없는 비단순 기능 구현은 자동 발동한다',
    ({ description, explicitInvocation }) => {
      expect(
        triggerDecision(description, '이 편집기에 자동 저장 기능을 구현해줘', explicitInvocation),
      ).toBe('trigger');
    },
  );

  it.each(targets)(
    '$name: 원인과 범위가 불명확한 복합 버그 수정은 자동 발동한다',
    ({ description, explicitInvocation }) => {
      expect(
        triggerDecision(
          description,
          '간헐적으로 저장이 실패하는데 원인과 수정 범위를 찾아 고쳐줘',
          explicitInvocation,
        ),
      ).toBe('trigger');
    },
  );

  it.each(targets)(
    '$name: 제외 조건이 긍정 트리거보다 먼저이고 미발동 시 awl 명령은 0개다',
    ({ description, explicitInvocation }) => {
      expect(description.indexOf('AUTO-EXCLUDE-FIRST')).toBeLessThan(
        description.indexOf('AUTO-INCLUDE-AFTER-EXCLUSIONS'),
      );
      const decision = triggerDecision(
        description,
        '이 버튼의 rounded-md를 rounded-full로 바꿔줘',
        explicitInvocation,
      );
      const boundary = commandBoundary(description);
      const commands = decision === 'trigger' ? [boundary.postSelectionFirst] : [];

      expect(decision).toBe('skip');
      expect(boundary).toEqual({
        preSelection: 'none',
        postSelectionFirst: 'awl version-check --json',
        otherSkillOnlyVersionCheck: 'forbidden',
      });
      expect(commands).toEqual([]);
    },
  );

  it('Codex와 Claude는 같은 자동 발동 예시 집합을 가진다', () => {
    expect(triggerExamples(codexDescription)).toEqual(triggerExamples(claudeDescription));
  });
});
