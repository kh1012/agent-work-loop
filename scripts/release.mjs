#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * awl 릴리스 스크립트. `pnpm release:patch` / `release:minor` / `release:major` 로 실행한다.
 *
 * 순서: 워킹트리 clean 확인 → verify(typecheck/lint/test) → CHANGELOG 확인/자동 생성
 * (여기까지는 아무 파일도 안 건드린다. 전부 통과해야 다음으로 간다)
 * → package.json/engine/version.json 버전 올림 → CHANGELOG 이동 → build
 * → npm pack 내용물 검증 → npm publish --dry-run → commit + 태그 + push → 안내 출력.
 *
 * npm publish 만 사람이 한다. 릴리스 커밋·태그·원격 push는 이 스크립트가 끝낸다.
 * 어느 단계든 실패하면, 이미 손댄 파일(package.json/engine/version.json/
 * CHANGELOG.md)을 git checkout 으로 되돌리고 중단한다 — 반쯤 올라간 버전을
 * 남기지 않는다.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const ENGINE_VERSION_PATH = path.join(REPO_ROOT, 'engine', 'version.json');
const CHANGELOG_PATH = path.join(REPO_ROOT, 'CHANGELOG.md');
const MUTATED_FILES = [PKG_PATH, ENGINE_VERSION_PATH, CHANGELOG_PATH];

function die(message) {
  console.error(`\n중단: ${message}\n`);
  process.exit(1);
}

function run(cmd, opts = {}) {
  execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit', ...opts });
}

function sh(cmd) {
  return execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// 1. 인자 확인
// ---------------------------------------------------------------------------

const bumpType = process.argv[2];
if (bumpType !== 'patch' && bumpType !== 'minor' && bumpType !== 'major') {
  die('사용법: node scripts/release.mjs <patch|minor|major>');
}

function bumpVersion(current, type) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(current);
  if (!m) {
    die(`버전 형식을 읽을 수 없습니다: ${current}`);
  }
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (type === 'patch') {
    patch += 1;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    major += 1;
    minor = 0;
    patch = 0;
  }
  return `${major}.${minor}.${patch}`;
}

/**
 * 사람이 Unreleased를 직접 적지 않아도, 마지막 릴리스 태그 뒤의 conventional
 * commit 제목으로 읽을 만한 Keep a Changelog 초안을 만든다. 직접 적은 내용이
 * 있으면 아래 자동 경로를 전혀 타지 않아, 긴 설명·수동 분류도 그대로 보존된다.
 */
function changelogFromCommits(currentVersion) {
  let subjects;
  try {
    subjects = sh(`git log --format=%s v${currentVersion}..HEAD`)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    die(`기준 태그 v${currentVersion} 뒤의 커밋을 읽지 못했습니다.`);
  }

  const sections = new Map([
    ['추가', []],
    ['고침', []],
    ['변경', []],
  ]);
  for (const subject of subjects) {
    // release 커밋은 이전 태그에 포함되므로 보통 없지만, 수동 태그 누락 같은
    // 경우에도 CHANGELOG에 중복 기록하지 않는다.
    if (/^chore\(release\):/i.test(subject)) {
      continue;
    }
    const conventional =
      /^(feat|fix|perf|refactor|docs|build|chore|test)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject);
    const kind = conventional?.[1]?.toLowerCase();
    const message = conventional?.[2] ?? subject;
    const heading = kind === 'feat' ? '추가' : kind === 'fix' ? '고침' : '변경';
    sections.get(heading).push(`- ${message}`);
  }

  const body = [...sections.entries()]
    .filter(([, entries]) => entries.length > 0)
    .map(([heading, entries]) => `### ${heading}\n\n${entries.join('\n')}`)
    .join('\n\n');
  if (body === '') {
    die(
      'CHANGELOG.md 의 [Unreleased] 가 비어 있고 기록할 커밋도 없습니다. 변경을 커밋하거나 [Unreleased]에 직접 적으세요.',
    );
  }
  console.log('CHANGELOG.md의 [Unreleased]가 비어 있어 마지막 태그 뒤 커밋으로 자동 작성합니다.');
  return body;
}

