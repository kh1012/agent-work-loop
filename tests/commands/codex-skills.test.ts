import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(process.cwd(), 'engine', 'skills', 'codex');
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

describe('Codex AWL skills', () => {
  it('loop + pipeline 역할 5개가 각각 유효한 repo skill 골격을 가진다', () => {
    for (const name of skillNames) {
      const skill = read(`${name}/SKILL.md`);
      expect(skill).toMatch(new RegExp(`^---\\nname: ${name}\\ndescription: [\\s\\S]+?\\n---`));
      expect(fs.existsSync(path.join(root, name, 'agents', 'openai.yaml'))).toBe(true);
      expect(read(`${name}/agents/openai.yaml`)).toContain(`$${name}`);
    }
  });

  it('Codex 문서에 Claude 전용 도구·설치 경로·스케줄 폴링이 남아있지 않다', () => {
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

  it('오케스트레이터는 Codex 멀티에이전트 생명주기와 single-writer 계약을 명시한다', () => {
    const pipeline = read('awl-pipeline/SKILL.md');
    for (const tool of ['spawn_agent', 'wait_agent', 'followup_task', 'list_agents']) {
      expect(pipeline).toContain(tool);
    }
    expect(pipeline).toContain('one writer');
    expect(pipeline).toContain('Do not ask role agents to spawn their own agents');
  });

  it('AGENTS 블록은 긴 워크플로우 복제 대신 실제 스킬로 라우팅한다', () => {
    const agents = read('AGENTS.awl.md');
    expect(agents).toContain('$awl-loop');
    expect(agents).toContain('$awl-pipeline');
    expect(agents.split('\n').length).toBeLessThan(20);
  });

  it('CLI 시작/스킬 도움말도 Codex의 $ 트리거를 노출한다', () => {
    const program = fs.readFileSync(path.join(process.cwd(), 'src', 'program.ts'), 'utf8');
    expect(program).toContain('$awl-loop');
    expect(program).toContain('$awl-pipeline');
    expect(program).toContain('wait_agent');
    expect(program).toContain('followup_task');
  });
});
