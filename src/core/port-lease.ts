import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface PortLeaseIdentity {
  lane: string;
  branch: string;
  head: string;
  workitem: string;
}

export interface PortLeaseRecord extends PortLeaseIdentity {
  port: number;
  ownerPid: number;
  childPid: number | null;
  token: string;
  acquiredAt: string;
}

export interface PortLeaseLocation {
  directory: string;
  leaseFile: string;
  guardFile: string;
}

export type PortLeaseAcquireResult =
  | { status: 'acquired'; lease: PortLeaseRecord }
  | { status: 'busy'; lease: PortLeaseRecord | null }
  | { status: 'unmanaged-listener'; lease: PortLeaseRecord | null };

export interface PortLeaseRunOptions {
  installationRoot: string;
  port: number;
  url: string;
  identity: PortLeaseIdentity;
  command: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onStarted?: (lease: PortLeaseRecord) => void;
}

export type PortLeaseRunResult =
  | { status: 'completed'; lease: PortLeaseRecord; exitCode: number; cleanup: boolean }
  | { status: 'busy'; lease: PortLeaseRecord | null }
  | { status: 'unmanaged-listener'; lease: PortLeaseRecord | null };

const HOST = '127.0.0.1';
const GUARD_RETRY_MS = 5;
const GUARD_RETRIES = 200;

