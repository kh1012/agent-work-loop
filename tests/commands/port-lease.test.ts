import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseServicePort, resolveServiceUrl } from '../../src/commands/port-lease.js';
import {
  acquirePortLease,
  portLeaseLocation,
  readPortLease,
  releasePortLease,
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
    expect(run).toBeDefined();
    expect(run?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining(['--port', '--workitem', '--url', '--json']),
    );
  });
});
