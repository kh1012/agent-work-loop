import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PROJECT_SKILLS_MANIFEST,
  ProjectSkillsManifestError,
  readProjectSkillsManifest,
} from '../../src/commands/skills.js';

const roots: string[] = [];

function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-skills-'));
  roots.push(root);
  return root;
}

function writeSkill(root: string, source: string, body = '# fixture\n'): void {
  const dir = path.join(root, source);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

function writeManifest(root: string, skills: unknown[]): void {
  const manifest = path.join(root, PROJECT_SKILLS_MANIFEST);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, `${JSON.stringify({ version: 1, skills }, null, 2)}\n`);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('tracked project skill manifest', () => {
  it('중첩 workspace source와 lane-root agent target을 canonical entry로 읽는다', () => {
    const root = project();
    writeSkill(root, 'workspace/packages/page/skills/page-create');
    writeManifest(root, [
      {
        name: 'page-create',
        agent: 'codex',
        source: 'workspace/packages/page/skills/page-create',
        target: '.agents/skills/page-create',
      },
    ]);

    const canonicalRoot = fs.realpathSync(root);
    expect(readProjectSkillsManifest(root)).toEqual([
      {
        name: 'page-create',
        agent: 'codex',
        source: 'workspace/packages/page/skills/page-create',
        canonicalSource: path.join(canonicalRoot, 'workspace/packages/page/skills/page-create'),
        target: '.agents/skills/page-create',
        installTarget: path.join(canonicalRoot, '.agents/skills/page-create'),
      },
    ]);
  });

  it.each([
    {
      label: 'absolute source',
      skills: [
        {
          name: 'page-create',
          agent: 'codex',
          source: '/tmp/page-create',
          target: '.agents/skills/page-create',
        },
      ],
      expected: /source.*relative/i,
    },
    {
      label: 'source traversal',
      skills: [
        {
          name: 'page-create',
          agent: 'codex',
          source: '../page-create',
          target: '.agents/skills/page-create',
        },
      ],
      expected: /source.*traversal/i,
    },
    {
      label: 'target traversal',
      skills: [
        {
          name: 'page-create',
          agent: 'codex',
          source: 'skills/page-create',
          target: '.agents/skills/../../escape',
        },
      ],
      expected: /target.*traversal/i,
    },
    {
      label: 'wrong agent surface',
      skills: [
        {
          name: 'page-create',
          agent: 'codex',
          source: 'skills/page-create',
          target: '.claude/skills/page-create',
        },
      ],
      expected: /target.*codex/i,
    },
  ])('$label을 쓰기 전에 schema error로 거부한다', ({ skills, expected }) => {
    const root = project();
    writeSkill(root, 'skills/page-create');
    writeManifest(root, skills);

    expect(() => readProjectSkillsManifest(root)).toThrow(expected);
  });

  it.each([
    {
      label: 'duplicate name',
      second: {
        name: 'shared',
        agent: 'claude',
        source: 'skills/second',
        target: '.claude/skills/second',
      },
      expected: /duplicate name/i,
    },
    {
      label: 'duplicate target',
      second: {
        name: 'second',
        agent: 'codex',
        source: 'skills/second',
        target: '.agents/skills/shared',
      },
      expected: /duplicate target/i,
    },
  ])('$label을 거부한다', ({ second, expected }) => {
    const root = project();
    writeSkill(root, 'skills/first');
    writeSkill(root, 'skills/second');
    writeManifest(root, [
      {
        name: 'shared',
        agent: 'codex',
        source: 'skills/first',
        target: '.agents/skills/shared',
      },
      second,
    ]);

    expect(() => readProjectSkillsManifest(root)).toThrow(expected);
  });

  it('source SKILL.md가 없으면 manifest path와 entry를 포함한 error를 낸다', () => {
    const root = project();
    fs.mkdirSync(path.join(root, 'skills/page-create'), { recursive: true });
    writeManifest(root, [
      {
        name: 'page-create',
        agent: 'claude',
        source: 'skills/page-create',
        target: '.claude/skills/page-create',
      },
    ]);

    let error: unknown;
    try {
      readProjectSkillsManifest(root);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProjectSkillsManifestError);
    expect(String(error)).toContain(PROJECT_SKILLS_MANIFEST);
    expect(String(error)).toContain('page-create');
    expect(String(error)).toContain('SKILL.md');
  });

  it('manifest가 없으면 선언이 없는 프로젝트로 취급한다', () => {
    expect(readProjectSkillsManifest(project())).toEqual([]);
  });
});
