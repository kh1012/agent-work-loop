import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseServicePort, resolveServiceUrl } from '../../src/commands/port-lease.js';
import {
  acquirePortLease,
  inspectPortLease,
  portLeaseLocation,
  readPortLease,
  releasePortLease,
  runWithPortLease,
  updatePortLeaseChild,
} from '../../src/core/port-lease.js';
import { buildProgram } from '../../src/program.js';

const roots: string[] = [];

function tmp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-port-lease-'));
  roots.push(root);
  return root;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('missing test server address'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function waitForFile(file: string): Promise<void> {
  if (fs.existsSync(file)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(path.dirname(file), (event, name) => {
      if (event === 'rename' && name === path.basename(file) && fs.existsSync(file)) {
        watcher.close();
        resolve();
      }
    });
    watcher.once('error', reject);
    if (fs.existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}

function waitForOutput(child: ChildProcess, output: () => string, pattern: RegExp): Promise<void> {
  if (pattern.test(output())) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onData = (): void => {
      if (pattern.test(output())) {
        child.stdout?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!pattern.test(output())) {
        reject(new Error(`worker exited ${code} before output matched ${pattern}`));
      }
    });
  });
}

function waitForExit(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
}

async function waitForProcessDeath(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`process ${pid} did not exit`);
}

