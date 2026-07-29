import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bodySha256,
  createDoc,
  deriveOrganizationFromGitRemote,
  extractConditionBlocks,
  extractConstraintBlocks,
  findSpecsByDomain,
  kebabCase,
  lintDoc,
  lintFilename,
  listDocFiles,
  localIsoWithOffset,
  localTimestampForFilename,
  normalizeGitRemoteOwnerRepo,
  parseGlossaryBannedTerms,
} from '../../src/commands/doc.js';
import { parseFrontmatter } from '../../src/core/doc-frontmatter.js';

const origCwd = process.cwd();

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  process.chdir(origCwd);
});

describe('localTimestampForFilename / localIsoWithOffset', () => {
  it('YYYYMMDD-HHMMSS 형식을 만든다', () => {
    const d = new Date(2026, 6, 25, 14, 30, 52); // 로컬 시각 2026-07-25 14:30:52
    expect(localTimestampForFilename(d)).toBe('20260725-143052');
  });

  it('오프셋 포함 ISO 를 만든다(같은 로컬 시각의 시분초가 그대로 반영된다)', () => {
    const d = new Date(2026, 6, 25, 14, 30, 52);
    const iso = localIsoWithOffset(d);
    expect(iso).toMatch(/^2026-07-25T14:30:52[+-]\d{2}:\d{2}$/);
  });
});

describe('kebabCase', () => {
  it('한글 제목의 공백을 하이픈으로 접는다(유니코드 보존)', () => {
    expect(kebabCase('레이어 패널 키보드 조작')).toBe('레이어-패널-키보드-조작');
  });

  it('영문 제목도 소문자 kebab 으로 만든다', () => {
    expect(kebabCase('Editor Keyboard Nav')).toBe('editor-keyboard-nav');
  });

  it('앞뒤 구두점은 하이픈을 남기지 않는다', () => {
    expect(kebabCase('  --제목!! ')).toBe('제목');
  });
});

describe('normalizeGitRemoteOwnerRepo', () => {
  it('ssh 형식(git@host:owner/repo.git)을 owner/repo 로 정규화한다', () => {
    expect(normalizeGitRemoteOwnerRepo('git@bitbucket.org:midasit/maxflow.git')).toBe(
      'midasit/maxflow',
    );
  });

  it('https 형식(옵션 user@)을 owner/repo 로 정규화한다', () => {
    expect(normalizeGitRemoteOwnerRepo('https://user@bitbucket.org/midasit/maxflow.git')).toBe(
      'midasit/maxflow',
    );
    expect(normalizeGitRemoteOwnerRepo('https://github.com/midasit/agent-work-loop.git')).toBe(
      'midasit/agent-work-loop',
    );
  });

  it('알 수 없는 형식(로컬 경로 등)은 빈 문자열이다(안 깨지고 조용히 실패)', () => {
    expect(normalizeGitRemoteOwnerRepo('/local/path/repo')).toBe('');
  });
});

describe('deriveOrganizationFromGitRemote', () => {
  it('remote.origin.url 이 있으면 owner 세그먼트를 돌려준다', () => {
    const p = tmp('awl-doc-org-');
    spawnSync('git', ['init', '-q'], { cwd: p });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:midasit/awl.git'], { cwd: p });
    return deriveOrganizationFromGitRemote(p).then((org) => {
      expect(org).toBe('midasit');
    });
  });

  it('remote 가 없으면 빈 문자열이고 예외를 던지지 않는다', async () => {
    const p = tmp('awl-doc-org-');
    spawnSync('git', ['init', '-q'], { cwd: p });
    await expect(deriveOrganizationFromGitRemote(p)).resolves.toBe('');
  });

  it('git 저장소가 아니어도 예외를 던지지 않는다', async () => {
    const p = tmp('awl-doc-org-');
    await expect(deriveOrganizationFromGitRemote(p)).resolves.toBe('');
  });
});

describe('bodySha256', () => {
  it('같은 내용은 같은 해시, 다른 내용은 다른 해시', () => {
    expect(bodySha256('hello')).toBe(bodySha256('hello'));
    expect(bodySha256('hello')).not.toBe(bodySha256('world'));
  });
});

