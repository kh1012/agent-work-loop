import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_SKILLS_MANIFEST,
  ProjectSkillsManifestError,
  readProjectSkillsManifest,
  runSkillsSync,
  syncProjectSkills,
} from '../../src/commands/skills.js';
import { buildProgram } from '../../src/program.js';

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

describe('project skill materialization', () => {
  it('declared targets만 원자 교체하고 unrelated 사용자 스킬은 보존한다', () => {
    const root = project();
    writeSkill(root, 'nested/tracked/page-create', '# page v1\n');
    writeSkill(root, 'nested/tracked/component-create', '# component v1\n');
    fs.writeFileSync(path.join(root, 'nested/tracked/page-create/GUIDE.md'), 'guide v1\n');
    writeManifest(root, [
      {
        name: 'page-create',
        agent: 'codex',
        source: 'nested/tracked/page-create',
        target: '.agents/skills/page-create',
      },
      {
        name: 'component-create',
        agent: 'claude',
        source: 'nested/tracked/component-create',
        target: '.claude/skills/component-create',
      },
    ]);
    writeSkill(root, '.agents/skills/unrelated', '# keep me\n');
    writeSkill(root, '.agents/skills/page-create', '# stale\n');

    const first = syncProjectSkills(root);
    expect(first.map(({ name, status }) => ({ name, status }))).toEqual([
      { name: 'page-create', status: 'installed' },
      { name: 'component-create', status: 'installed' },
    ]);
    expect(fs.readFileSync(path.join(root, '.agents/skills/page-create/SKILL.md'), 'utf8')).toBe(
      '# page v1\n',
    );
    expect(fs.readFileSync(path.join(root, '.agents/skills/page-create/GUIDE.md'), 'utf8')).toBe(
      'guide v1\n',
    );
    expect(fs.readFileSync(path.join(root, '.agents/skills/unrelated/SKILL.md'), 'utf8')).toBe(
      '# keep me\n',
    );
    expect(fs.readdirSync(path.join(root, '.agents/skills'))).not.toContainEqual(
      expect.stringContaining('.awl-sync-'),
    );

    expect(syncProjectSkills(root).map(({ status }) => status)).toEqual(['current', 'current']);

    fs.writeFileSync(path.join(root, 'nested/tracked/page-create/SKILL.md'), '# page v2\n');
    expect(syncProjectSkills(root).map(({ status }) => status)).toEqual(['installed', 'current']);
    expect(fs.readFileSync(path.join(root, '.agents/skills/page-create/SKILL.md'), 'utf8')).toBe(
      '# page v2\n',
    );
    expect(fs.readFileSync(path.join(root, '.agents/skills/unrelated/SKILL.md'), 'utf8')).toBe(
      '# keep me\n',
    );
  });

  it('항목별 JSON 결과에 canonical source, install target, error status를 낸다', () => {
    const root = project();
    writeSkill(root, 'skills/page-create');
    writeManifest(root, [
      {
        name: 'page-create',
        agent: 'codex',
        source: 'skills/page-create',
        target: '.agents/skills/page-create',
      },
    ]);
    fs.writeFileSync(path.join(root, '.agents'), 'blocks directory creation\n');

    const report = syncProjectSkills(root);
    expect(report).toEqual([
      expect.objectContaining({
        name: 'page-create',
        agent: 'codex',
        canonicalSource: fs.realpathSync(path.join(root, 'skills/page-create')),
        installTarget: path.join(fs.realpathSync(root), '.agents/skills/page-create'),
        status: 'error',
        error: expect.any(String),
      }),
    ]);
  });

  it('awl skills sync --json report와 program wiring을 제공한다', () => {
    const root = project();
    writeSkill(root, 'skills/page-create');
    writeManifest(root, [
      {
        name: 'page-create',
        agent: 'codex',
        source: 'skills/page-create',
        target: '.agents/skills/page-create',
      },
    ]);
    const writes: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      expect(runSkillsSync({ json: true }, root)).toMatchObject({ ok: true });
    } finally {
      stdout.mockRestore();
    }

    expect(JSON.parse(writes.join(''))).toMatchObject({
      ok: true,
      manifest: path.join(fs.realpathSync(root), PROJECT_SKILLS_MANIFEST),
      results: [
        {
          name: 'page-create',
          agent: 'codex',
          canonicalSource: fs.realpathSync(path.join(root, 'skills/page-create')),
          installTarget: path.join(fs.realpathSync(root), '.agents/skills/page-create'),
          status: 'installed',
        },
      ],
    });
    expect(buildProgram().commands.find((command) => command.name() === 'skills')).toBeDefined();
  });
});