// ---------------------------------------------------------------------------
// 2. 워킹트리 clean 확인
// ---------------------------------------------------------------------------

console.log('워킹트리 확인 중...');
if (sh('git status --porcelain').trim() !== '') {
  die('워킹트리에 커밋되지 않은 변경이 있습니다. 먼저 커밋하거나 정리하세요.');
}

// ---------------------------------------------------------------------------
// 3. verify (typecheck + lint + test) — 아무 파일도 안 건드린 상태에서
// ---------------------------------------------------------------------------

console.log('\n=== typecheck ===');
try {
  run('pnpm run typecheck');
} catch {
  die('typecheck 실패로 배포를 중단합니다.');
}

console.log('\n=== lint ===');
try {
  run('pnpm run lint');
} catch {
  die('lint 실패로 배포를 중단합니다.');
}

console.log('\n=== test ===');
try {
  run('pnpm test');
} catch {
  die('test 실패로 배포를 중단합니다.');
}

// ---------------------------------------------------------------------------
// 4. 버전 계산 + CHANGELOG 의 Unreleased 확인/자동 생성 (아직 아무것도 안 씀)
// ---------------------------------------------------------------------------

const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
const currentVersion = pkg.version;
const newVersion = bumpVersion(currentVersion, bumpType);
console.log(`\n버전: ${currentVersion} -> ${newVersion} (${bumpType})`);

const changelogText = fs.readFileSync(CHANGELOG_PATH, 'utf8');
const unreleasedHeaderMatch = /^## \[Unreleased\]\s*$/m.exec(changelogText);
if (!unreleasedHeaderMatch) {
  die('CHANGELOG.md 에 "## [Unreleased]" 섹션이 없습니다.');
}
const afterHeaderIdx = unreleasedHeaderMatch.index + unreleasedHeaderMatch[0].length;
const rest = changelogText.slice(afterHeaderIdx);
const nextHeaderMatch = /^## \[/m.exec(rest);
const nextHeaderIdx = nextHeaderMatch
  ? afterHeaderIdx + nextHeaderMatch.index
  : changelogText.length;
const manualUnreleasedBody = changelogText.slice(afterHeaderIdx, nextHeaderIdx).trim();
const unreleasedBody = manualUnreleasedBody || changelogFromCommits(currentVersion);

// ---------------------------------------------------------------------------
// 5~7. 여기부터 파일을 건드린다. 실패하면 전부 되돌린다.
// ---------------------------------------------------------------------------

function revertMutations() {
  try {
    execFileSync('git', ['checkout', '--', ...MUTATED_FILES], { cwd: REPO_ROOT });
  } catch {
    // 되돌리기조차 실패하면(예: 파일이 애초에 추적 안 됨) 사람에게 맡긴다.
  }
}

