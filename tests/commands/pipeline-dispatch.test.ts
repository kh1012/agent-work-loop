import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runPipelineDispatchClaim,
  runPipelineDispatchIssue,
  runPipelineDispatchVerify,
} from '../../src/commands/pipeline-dispatch.js';
import {
  PIPELINE_DISPATCH_VERSION,
  type PipelineDispatchEnvelope,
  PipelineDispatchError,
  claimPipelineDispatch,
  issuePipelineDispatch,
  sha256File,
  validatePipelineDispatchEnvelope,
  verifyPipelineDispatch,
} from '../../src/core/pipeline-dispatch.js';
import { buildProgram } from '../../src/program.js';

const roots: string[] = [];

function fixture(): {
  lane: string;
  input: string;
  envelope: PipelineDispatchEnvelope;
} {
  const lane = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awl-dispatch-')));
  roots.push(lane);
  const planDir = path.join(lane, '.tasks', 'plan');
  fs.mkdirSync(planDir, { recursive: true });
  const input = path.join(planDir, 'work.md');
  fs.writeFileSync(input, '# work\n');
  return {
    lane,
    input,
    envelope: {
      version: PIPELINE_DISPATCH_VERSION,
      dispatchId: `dispatch_${crypto.randomBytes(12).toString('hex')}`,
      nonce: crypto.randomBytes(24).toString('hex'),
      lane,
      role: 'exec',
      workitem: 'work',
      input: {
        path: input,
        sha256: sha256File(input),
      },
      gate: {
        mode: 'gate-low',
        autoApprove: true,
        recordOwner: 'coordinator',
        evidence: {
          gate1Record: 'rec_123',
          plan: input,
        },
      },
      noSubagents: true,
      issuedAt: '2026-07-23T00:00:00.000Z',
      expiresAt: '2026-07-23T01:00:00.000Z',
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function errorCode(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(PipelineDispatchError);
    return (error as PipelineDispatchError).code;
  }
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

describe('pipeline dispatch envelope schema', () => {
  it('accepts the complete versioned dispatch contract and canonical input digest', () => {
    const { lane, input, envelope } = fixture();
    const result = validatePipelineDispatchEnvelope(envelope, {
      expectedLane: lane,
      expectedRole: 'exec',
      expectedWorkitem: 'work',
      expectedInput: input,
      now: new Date('2026-07-23T00:30:00.000Z'),
    });

    expect(result).toEqual(envelope);
  });

  it('rejects unknown and missing fields with structured codes', () => {
    const { envelope } = fixture();
    expect(
      errorCode(() =>
        validatePipelineDispatchEnvelope(
          { ...envelope, unexpected: true },
          { now: new Date('2026-07-23T00:30:00.000Z') },
        ),
      ),
    ).toBe('DISPATCH_UNKNOWN_FIELD');

    const missing = { ...envelope } as Record<string, unknown>;
    delete missing.nonce;
    expect(
      errorCode(() =>
        validatePipelineDispatchEnvelope(missing, {
          now: new Date('2026-07-23T00:30:00.000Z'),
        }),
      ),
    ).toBe('DISPATCH_MISSING_FIELD');
  });

  it('rejects path escape, content tampering, and expiry before claim', () => {
    const { lane, input, envelope } = fixture();
    const outside = path.join(path.dirname(lane), `${path.basename(lane)}-outside.md`);
    fs.writeFileSync(outside, 'outside\n');
    roots.push(outside);

    expect(
      errorCode(() =>
        validatePipelineDispatchEnvelope(
          { ...envelope, input: { path: outside, sha256: sha256File(outside) } },
          { now: new Date('2026-07-23T00:30:00.000Z') },
        ),
      ),
    ).toBe('DISPATCH_INPUT_OUTSIDE_LANE');

    fs.appendFileSync(input, 'tampered\n');
    expect(
      errorCode(() =>
        validatePipelineDispatchEnvelope(envelope, {
          now: new Date('2026-07-23T00:30:00.000Z'),
        }),
      ),
    ).toBe('DISPATCH_INPUT_HASH_MISMATCH');

    const refreshed = {
      ...envelope,
      input: { ...envelope.input, sha256: sha256File(input) },
    };
    expect(
      errorCode(() =>
        validatePipelineDispatchEnvelope(refreshed, {
          now: new Date('2026-07-23T01:00:00.001Z'),
        }),
      ),
    ).toBe('DISPATCH_EXPIRED');
  });
});

describe('pipeline dispatch issue, verify, and one-time claim', () => {
  it('atomically issues an envelope under the lane and verifies exact routing expectations', () => {
    const { lane, input } = fixture();
    const issued = issuePipelineDispatch({
      lane,
      role: 'exec',
      workitem: 'work',
      input,
      mode: 'gate-low',
      evidence: { gate1Record: 'rec_123', plan: input },
      now: new Date('2026-07-23T00:00:00.000Z'),
      ttlMs: 60_000,
    });

    expect(path.dirname(issued.path)).toBe(path.join(lane, '.tasks', 'dispatch'));
    expect(fs.existsSync(issued.path)).toBe(true);
    expect(
      fs.readdirSync(path.dirname(issued.path)).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
    expect(
      verifyPipelineDispatch({
        dispatch: issued.path,
        expectedLane: lane,
        expectedRole: 'exec',
        expectedWorkitem: 'work',
        expectedInput: input,
        now: new Date('2026-07-23T00:00:30.000Z'),
      }),
    ).toEqual(issued.envelope);
  });

  it('allows exactly one claim and leaves the routed input untouched on replay', () => {
    const { lane, input } = fixture();
    const issued = issuePipelineDispatch({
      lane,
      role: 'exec',
      workitem: 'work',
      input,
      mode: 'gate-low',
      evidence: { gate1Record: 'rec_123', plan: input },
    });
    const before = fs.readFileSync(input, 'utf8');
    const first = claimPipelineDispatch({
      dispatch: issued.path,
      expectedLane: lane,
      expectedRole: 'exec',
      expectedWorkitem: 'work',
      expectedInput: input,
    });

    expect(first.claim.envelopeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      errorCode(() =>
        claimPipelineDispatch({
          dispatch: issued.path,
          expectedLane: lane,
          expectedRole: 'exec',
          expectedWorkitem: 'work',
          expectedInput: input,
        }),
      ),
    ).toBe('DISPATCH_ALREADY_CLAIMED');
    expect(fs.readFileSync(input, 'utf8')).toBe(before);
  });

  it('lets exactly one of two processes claim the same envelope', async () => {
    const { lane, input } = fixture();
    const issued = issuePipelineDispatch({
      lane,
      role: 'exec',
      workitem: 'work',
      input,
      mode: 'gate-low',
      evidence: { gate1Record: 'rec_123', plan: input },
    });
    const start = path.join(lane, 'start');
    const worker = path.resolve('tests/fixtures/pipeline-dispatch-claim-worker.ts');
    const args = [worker, issued.path, lane, input, start];
    const first = spawn(process.execPath, ['--experimental-strip-types', ...args]);
    const second = spawn(process.execPath, ['--experimental-strip-types', ...args]);

    fs.writeFileSync(start, '');
    const codes = await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(codes.sort()).toEqual([0, 2]);
    const claimDir = `${issued.path}.claimed`;
    expect(fs.readdirSync(claimDir)).toEqual(['claim.json']);
  });

  it('wires issue, verify, and claim commands with resolved routing options', () => {
    const program = buildProgram();
    const dispatch = program.commands.find((command) => command.name() === 'pipeline-dispatch');
    const issue = dispatch?.commands.find((command) => command.name() === 'issue');
    const verify = dispatch?.commands.find((command) => command.name() === 'verify');
    const claim = dispatch?.commands.find((command) => command.name() === 'claim');

    expect(issue?.options.map((option) => option.long)).toEqual(
      expect.arrayContaining([
        '--lane',
        '--role',
        '--workitem',
        '--input',
        '--mode',
        '--gate-evidence',
        '--ttl-seconds',
        '--json',
      ]),
    );
    for (const command of [verify, claim]) {
      expect(command?.options.map((option) => option.long)).toEqual(
        expect.arrayContaining([
          '--dispatch',
          '--lane',
          '--role',
          '--workitem',
          '--input',
          '--json',
        ]),
      );
    }
  });

  it('exports command runners for skill-owned JSON execution', () => {
    expect(runPipelineDispatchIssue).toBeTypeOf('function');
    expect(runPipelineDispatchVerify).toBeTypeOf('function');
    expect(runPipelineDispatchClaim).toBeTypeOf('function');
  });
});
