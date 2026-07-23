import fs from 'node:fs';
import path from 'node:path';

export const PROJECT_SKILLS_MANIFEST = '.awl/skills.json';

export type ProjectSkillAgent = 'codex' | 'claude';

export interface ProjectSkillEntry {
  name: string;
  agent: ProjectSkillAgent;
  source: string;
  canonicalSource: string;
  target: string;
  installTarget: string;
}

export class ProjectSkillsManifestError extends Error {
  constructor(message: string) {
    super(`${PROJECT_SKILLS_MANIFEST}: ${message}`);
    this.name = 'ProjectSkillsManifestError';
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectSkillsManifestError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(entry: Record<string, unknown>, field: string, index: number): string {
  const value = entry[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProjectSkillsManifestError(`skills[${index}].${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizedRelative(value: string, label: string): string {
  const portable = value.replaceAll('\\', '/');
  if (
    path.isAbsolute(value) ||
    portable.startsWith('/') ||
    /^[A-Za-z]:\//.test(portable) ||
    portable.startsWith('//')
  ) {
    throw new ProjectSkillsManifestError(`${label} must be repository-relative`);
  }
  const segments = portable.split('/');
  if (segments.includes('..')) {
    throw new ProjectSkillsManifestError(`${label} must not contain traversal (..)`);
  }
  const normalized = path.posix.normalize(portable);
  if (normalized === '.' || normalized === '') {
    throw new ProjectSkillsManifestError(`${label} must name a path`);
  }
  return normalized;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..');
}

function expectedSurface(agent: ProjectSkillAgent): string {
  return agent === 'codex' ? '.agents/skills' : '.claude/skills';
}

/**
 * Read and validate the tracked project-skill manifest. Validation completes for every entry
 * before callers can begin materialization.
 */
export function readProjectSkillsManifest(projectRoot: string): ProjectSkillEntry[] {
  const manifestPath = path.join(projectRoot, PROJECT_SKILLS_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new ProjectSkillsManifestError(`invalid JSON: ${String(error)}`);
  }

  const manifest = asObject(parsed, 'manifest');
  if (manifest.version !== 1) {
    throw new ProjectSkillsManifestError('version must be 1');
  }
  if (!Array.isArray(manifest.skills)) {
    throw new ProjectSkillsManifestError('skills must be an array');
  }

  const canonicalRoot = fs.realpathSync(projectRoot);
  const names = new Set<string>();
  const targets = new Set<string>();
  const entries: ProjectSkillEntry[] = [];

  for (const [index, raw] of manifest.skills.entries()) {
    const entry = asObject(raw, `skills[${index}]`);
    const name = requiredString(entry, 'name', index);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      throw new ProjectSkillsManifestError(
        `skills[${index}].name must contain only letters, numbers, dot, underscore, or dash`,
      );
    }
    if (names.has(name)) {
      throw new ProjectSkillsManifestError(`duplicate name: ${name}`);
    }
    names.add(name);

    const rawAgent = requiredString(entry, 'agent', index);
    if (rawAgent !== 'codex' && rawAgent !== 'claude') {
      throw new ProjectSkillsManifestError(`skills[${index}].agent must be "codex" or "claude"`);
    }
    const agent: ProjectSkillAgent = rawAgent;
    const source = normalizedRelative(
      requiredString(entry, 'source', index),
      `skills[${index}].source`,
    );
    const target = normalizedRelative(
      requiredString(entry, 'target', index),
      `skills[${index}].target`,
    );
    const surface = expectedSurface(agent);
    if (target !== surface && !target.startsWith(`${surface}/`)) {
      throw new ProjectSkillsManifestError(
        `skills[${index}].target must be inside the ${agent} root surface ${surface}`,
      );
    }
    if (target === surface) {
      throw new ProjectSkillsManifestError(
        `skills[${index}].target must name a skill below ${surface}`,
      );
    }
    if (targets.has(target)) {
      throw new ProjectSkillsManifestError(`duplicate target: ${target}`);
    }
    targets.add(target);

    const sourcePath = path.resolve(canonicalRoot, ...source.split('/'));
    if (!inside(canonicalRoot, sourcePath)) {
      throw new ProjectSkillsManifestError(`skills[${index}].source escapes the repository`);
    }
    let canonicalSource: string;
    try {
      canonicalSource = fs.realpathSync(sourcePath);
    } catch {
      throw new ProjectSkillsManifestError(
        `skills[${index}] (${name}) source does not exist: ${source}`,
      );
    }
    if (!inside(canonicalRoot, canonicalSource)) {
      throw new ProjectSkillsManifestError(
        `skills[${index}] (${name}) source resolves outside the repository`,
      );
    }
    const skillFile = path.join(canonicalSource, 'SKILL.md');
    if (!fs.statSync(canonicalSource).isDirectory() || !fs.existsSync(skillFile)) {
      throw new ProjectSkillsManifestError(
        `skills[${index}] (${name}) source must contain SKILL.md: ${source}`,
      );
    }

    entries.push({
      name,
      agent,
      source,
      canonicalSource,
      target,
      installTarget: path.resolve(canonicalRoot, ...target.split('/')),
    });
  }

  return entries;
}