export function portLeaseLocation(installationRoot: string, port: number): PortLeaseLocation {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid service port: ${port}`);
  }
  const directory = path.join(path.resolve(installationRoot), 'leases', 'ports');
  return {
    directory,
    leaseFile: path.join(directory, `${port}.json`),
    guardFile: path.join(directory, `${port}.lock`),
  };
}

function writeExclusiveJson(target: string, value: unknown): boolean {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.linkSync(temporary, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw error;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // The temporary name is best-effort cleanup; the linked target remains valid.
    }
  }
}

function writeAtomicJson(target: string, value: unknown): void {
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, target);
}

export function isProcessAlive(pid: number | null): boolean {
  if (!Number.isInteger(pid) || (pid ?? 0) <= 0) {
    return false;
  }
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readPortLease(installationRoot: string, port: number): PortLeaseRecord | null {
  const { leaseFile } = portLeaseLocation(installationRoot, port);
  try {
    const parsed = JSON.parse(fs.readFileSync(leaseFile, 'utf8')) as PortLeaseRecord;
    if (
      parsed.port !== port ||
      typeof parsed.lane !== 'string' ||
      typeof parsed.branch !== 'string' ||
      typeof parsed.head !== 'string' ||
      typeof parsed.workitem !== 'string' ||
      typeof parsed.ownerPid !== 'number' ||
      (parsed.childPid !== null && typeof parsed.childPid !== 'number') ||
      typeof parsed.token !== 'string' ||
      typeof parsed.acquiredAt !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function isPortLeaseStale(lease: PortLeaseRecord): boolean {
  return !isProcessAlive(lease.ownerPid) && !isProcessAlive(lease.childPid);
}

export async function isPortListening(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(true);
        return;
      }
      reject(error);
    });
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(false);
        }
      });
    });
  });
}

function readGuardOwner(guardFile: string): number | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(guardFile, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}

async function acquireGuard(location: PortLeaseLocation, token: string): Promise<void> {
  fs.mkdirSync(location.directory, { recursive: true });
  for (let attempt = 0; attempt < GUARD_RETRIES; attempt += 1) {
    if (
      writeExclusiveJson(location.guardFile, {
        pid: process.pid,
        token,
        acquiredAt: new Date().toISOString(),
      })
    ) {
      return;
    }

    const ownerPid = readGuardOwner(location.guardFile);
    if (ownerPid !== null && !isProcessAlive(ownerPid)) {
      const claimed = `${location.guardFile}.${process.pid}.${crypto.randomUUID()}.stale`;
      try {
        fs.renameSync(location.guardFile, claimed);
        fs.unlinkSync(claimed);
      } catch {
        // Another contender recovered or released the guard first.
      }
      continue;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, GUARD_RETRY_MS));
  }
  throw new Error(`timed out waiting for port lease guard: ${location.guardFile}`);
}

function releaseGuard(location: PortLeaseLocation, token: string): void {
  try {
    const parsed = JSON.parse(fs.readFileSync(location.guardFile, 'utf8')) as {
      token?: unknown;
    };
    if (parsed.token !== token) {
      return;
    }
    fs.unlinkSync(location.guardFile);
  } catch {
    // A missing guard is already released.
  }
}

async function withGuard<T>(
  installationRoot: string,
  port: number,
  operation: (location: PortLeaseLocation) => Promise<T> | T,
): Promise<T> {
  const location = portLeaseLocation(installationRoot, port);
  const guardToken = crypto.randomUUID();
  await acquireGuard(location, guardToken);
  try {
    return await operation(location);
  } finally {
    releaseGuard(location, guardToken);
  }
}

export async function acquirePortLease(
  installationRoot: string,
  port: number,
  identity: PortLeaseIdentity,
): Promise<PortLeaseAcquireResult> {
  return await withGuard(installationRoot, port, async (location) => {
    const existing = readPortLease(installationRoot, port);
    if (existing && !isPortLeaseStale(existing)) {
      return { status: 'busy' as const, lease: existing };
    }

    const listening = await isPortListening(port);
    if (listening) {
      return { status: 'unmanaged-listener' as const, lease: existing };
    }

    if (existing) {
      try {
        fs.unlinkSync(location.leaseFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    } else if (fs.existsSync(location.leaseFile)) {
      return { status: 'busy' as const, lease: null };
    }

    const lease: PortLeaseRecord = {
      port,
      lane: path.resolve(identity.lane),
      branch: identity.branch,
      head: identity.head,
      workitem: identity.workitem,
      ownerPid: process.pid,
      childPid: null,
      token: crypto.randomUUID(),
      acquiredAt: new Date().toISOString(),
    };
    if (!writeExclusiveJson(location.leaseFile, lease)) {
      return {
        status: 'busy' as const,
        lease: readPortLease(installationRoot, port),
      };
    }
    return { status: 'acquired' as const, lease };
  });
}

export async function updatePortLeaseChild(
  installationRoot: string,
  lease: PortLeaseRecord,
  childPid: number,
): Promise<PortLeaseRecord | null> {
  return await withGuard(installationRoot, lease.port, (location) => {
    const current = readPortLease(installationRoot, lease.port);
    if (!current || current.token !== lease.token) {
      return null;
    }
    const updated = { ...current, childPid };
    writeAtomicJson(location.leaseFile, updated);
    return updated;
  });
}

export async function releasePortLease(
  installationRoot: string,
  port: number,
  token: string,
): Promise<boolean> {
  return await withGuard(installationRoot, port, (location) => {
    const current = readPortLease(installationRoot, port);
    if (!current || current.token !== token) {
      return false;
    }
    fs.unlinkSync(location.leaseFile);
    return true;
  });
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === 'SIGINT') {
    return 130;
  }
  if (signal === 'SIGTERM') {
    return 143;
  }
  return signal ? 1 : 0;
}

export async function runWithPortLease(options: PortLeaseRunOptions): Promise<PortLeaseRunResult> {
  if (options.command.length === 0) {
    throw new Error('service command is required after --');
  }

  const acquired = await acquirePortLease(options.installationRoot, options.port, options.identity);
  if (acquired.status !== 'acquired') {
    return acquired;
  }
  let lease = acquired.lease;

  const [executable, ...args] = options.command;
  const child = spawn(executable as string, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      PORT: String(options.port),
      AWL_PORT: String(options.port),
      AWL_SERVICE_URL: options.url,
    },
    stdio: 'inherit',
  });

  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid && isProcessAlive(child.pid)) {
      try {
        child.kill(signal);
      } catch {
        // The child may have exited between the liveness check and signal delivery.
      }
    }
  };
  const onSigint = (): void => forward('SIGINT');
  const onSigterm = (): void => forward('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('spawn', async () => {
          if (!child.pid) {
            reject(new Error('service child started without a pid'));
            return;
          }
          try {
            const updated = await updatePortLeaseChild(options.installationRoot, lease, child.pid);
            if (!updated) {
              child.kill('SIGTERM');
              reject(new Error('lost port lease before service child registration'));
              return;
            }
            lease = updated;
            options.onStarted?.(lease);
          } catch (error) {
            child.kill('SIGTERM');
            reject(error);
          }
        });
        child.once('exit', (code, signal) => resolve({ code, signal }));
      },
    );
    const cleanup = await releasePortLease(options.installationRoot, lease.port, lease.token);
    return {
      status: 'completed',
      lease,
      exitCode: outcome.code ?? signalExitCode(outcome.signal),
      cleanup,
    };
  } catch (error) {
    await releasePortLease(options.installationRoot, lease.port, lease.token);
    throw error;
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }
}