describe('createDoc — spec', () => {
  function project(): string {
    const p = tmp('awl-doc-spec-');
    spawnSync('git', ['init', '-q'], { cwd: p });
    spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:midasit/awl.git'], { cwd: p });
    fs.mkdirSync(path.join(p, '.awl'), { recursive: true });
    fs.writeFileSync(
      path.join(p, '.awl', 'config.json'),
      JSON.stringify({ project: 'my-project', engineVersion: '0.0.0', verify: {} }),
    );
    return p;
  }

  it('프론트매터가 채워진 spec 파일을 docs/specs/ 에 만든다(EARS #1)', async () => {
    const p = project();
    const now = new Date(2026, 6, 25, 14, 30, 52);
    const result = await createDoc('spec', '레이어 패널 키보드 조작', p, {}, now);

    expect(result.path).toBe(
      path.join(p, 'docs', 'specs', '20260725-143052-레이어-패널-키보드-조작.md'),
    );
    expect(fs.existsSync(result.path)).toBe(true);

    const content = fs.readFileSync(result.path, 'utf8');
    const parsed = parseFrontmatter(content);
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toMatchObject({
      id: result.id,
      revision: '',
      organization: 'midasit',
      project: 'my-project',
      title: '레이어 패널 키보드 조작',
      status: 'draft',
      domain: '',
      terms: [],
      verification: ['binary'],
      tickets: [],
      decisions: [],
    });
    expect(parsed?.data.created).toMatch(/^2026-07-25T14:30:52/);
    expect(parsed?.body).toContain('## Request');
    expect(parsed?.body).toContain('## Instruction');
    expect(parsed?.body).toContain('## Constraints');
    expect(parsed?.body).toContain('## Conditions');
    expect(parsed?.body).toContain('## Out of scope');
  });

  it('id 는 유효한 UUID(v7) 형식이다', async () => {
    const p = project();
    const result = await createDoc('spec', '제목', p);
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('연속 생성하면 파일명 타임스탬프가 달라진다', async () => {
    const p = project();
    const a = await createDoc('spec', '제목', p, {}, new Date(2026, 0, 1, 0, 0, 0));
    const b = await createDoc('spec', '제목', p, {}, new Date(2026, 0, 1, 0, 0, 1));
    expect(a.path).not.toBe(b.path);
  });

  it('같은 초에 같은 제목으로 두 번 만들어도 덮어쓰지 않고 -2 접미사로 갈라진다(WI-G9)', async () => {
    const p = project();
    const now = new Date(2026, 6, 25, 14, 30, 52);
    const a = await createDoc('spec', '제목', p, {}, now);
    const b = await createDoc('spec', '제목', p, {}, now);
    expect(a.path).not.toBe(b.path);
    expect(b.path).toBe(path.join(p, 'docs', 'specs', '20260725-143052-제목-2.md'));
    expect(fs.existsSync(a.path)).toBe(true);
    expect(fs.existsSync(b.path)).toBe(true);
    expect(a.id).not.toBe(b.id);
  });

  it('config.json 이 없어도 디렉터리 이름으로 project 를 채우고 크래시하지 않는다', async () => {
    const p = tmp('awl-doc-noconfig-');
    const result = await createDoc('spec', '제목', p);
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.data.project).toBe(path.basename(p));
    expect(parsed?.data.organization).toBe('');
  });

  it('--request 로 원문을 주면 Request 절에 그대로 인용된다(WI-G5)', async () => {
    const p = project();
    const result = await createDoc('spec', '제목', p, {
      request: '레이어 패널을 키보드로 조작하고 싶어',
    });
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.body).toContain('> 레이어 패널을 키보드로 조작하고 싶어');
    expect(parsed?.body).not.toContain('(사용자가 던진 원문 그대로)');
  });

  it('request 를 안 주면 기존처럼 자리표시자만 남는다(하위호환)', async () => {
    const p = project();
    const result = await createDoc('spec', '제목', p);
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.body).toContain('> (사용자가 던진 원문 그대로)');
  });

  it('여러 줄 request 는 줄마다 인용 부호(>)를 붙인다', async () => {
    const p = project();
    const result = await createDoc('spec', '제목', p, { request: '첫 줄\n둘째 줄' });
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.body).toContain('> 첫 줄\n> 둘째 줄');
  });
});