function spawnContender(
  root: string,
  port: number,
  start: string,
  marker: string,
  stop: string,
  label: string,
): { child: ChildProcess; output: () => string } {
  const fixture = path.resolve('tests/fixtures/port-lease-worker.ts');
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      fixture,
      'contender',
      root,
      String(port),
      start,
      marker,
      stop,
      label,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return {
    child,
    output: () => `${stdout}${stderr}`,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('installation-scoped service port leases', () => {
  it('creates a complete exclusive lease before registering the child pid', async () => {
    const root = tmp();
    const port = await freePort();
    const identity = {
      lane: path.join(root, 'lane'),
      branch: 'work/test',
      head: 'a'.repeat(40),
      workitem: 'WI-port',
    };

    const acquired = await acquirePortLease(root, port, identity);
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') {
      return;
    }
    expect(readPortLease(root, port)).toEqual({
      ...identity,
      lane: path.resolve(identity.lane),
      port,
      ownerPid: process.pid,
      childPid: null,
      token: acquired.lease.token,
      acquiredAt: acquired.lease.acquiredAt,
    });
    expect(fs.existsSync(portLeaseLocation(root, port).guardFile)).toBe(false);

    const updated = await updatePortLeaseChild(root, acquired.lease, process.pid);
    expect(updated?.childPid).toBe(process.pid);
    expect(await releasePortLease(root, port, acquired.lease.token)).toBe(true);
    expect(readPortLease(root, port)).toBeNull();
  });

  it('validates ports and resolves an explicit service URL before startup', () => {
    expect(parseServicePort('4317')).toBe(4317);
    expect(resolveServiceUrl('http://localhost:{port}/health', 4317)).toBe(
      'http://localhost:4317/health',
    );
    expect(resolveServiceUrl(undefined, 4317)).toBe('http://127.0.0.1:4317/');
    expect(() => parseServicePort('0')).toThrow('between 1 and 65535');
    expect(() => resolveServiceUrl('file:///tmp/socket', 4317)).toThrow('http or https');
  });

  it('wires awl port lease run with required identity and resolved-input options', () => {
    const program = buildProgram();
    const port = program.commands.find((command) => command.name() === 'port');
    const lease = port?.commands.find((command) => command.name() === 'lease');
    const run = lease?.commands.find((command) => command.name() === 'run');
    const inspect = lease?.commands.find((command) => command.name() === 'inspect');
    expect(run).toBeDefined();
    expect(run?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--port', '--workitem', '--url', '--json']),
    );
    expect(inspect?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--port', '--workitem', '--json']),
    );
  });

  it('lets exactly one of two processes start a child and reports the owner to the loser', async () => {
    const root = tmp();
    const port = await freePort();
    const start = path.join(root, 'start');
    const marker = path.join(root, 'child-started');
    const stop = path.join(root, 'stop');
    const first = spawnContender(root, port, start, marker, stop, 'a');
    const second = spawnContender(root, port, start, marker, stop, 'b');

    await Promise.all([
      waitForOutput(first.child, first.output, /READY a/),
      waitForOutput(second.child, second.output, /READY b/),
    ]);
    fs.writeFileSync(start, '');
    await waitForFile(marker);
    fs.writeFileSync(stop, '');

    const [firstCode, secondCode] = await Promise.all([
      waitForExit(first.child),
      waitForExit(second.child),
    ]);
    expect([firstCode, secondCode].sort()).toEqual([0, 2]);
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(readPortLease(root, port)).toBeNull();

    const outputs = [first.output(), second.output()];
    const busy = outputs.find((output) => output.includes('"status":"busy"'));
    expect(busy).toBeDefined();
    expect(busy).toMatch(/"ownerPid":\d+/);
    expect(busy).toMatch(/"lane":".*lane-[ab]"/);
    expect(busy).toMatch(/"workitem":"WI-[ab]"/);
  });

  it('classifies an existing listener as unmanaged and never starts or kills a child', async () => {
    const root = tmp();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('missing listener address');
    }
    const marker = path.join(root, 'must-not-start');
    const result = await runWithPortLease({
      installationRoot: root,
      port: address.port,
      url: `http://127.0.0.1:${address.port}/`,
      identity: {
        lane: path.join(root, 'lane'),
        branch: 'work/test',
        head: 'a'.repeat(40),
        workitem: 'WI-port',
      },
      command: [
        process.execPath,
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)}, '')`,
      ],
    });

    expect(result.status).toBe('unmanaged-listener');
    expect(fs.existsSync(marker)).toBe(false);
    expect(server.listening).toBe(true);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'forwards %s and removes only its own lease after the child exits',
    async (signal, code) => {
      const root = tmp();
      const port = await freePort();
      const start = path.join(root, 'start');
      const marker = path.join(root, 'child-started');
      const stop = path.join(root, 'stop');
      const worker = spawnContender(root, port, start, marker, stop, signal.toLowerCase());

      await waitForOutput(worker.child, worker.output, new RegExp(`READY ${signal.toLowerCase()}`));
      fs.writeFileSync(start, '');
      await waitForFile(marker);
      const held = readPortLease(root, port);
      expect(held?.childPid).toEqual(expect.any(Number));

      worker.child.kill(signal);
      expect(await waitForExit(worker.child)).toBe(code);
      expect(readPortLease(root, port)).toBeNull();
      if (held?.childPid) {
        await waitForProcessDeath(held.childPid);
      }
    },
  );

  it('recovers an abnormal stale lease only after both owner and child are dead', async () => {
    const root = tmp();
    const port = await freePort();
    const start = path.join(root, 'start');
    const marker = path.join(root, 'child-started');
    const stop = path.join(root, 'stop');
    const worker = spawnContender(root, port, start, marker, stop, 'stale');

    await waitForOutput(worker.child, worker.output, /READY stale/);
    fs.writeFileSync(start, '');
    await waitForFile(marker);
    const abandoned = readPortLease(root, port);
    expect(abandoned?.childPid).toEqual(expect.any(Number));

    worker.child.kill('SIGKILL');
    await waitForExit(worker.child);
    const whileChildLives = await acquirePortLease(root, port, {
      lane: path.join(root, 'replacement'),
      branch: 'work/replacement',
      head: 'b'.repeat(40),
      workitem: 'WI-replacement',
    });
    expect(whileChildLives.status).toBe('busy');

    if (!abandoned?.childPid) {
      throw new Error('fixture did not register a child pid');
    }
    process.kill(abandoned.childPid, 'SIGKILL');
    await waitForProcessDeath(abandoned.childPid);

    const recovered = await acquirePortLease(root, port, {
      lane: path.join(root, 'replacement'),
      branch: 'work/replacement',
      head: 'b'.repeat(40),
      workitem: 'WI-replacement',
    });
    expect(recovered.status).toBe('acquired');
    if (recovered.status === 'acquired') {
      expect(recovered.lease.token).not.toBe(abandoned.token);
      expect(await releasePortLease(root, port, recovered.lease.token)).toBe(true);
    }
  });

  it('never releases or steals a live lease when the token is foreign', async () => {
    const root = tmp();
    const port = await freePort();
    const identity = {
      lane: path.join(root, 'lane'),
      branch: 'work/live',
      head: 'c'.repeat(40),
      workitem: 'WI-live',
    };
    const held = await acquirePortLease(root, port, identity);
    expect(held.status).toBe('acquired');
    if (held.status !== 'acquired') {
      return;
    }

    expect(await releasePortLease(root, port, 'foreign-token')).toBe(false);
    expect(readPortLease(root, port)?.token).toBe(held.lease.token);
    const contender = await acquirePortLease(root, port, {
      ...identity,
      workitem: 'WI-foreign',
    });
    expect(contender).toEqual({ status: 'busy', lease: held.lease });
    expect(await releasePortLease(root, port, held.lease.token)).toBe(true);
  });

  it('inspects owned identity strictly and marks only the matching listener reusable', async () => {
    const root = tmp();
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('missing listener address');
    }
    const identity = {
      lane: path.join(root, 'lane'),
      branch: 'work/owned',
      head: 'd'.repeat(40),
      workitem: 'WI-owned',
    };
    const acquired = await acquirePortLease(root, address.port, identity);
    expect(acquired.status).toBe('unmanaged-listener');
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    const held = await acquirePortLease(root, address.port, identity);
    expect(held.status).toBe('acquired');
    if (held.status !== 'acquired') {
      return;
    }
    const updated = await updatePortLeaseChild(root, held.lease, process.pid);
    expect(updated).not.toBeNull();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: address.port }, resolve);
    });

    const owned = await inspectPortLease(root, address.port, identity, () => [process.pid]);
    expect(owned).toMatchObject({
      status: 'owned',
      listening: true,
      listenerPids: [process.pid],
      reusable: true,
    });
    const foreign = await inspectPortLease(
      root,
      address.port,
      { ...identity, head: 'e'.repeat(40) },
      () => [process.pid],
    );
    expect(foreign).toMatchObject({ status: 'foreign', reusable: false });

    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(await releasePortLease(root, address.port, held.lease.token)).toBe(true);
  });

  it('distinguishes free, unmanaged-listener, and stale inspection states', async () => {
    const root = tmp();
    const port = await freePort();
    const identity = {
      lane: path.join(root, 'lane'),
      branch: 'work/inspect',
      head: 'f'.repeat(40),
      workitem: 'WI-inspect',
    };
    expect(await inspectPortLease(root, port, identity)).toMatchObject({
      status: 'free',
      reusable: false,
    });

    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port }, resolve);
    });
    expect(await inspectPortLease(root, port, identity, () => [process.pid])).toMatchObject({
      status: 'unmanaged-listener',
      reusable: false,
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );

    const location = portLeaseLocation(root, port);
    fs.mkdirSync(location.directory, { recursive: true });
    fs.writeFileSync(
      location.leaseFile,
      `${JSON.stringify({
        ...identity,
        port,
        ownerPid: 99_999_998,
        childPid: 99_999_999,
        token: 'abandoned',
        acquiredAt: new Date(0).toISOString(),
      })}\n`,
    );
    expect(await inspectPortLease(root, port, identity)).toMatchObject({
      status: 'stale',
      reusable: false,
    });
  });
});
