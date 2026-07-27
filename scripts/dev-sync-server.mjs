#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * ADK 단계 3(중앙 저장소) 검증용 임시 서버.
 * docs/0.8.0/adk-prototype.md:356-443 의 엔드포인트를 Node 내장 http 모듈만으로
 * 흉내낸다 — 디렉토리에 파일만 쓴다, DB/색인 없음(prototype.md:362 그대로).
 *
 * awl 이 실제로 배포하는 기능이 아니다. src/core/sync.ts + 그걸 부르는
 * src/commands/record.ts 의 전송 트리거를 실제 HTTP 왕복으로 검증하기 위한
 * 일회성 개발 도구다 — program.ts 에 명령으로 등록하지 않는다(scripts/release.mjs
 * 가 배포 스크립트지만 CLI 명령이 아닌 것과 같은 위치).
 *
 * 사용: node scripts/dev-sync-server.mjs [--port 9999] [--dir ./dev-sync-storage]
 */

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}
const PORT = Number(argValue('--port', '9999'));
const STORAGE = path.resolve(argValue('--dir', './dev-sync-storage'));

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function monthOf(iso) {
  return typeof iso === 'string' && /^\d{4}-\d{2}/.test(iso)
    ? iso.slice(0, 7)
    : new Date().toISOString().slice(0, 7);
}

/** jsonl 파일에서 이미 있는 id 집합을 읽는다(손상된 줄은 조용히 건너뛴다). */
function readJsonlIds(filePath) {
  const ids = new Set();
  if (!fs.existsSync(filePath)) {
    return ids;
  }
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const obj = JSON.parse(line);
      if (obj.id) {
        ids.add(obj.id);
      }
    } catch {
      // 손상된 줄은 무시 — 이 서버는 검증용이라 복구를 시도하지 않는다.
    }
  }
  return ids;
}

/** id 로 중복을 거르고 append 한다(prototype.md:376 "기록은 id 로 중복을 거른다"). */
function appendJsonlDedup(filePath, envelope) {
  ensureDir(path.dirname(filePath));
  const ids = readJsonlIds(filePath);
  if (envelope.id && ids.has(envelope.id)) {
    return { deduped: true };
  }
  fs.appendFileSync(filePath, `${JSON.stringify(envelope)}\n`);
  return { deduped: false };
}

function specFilePath(envelope) {
  const owner = envelope.organization || 'unknown';
  const repo = envelope.project || 'unknown';
  const dir = path.join(STORAGE, 'docs', owner, repo, 'specs');
  ensureDir(dir);
  return path.join(dir, `${envelope.id}.md`);
}

function serializeSpecFile(envelope) {
  const fm = {
    ...envelope.frontmatter,
    // 봉투 최상위 필드가 원본 frontmatter 값보다 항상 우선한다 — frontmatter 안에도
    // (원본 문서가 저장했던, 대개 낡은) id/revision/organization 이 섞여 들어올 수
    // 있어서 뒤에 스프레드하면 방금 계산한 revision(bodySha256)을 덮어써 버린다.
    id: envelope.id,
    revision: envelope.revision ?? '',
    organization: envelope.organization ?? '',
    project: envelope.project ?? '',
    author: envelope.author ?? '',
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${envelope.body ?? ''}`;
}

function existingSpecRevision(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const m = fs.readFileSync(filePath, 'utf8').match(/^revision: (.*)$/m);
  if (!m) {
    return null;
  }
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** revision 이 같으면 이미 받은 것으로 보고 무시한다(prototype.md:375). */
function writeSpec(envelope) {
  const filePath = specFilePath(envelope);
  if (existingSpecRevision(filePath) === envelope.revision) {
    return { deduped: true };
  }
  fs.writeFileSync(filePath, serializeSpecFile(envelope));
  return { deduped: false };
}

function listSpecFiles() {
  const specsRoot = path.join(STORAGE, 'docs');
  if (!fs.existsSync(specsRoot)) {
    return [];
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (entry.name.endsWith('.md')) {
        out.push(p);
      }
    }
  };
  walk(specsRoot);
  return out;
}

function parseSpecFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) {
    return null;
  }
  const frontmatter = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(': ');
    if (idx === -1) {
      continue;
    }
    const key = line.slice(0, idx);
    try {
      frontmatter[key] = JSON.parse(line.slice(idx + 2));
    } catch {
      frontmatter[key] = line.slice(idx + 2);
    }
  }
  return { frontmatter, body: m[2] };
}

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const segments = url.pathname.split('/').filter(Boolean);

  try {
    if (req.method === 'POST' && segments[0] === 'records') {
      const envelope = JSON.parse(await readBody(req));
      const owner = envelope.organization || 'unknown';
      const repo = envelope.project || 'unknown';
      const month = monthOf(envelope.frontmatter?.at);
      const filePath = path.join(STORAGE, 'records', owner, repo, `${month}.jsonl`);
      const result = appendJsonlDedup(filePath, envelope);
      console.log(`POST /records  id=${envelope.id} ${result.deduped ? '(중복, 무시)' : '(저장)'}`);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && segments[0] === 'feedback') {
      const envelope = JSON.parse(await readBody(req));
      const month = monthOf(envelope.frontmatter?.at);
      const filePath = path.join(STORAGE, 'feedback', `${month}.jsonl`);
      const result = appendJsonlDedup(filePath, envelope);
      console.log(`POST /feedback  id=${envelope.id} ${result.deduped ? '(중복, 무시)' : '(저장)'}`);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'POST' && segments[0] === 'specs') {
      const envelope = JSON.parse(await readBody(req));
      const result = writeSpec(envelope);
      console.log(`POST /specs  id=${envelope.id} ${result.deduped ? '(같은 revision, 무시)' : '(저장)'}`);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && segments[0] === 'specs' && segments.length === 1) {
      const q = url.searchParams.get('q');
      const files = listSpecFiles()
        .map(parseSpecFile)
        .filter((d) => d !== null);
      if (q) {
        const matches = files.filter((d) => d.body.includes(q) || JSON.stringify(d.frontmatter).includes(q));
        sendJson(res, 200, matches.map((d) => d.frontmatter));
        return;
      }
      sendJson(res, 200, files.map((d) => d.frontmatter));
      return;
    }

    if (req.method === 'GET' && segments[0] === 'specs' && segments.length === 2) {
      const id = segments[1];
      const doc = listSpecFiles()
        .map(parseSpecFile)
        .find((d) => d?.frontmatter.id === id);
      if (!doc) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, doc);
      return;
    }

    if (req.method === 'GET' && segments[0] === 'profiles' && segments.length === 1) {
      const dir = path.join(STORAGE, 'profiles');
      const names = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
        : [];
      sendJson(res, 200, names);
      return;
    }

    if (req.method === 'GET' && segments[0] === 'profiles' && segments.length === 2) {
      const filePath = path.join(STORAGE, 'profiles', `${segments[1]}.json`);
      if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      sendJson(res, 200, JSON.parse(fs.readFileSync(filePath, 'utf8')));
      return;
    }

    sendJson(res, 404, { error: 'no such route', method: req.method, path: url.pathname });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

ensureDir(STORAGE);
server.listen(PORT, () => {
  console.log(`dev-sync-server: http://localhost:${PORT} (저장 위치: ${STORAGE})`);
});