try {
  // 5. package.json / engine/version.json 버전을 올린다.
  const pkgText = fs.readFileSync(PKG_PATH, 'utf8');
  const pkgVersionRe = /"version":\s*"[^"]+"/;
  if (!pkgVersionRe.test(pkgText)) {
    throw new Error('package.json 에서 version 필드를 찾지 못했습니다.');
  }
  fs.writeFileSync(PKG_PATH, pkgText.replace(pkgVersionRe, `"version": "${newVersion}"`));

  const engineText = fs.readFileSync(ENGINE_VERSION_PATH, 'utf8');
  const engineVersionRe = /"engineVersion":\s*"[^"]+"/;
  if (!engineVersionRe.test(engineText)) {
    throw new Error('engine/version.json 에서 engineVersion 필드를 찾지 못했습니다.');
  }
  fs.writeFileSync(
    ENGINE_VERSION_PATH,
    engineText.replace(engineVersionRe, `"engineVersion": "${newVersion}"`),
  );
  console.log('\npackage.json / engine/version.json 버전을 올렸습니다.');

  // 6. CHANGELOG 의 Unreleased 내용을 새 버전 섹션으로 옮긴다.
  const dateStr = new Date().toISOString().slice(0, 10);
  const head = `${changelogText.slice(0, afterHeaderIdx).replace(/\s+$/, '')}\n`;
  const newSection = `\n## [${newVersion}] - ${dateStr}\n\n${unreleasedBody}\n\n`;
  const tail = changelogText.slice(nextHeaderIdx);
  fs.writeFileSync(CHANGELOG_PATH, head + newSection + tail);
  console.log('CHANGELOG.md 의 Unreleased 를 새 버전 섹션으로 옮겼습니다.');

  // 7. 빌드
  console.log('\n=== build ===');
  run('pnpm run build');

  // 8. npm pack 으로 실제 tarball 을 만들어 내용물을 검증한다.
  console.log('\n=== npm pack 내용물 검증 ===');
  const packOut = sh('npm pack --silent').trim();
  const tgzName = packOut.split('\n').pop();
  const tgzPath = path.join(REPO_ROOT, tgzName);
  const fileList = sh(`tar -tzf "${tgzPath}"`);
  fs.rmSync(tgzPath, { force: true });

  const required = ['package/dist/cli.js', 'package/engine/version.json'];
  const missing = required.filter((f) => !fileList.includes(f));
  const hasSkills = /package\/engine\/skills\//.test(fileList);
  if (!hasSkills) {
    missing.push('package/engine/skills/**');
  }
  if (missing.length > 0) {
    throw new Error(`tarball 에 다음이 빠졌습니다: ${missing.join(', ')}`);
  }
  console.log('tarball 확인됨: dist/, engine/version.json, engine/skills/ 전부 포함.');

  // 9. publish --dry-run
  console.log('\n=== npm publish --dry-run ===');
  run('npm publish --dry-run');

  // 10. 커밋 + 태그
  console.log('\n=== 커밋 + 태그 ===');
  execFileSync('git', ['add', 'package.json', 'engine/version.json', 'CHANGELOG.md'], {
    cwd: REPO_ROOT,
  });
  execFileSync(
    'git',
    [
      'commit',
      '-m',
      `chore(release): ${newVersion}`,
      '-m',
      'CHANGELOG.md 의 [Unreleased] 를 이 버전으로 옮기고 package.json/engine 버전을 올린다.',
    ],
    { cwd: REPO_ROOT },
  );
  execFileSync('git', ['tag', `v${newVersion}`], { cwd: REPO_ROOT });
} catch (e) {
  console.error(`\n실패: ${e.message ?? e}`);
  console.error('변경한 파일을 되돌립니다...');
  revertMutations();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 11. 원격에 릴리스를 공개한다. npm publish만 사람이 한다.
// ---------------------------------------------------------------------------

const branch = sh('git branch --show-current').trim();
if (branch === '') {
  die(`v${newVersion} 태그는 만들었지만 detached HEAD라 push할 브랜치를 알 수 없습니다.`);
}
try {
  // 커밋과 lightweight tag를 한 요청으로 원자적으로 보낸다. 둘 중 하나만 원격에
  // 남는 반쪽 릴리스를 막는다.
  execFileSync(
    'git',
    ['push', '--atomic', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/v${newVersion}`],
    { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, AWL_ALLOW_PUSH: '1' } },
  );
} catch (e) {
  die(
    `v${newVersion}의 로컬 커밋과 태그는 만들었지만 원격 push에 실패했습니다. 네트워크/권한을 확인한 뒤 AWL_ALLOW_PUSH=1 git push origin ${branch} && AWL_ALLOW_PUSH=1 git push origin v${newVersion} 를 실행하세요. (pre-push 훅이 막으므로 AWL_ALLOW_PUSH=1 이 필요합니다.)`,
  );
}

console.log(`
릴리스했습니다. ${currentVersion} -> ${newVersion}. 커밋·태그(v${newVersion})·원격 push까지 끝냈습니다.

npm 배포만 사람이 실행하세요:
  npm publish
(비대화형으로 돌리는 경우에만 prepublishOnly 훅이 막으므로 AWL_ALLOW_PUBLISH=1 npm publish 가 필요합니다.)
`);