describe('createDoc — ticket', () => {
  it('conditions/dependencies 빈 배열, status:pending, --spec 반영', async () => {
    const p = tmp('awl-doc-ticket-');
    const result = await createDoc('ticket', '키보드 이벤트 배선', p, { spec: 'spec-id-1' });
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.data).toMatchObject({
      id: result.id,
      spec: 'spec-id-1',
      conditions: [],
      dependencies: [],
      status: 'pending',
    });
    expect(parsed?.body).toContain('## Verification');
    expect(parsed?.body).toContain('## Clarifications');
    expect(parsed?.body).toContain('## Files');
    expect(result.path).toContain(`${path.sep}docs${path.sep}tickets${path.sep}`);
  });

  it('dependencies 를 opts 로 넘기면 프론트매터에 그대로 저장된다(의존이 곧 구현 순서, 판정은 호출자 몫)', async () => {
    const p = tmp('awl-doc-ticket-deps-');
    const result = await createDoc('ticket', '방향키 이동', p, {
      spec: 'spec-id-1',
      conditions: ['condition-1'],
      dependencies: ['ticket-1', 'ticket-2'],
    });
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.data).toMatchObject({
      conditions: ['condition-1'],
      dependencies: ['ticket-1', 'ticket-2'],
    });
  });
});

describe('createDoc — decision', () => {
  it('status:accepted, supersedes/superseded-by 기본값 -', async () => {
    const p = tmp('awl-doc-decision-');
    const result = await createDoc('decision', '이벤트는 패널 루트에서 받는다', p);
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.data).toMatchObject({
      id: result.id,
      status: 'accepted',
      supersedes: '-',
      'superseded-by': '-',
    });
    expect(result.path).toContain(`${path.sep}docs${path.sep}decisions${path.sep}`);
  });

  it('--supersedes 를 주면 그 값을 담는다', async () => {
    const p = tmp('awl-doc-decision-');
    const result = await createDoc('decision', '제목', p, { supersedes: 'decision-0' });
    const parsed = parseFrontmatter(fs.readFileSync(result.path, 'utf8'));
    expect(parsed?.data.supersedes).toBe('decision-0');
  });
});

describe('lintFilename', () => {
  it('YYYYMMDD-HHMMSS-kebab.md(한글 포함) 형식은 통과한다', () => {
    expect(lintFilename('20260725-143052-레이어-패널-키보드-조작.md')).toBe(true);
    expect(lintFilename('20260725-143052-editor-keyboard-nav.md')).toBe(true);
  });

  it('타임스탬프가 없거나 자릿수가 안 맞으면 실패한다', () => {
    expect(lintFilename('editor-keyboard-nav.md')).toBe(false);
    expect(lintFilename('2026725-143052-editor-keyboard-nav.md')).toBe(false);
  });

  it('.md 가 아니면 실패한다', () => {
    expect(lintFilename('20260725-143052-editor-keyboard-nav.txt')).toBe(false);
  });

  it('하이픈이 연속되거나 끝에 있으면 실패한다', () => {
    expect(lintFilename('20260725-143052-editor--nav.md')).toBe(false);
    expect(lintFilename('20260725-143052-editor-.md')).toBe(false);
  });
});

