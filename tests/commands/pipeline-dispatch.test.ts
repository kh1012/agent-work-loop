import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PIPELINE_DISPATCH_VERSION,
  type PipelineDispatchEnvelope,
  PipelineDispatchError,
  sha256File,
  validatePipelineDispatchEnvelope,
} from '../../src/core/pipeline-dispatch.js';

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
