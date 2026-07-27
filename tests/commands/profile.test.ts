import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AwlProfile,
  SKILL_SLOTS,
  defaultProfile,
  emptyProfileSkills,
  ensureProfile,
  loadProfile,
  profilePath,
  validateProfile,
  writeProfile,
} from '../../src/commands/profile.js';

function tmpProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'awl-profile-'));
}

const origCwd = process.cwd();
afterEach(() => {
  process.chdir(origCwd);
});

describe('SKILL_SLOTS — 파이프라인 순서 6자리 고정(reference.md:892-899)', () => {
  it('정확히 6자리다', () => {
    expect(SKILL_SLOTS).toEqual([
      'spec',
      'investigation',
      'clarification',
      'spike',
      'implement',
      'review',
    ]);
  });

  it('emptyProfileSkills 는 6자리 전부 null 이다', () => {
    const skills = emptyProfileSkills();
    for (const slot of SKILL_SLOTS) {
      expect(skills[slot]).toBeNull();
    }
    expect(Object.keys(skills)).toHaveLength(6);
  });
});

describe('validateProfile — 스키마 검증', () => {
  it('name 없으면 거부', () => {
    const errors = validateProfile({ skills: emptyProfileSkills() });
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('skills 없으면 거부', () => {
    const errors = validateProfile({ name: 'p' });
    expect(errors.some((e) => e.includes('skills'))).toBe(true);
  });

  it('알 수 없는 스킬 자리를 거부한다', () => {
    const errors = validateProfile({ name: 'p', skills: { ...emptyProfileSkills(), bogus: null } });
    expect(errors.some((e) => e.includes('bogus'))).toBe(true);
  });

  it("external 스킬은 url 이 필수다", () => {
    const errors = validateProfile({
      name: 'p',
      skills: { ...emptyProfileSkills(), review: { type: 'external' } },
    });
    expect(errors.some((e) => e.includes('skills.review'))).toBe(true);
  });

  it("custom 스킬은 path 가 필수다", () => {
    const errors = validateProfile({
      name: 'p',
      skills: { ...emptyProfileSkills(), implement: { type: 'custom' } },
    });
    expect(errors.some((e) => e.includes('skills.implement'))).toBe(true);
  });

  it('유효한 external/custom 스킬은 통과한다', () => {
    const errors = validateProfile({
      name: 'p',
      skills: {
        ...emptyProfileSkills(),
        review: { type: 'external', url: 'https://example.com/grill-me', version: '0.3' },
        implement: { type: 'custom', path: '.claude/skills/our-tdd', basedOn: 'https://x' },
      },
    });
    expect(errors).toEqual([]);
  });
});

describe('loadProfile / writeProfile — 원자적 왕복', () => {
  it('파일이 없으면 안내 에러를 남긴다(크래시 없음)', () => {
    const root = tmpProjectRoot();
    const result = loadProfile(root);
    expect(result.profile).toBeNull();
    expect(result.errors.some((e) => e.includes('profile.json'))).toBe(true);
  });

  it('쓴 프로파일을 그대로 읽어온다', () => {
    const root = tmpProjectRoot();
    const profile: AwlProfile = {
      name: 'maxflow',
      description: 'FE 출시 직전',
      skills: {
        ...emptyProfileSkills(),
        review: { type: 'external', url: 'https://example.com/adversarial-review' },
      },
    };
    writeProfile(root, profile);
    expect(fs.existsSync(profilePath(root))).toBe(true);
    const loaded = loadProfile(root);
    expect(loaded.profile).toEqual(profile);
  });

  it('JSON 이 깨져 있으면 에러를 남긴다(크래시 없음)', () => {
    const root = tmpProjectRoot();
    fs.mkdirSync(path.join(root, '.awl'), { recursive: true });
    fs.writeFileSync(profilePath(root), 'not json{{{');
    const loaded = loadProfile(root);
    expect(loaded.profile).toBeNull();
    expect(loaded.errors.length).toBeGreaterThan(0);
  });
});

describe('ensureProfile — 있으면 안 건드리고, 없으면 빈 프로파일을 만든다', () => {
  it('없으면 6자리 전부 null 인 빈 프로파일을 만든다', () => {
    const root = tmpProjectRoot();
    const profile = ensureProfile(root, 'maxflow');
    expect(profile).toEqual(defaultProfile('maxflow'));
    expect(fs.existsSync(profilePath(root))).toBe(true);
  });

  it('이미 있으면 절대 안 덮어쓴다(팀이 고른 스킬 보존 — lane 프로비저닝이 반복 호출해도 안전)', () => {
    const root = tmpProjectRoot();
    const custom: AwlProfile = {
      name: 'maxflow',
      skills: {
        ...emptyProfileSkills(),
        implement: { type: 'custom', path: '.claude/skills/our-tdd' },
      },
    };
    writeProfile(root, custom);

    const result = ensureProfile(root, 'maxflow');

    expect(result).toEqual(custom);
    expect(loadProfile(root).profile).toEqual(custom);
  });
});