describe('extractConditionBlocks', () => {
  it('## Conditions 아래 ### condition-N 블록들을 뽑는다', () => {
    const body = [
      '## Instruction',
      '아무 내용',
      '',
      '## Conditions',
      '',
      '### condition-1',
      '언제 포커스가 패널에 있고 방향키를 누르면,',
      '선택이 이동해야 한다',
      '',
      '### condition-2',
      '만약 이름 편집 중이라면,',
      '방향키는 선택을 이동시키지 않아야 한다',
      '',
      '## Out of scope',
      '- 다중 선택',
    ].join('\n');
    const blocks = extractConditionBlocks(body);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ heading: 'condition-1' });
    expect(blocks[0]?.text).toContain('언제 포커스가 패널에 있고');
    expect(blocks[1]?.text).toContain('만약 이름 편집 중이라면');
  });

  it('## Conditions 섹션이 없으면 빈 배열이다(스캐폴드 직후 상태)', () => {
    const body = '## Instruction\n\n## Conditions\n\n## Out of scope\n';
    expect(extractConditionBlocks(body)).toEqual([]);
  });

  it('각 블록의 line 은 본문(body) 안에서 ### 제목이 있는 1-인덱스 줄 번호다(WI-G4)', () => {
    const body = [
      '## Instruction', // 1
      '아무 내용', // 2
      '', // 3
      '## Conditions', // 4
      '', // 5
      '### condition-1', // 6
      '언제 X 이면, Y 해야 한다', // 7
      '', // 8
      '### condition-2', // 9
      '만약 Z 라면, W 해야 한다', // 10
    ].join('\n');
    const blocks = extractConditionBlocks(body);
    expect(blocks[0]?.line).toBe(6);
    expect(blocks[1]?.line).toBe(9);
  });
});

describe('parseGlossaryBannedTerms', () => {
  it('- 쓰지 않음: a, b 줄에서 금칙어 집합을 만든다', () => {
    const md = ['## 티켓', '설명.', '', '- 쓰지 않음: 태스크, 이슈, 일감', '- 코드: `Ticket`'].join(
      '\n',
    );
    expect(parseGlossaryBannedTerms(md)).toEqual(new Set(['태스크', '이슈', '일감']));
  });

  it('- 쓰지 않음: - 는 빈 집합이다(없음 표시)', () => {
    const md = '## 프로젝트\n\n- 쓰지 않음: -\n';
    expect(parseGlossaryBannedTerms(md)).toEqual(new Set());
  });
});

describe('lintDoc — EARS 문형 (EARS #2)', () => {
  function writeSpec(dir: string, filename: string, body: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, filename);
    fs.writeFileSync(p, `---\nid: x\n---\n${body}`);
    return p;
  }

  it('언제/만약/동안/어디서/항상으로 시작하는 조건은 통과한다', () => {
    const p = tmp('awl-lint-ears-');
    const file = writeSpec(
      p,
      '20260725-143052-제목.md',
      '## Conditions\n\n### condition-1\n언제 X 이면, Y 해야 한다\n',
    );
    expect(lintDoc('spec', file, new Set())).toEqual([]);
  });

  it('EARS 문형이 아닌 조건은 실패한다', () => {
    const p = tmp('awl-lint-ears-');
    const file = writeSpec(
      p,
      '20260725-143052-제목.md',
      '## Conditions\n\n### condition-1\n포커스가 있으면 이동한다\n',
    );
    const violations = lintDoc('spec', file, new Set());
    expect(violations.some((v) => v.message.includes('EARS 문형'))).toBe(true);
  });

  it('위반에 파일 전체 기준 줄 번호가 붙는다(WI-G4) — 프론트매터 3줄 + body 3번째 줄(### condition-1)', () => {
    const p = tmp('awl-lint-ears-line-');
    // frontmatter 는 정확히 3줄(---/id: x/---) — body 는 파일의 4번째 줄부터 시작한다.
    // body 안에서 "### condition-1"은 3번째 줄(## Conditions=1, 빈줄=2, ### condition-1=3)
    // → 파일 전체 기준 4-1+3 = 6번째 줄.
    const file = writeSpec(
      p,
      '20260725-143052-제목.md',
      '## Conditions\n\n### condition-1\n포커스가 있으면 이동한다\n',
    );
    const violations = lintDoc('spec', file, new Set());
    const v = violations.find((x) => x.message.includes('EARS 문형'));
    expect(v?.line).toBe(6);
  });
});

describe('lintDoc — 질적 표현 (record.ts BANNED_QUALITATIVE_WORDS 재사용)', () => {
  it('조건에 질적 표현이 있으면 실패한다', () => {
    const p = tmp('awl-lint-qual-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    fs.writeFileSync(
      file,
      '---\nid: x\n---\n## Conditions\n\n### condition-1\n언제 적절한 상황이면, 동작해야 한다\n',
    );
    const violations = lintDoc('spec', file, new Set());
    expect(violations.some((v) => v.message.includes('질적 표현'))).toBe(true);
  });
});

describe('extractConstraintBlocks (WI-G6)', () => {
  it('## Constraints 아래 ### constraint-N 블록들을 뽑는다', () => {
    const body = [
      '## Constraints',
      '',
      '### constraint-1',
      'Puck 코어를 수정하지 않는다',
      'verification: git diff 에 @measured/puck 없음',
      'source: -',
      'hits: 0',
      '',
      '## Conditions',
    ].join('\n');
    const blocks = extractConstraintBlocks(body);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.heading).toBe('constraint-1');
    expect(blocks[0]?.text).toContain('verification:');
  });
});

describe('lintDoc — 제약(Constraints)에 verification·source·hits 요구 (WI-G6)', () => {
  function writeSpec(dir: string, body: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '20260725-143052-제목.md');
    fs.writeFileSync(p, `---\nid: x\n---\n${body}`);
    return p;
  }

  it('세 필드가 모두 있으면 통과한다', () => {
    const p = tmp('awl-lint-constraint-');
    const file = writeSpec(
      p,
      '## Constraints\n\n### constraint-1\nPuck 코어를 수정하지 않는다\nverification: git diff 확인\nsource: -\nhits: 0\n',
    );
    const violations = lintDoc('spec', file, new Set());
    expect(violations.some((v) => v.message.includes('constraint-1'))).toBe(false);
  });

  it('hits 가 없으면 실패하고 어느 필드가 빠졌는지 알려준다', () => {
    const p = tmp('awl-lint-constraint-');
    const file = writeSpec(
      p,
      '## Constraints\n\n### constraint-1\nPuck 코어를 수정하지 않는다\nverification: git diff 확인\nsource: -\n',
    );
    const violations = lintDoc('spec', file, new Set());
    const v = violations.find((x) => x.message.includes('constraint-1'));
    expect(v).toBeDefined();
    expect(v?.message).toContain('hits');
  });

  it('세 필드 다 없으면 전부 지목한다', () => {
    const p = tmp('awl-lint-constraint-');
    const file = writeSpec(p, '## Constraints\n\n### constraint-1\nPuck 코어를 수정하지 않는다\n');
    const violations = lintDoc('spec', file, new Set());
    const v = violations.find((x) => x.message.includes('constraint-1'));
    expect(v?.message).toContain('verification');
    expect(v?.message).toContain('source');
    expect(v?.message).toContain('hits');
  });

  it('Constraints 섹션이 비어 있으면(스캐폴드 직후) 위반이 없다', () => {
    const p = tmp('awl-lint-constraint-');
    const file = writeSpec(p, '## Constraints\n\n## Conditions\n');
    expect(lintDoc('spec', file, new Set())).toEqual([]);
  });

  it('ticket/decision 은 이 검사 대상이 아니다', () => {
    const p = tmp('awl-lint-constraint-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    fs.writeFileSync(file, '---\nid: x\n---\n## Constraints\n\n### constraint-1\n아무거나\n');
    expect(lintDoc('ticket', file, new Set())).toEqual([]);
  });
});

describe('lintDoc — 스펙 본문 파일 경로 금지 (EARS #3)', () => {
  it('파일 경로가 있으면 실패한다', () => {
    const p = tmp('awl-lint-path-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    fs.writeFileSync(file, '---\nid: x\n---\n## Instruction\nLayersPanel.tsx:203 에서 처리한다\n');
    const violations = lintDoc('spec', file, new Set());
    expect(violations.some((v) => v.message.includes('파일 경로'))).toBe(true);
  });

  it('파일 경로가 없으면 통과한다', () => {
    const p = tmp('awl-lint-path-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    fs.writeFileSync(file, '---\nid: x\n---\n## Instruction\n레이어 패널을 키보드로 다룬다\n');
    const violations = lintDoc('spec', file, new Set());
    expect(violations.some((v) => v.message.includes('파일 경로'))).toBe(false);
  });

  it('ticket/decision 은 파일 경로 검사 대상이 아니다(finding 은 티켓 소관)', () => {
    const p = tmp('awl-lint-path-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    fs.writeFileSync(file, '---\nid: x\n---\n## Files\nLayersPanel.tsx:203\n');
    expect(lintDoc('ticket', file, new Set())).toEqual([]);
  });
});

describe('lintDoc — 파일명 형식 (EARS #4)', () => {
  it('형식에 안 맞는 파일명은 실패한다', () => {
    const p = tmp('awl-lint-name-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, 'my-spec.md');
    fs.writeFileSync(file, '---\nid: x\n---\n## Instruction\n내용\n');
    const violations = lintDoc('spec', file, new Set());
    expect(violations.some((v) => v.message.includes('파일명이 형식'))).toBe(true);
  });
});

describe('lintDoc — 용어집 금칙어 (EARS #5)', () => {
  it('금칙어가 쓰였으면 실패한다', () => {
    const p = tmp('awl-lint-glossary-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    // includesBannedWord 는 한글 음절에 바로 붙은 매칭(예: "태스크입니다")은 더 큰
    // 단어의 일부로 보고 건너뛴다(record.ts 재사용, 오탐 방지) — 그래서 앞뒤에
    // 공백/구두점을 둔 독립된 형태로 테스트한다.
    fs.writeFileSync(file, '---\nid: x\n---\n## Instruction\n여기서는 태스크 라고 부른다\n');
    const violations = lintDoc('spec', file, new Set(['태스크']));
    expect(violations.some((v) => v.message.includes('쓰지 않음'))).toBe(true);
  });

  it('금칙어 집합이 비어 있으면(CONTEXT.md 없음) 이 검사만 조용히 건너뛴다', () => {
    const p = tmp('awl-lint-glossary-');
    fs.mkdirSync(p, { recursive: true });
    const file = path.join(p, '20260725-143052-제목.md');
    fs.writeFileSync(file, '---\nid: x\n---\n## Instruction\n이건 태스크입니다\n');
    expect(lintDoc('spec', file, new Set())).toEqual([]);
  });
});

describe('listDocFiles', () => {
  it('specs/tickets/decisions 세 디렉터리를 모두 훑고, 없는 디렉터리는 건너뛴다', () => {
    const p = tmp('awl-lint-list-');
    fs.mkdirSync(path.join(p, 'docs', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(p, 'docs', 'specs', '20260725-143052-a.md'), '---\nid: x\n---\n');
    // tickets/decisions 디렉터리는 아예 안 만든다.
    const files = listDocFiles(p);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ type: 'spec' });
  });
});

describe('findSpecsByDomain (WI-G7)', () => {
  function writeSpecWithDomain(dir: string, filename: string, domain: string, extra = ''): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, filename),
      `---\nid: ${filename}\ntitle: t\nstatus: draft\ndomain: ${domain}\n${extra}---\n`,
    );
  }

  it('domain 이 정확히 같은 스펙만 모은다', () => {
    const p = tmp('awl-doc-related-');
    const dir = path.join(p, 'docs', 'specs');
    writeSpecWithDomain(dir, '20260101-000000-a.md', 'editor');
    writeSpecWithDomain(dir, '20260101-000001-b.md', 'auth');
    writeSpecWithDomain(dir, '20260101-000002-c.md', 'editor');

    const related = findSpecsByDomain(p, 'editor');
    expect(related).toHaveLength(2);
    expect(related.every((s) => s.domain === 'editor')).toBe(true);
  });

  it('draft 스펙도 포함한다(closed 만이 아니다)', () => {
    const p = tmp('awl-doc-related-');
    const dir = path.join(p, 'docs', 'specs');
    writeSpecWithDomain(dir, '20260101-000000-a.md', 'editor');
    const related = findSpecsByDomain(p, 'editor');
    expect(related[0]?.status).toBe('draft');
  });

  it('specs 디렉터리가 없으면 빈 배열(크래시 없음)', () => {
    const p = tmp('awl-doc-related-empty-');
    expect(findSpecsByDomain(p, 'editor')).toEqual([]);
  });

  it('같은 domain 이 하나도 없으면 빈 배열', () => {
    const p = tmp('awl-doc-related-');
    const dir = path.join(p, 'docs', 'specs');
    writeSpecWithDomain(dir, '20260101-000000-a.md', 'auth');
    expect(findSpecsByDomain(p, 'editor')).toEqual([]);
  });
});
