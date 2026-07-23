import {
  PipelineDispatchError as DispatchError,
  type PipelineDispatchError,
  type PipelineDispatchRole,
  type PipelineGateMode,
  claimPipelineDispatch,
  issuePipelineDispatch,
  verifyPipelineDispatch,
} from '../core/pipeline-dispatch.js';

interface IssueCommandOptions {
  lane: string;
  role: string;
  workitem: string;
  input: string;
  mode: string;
  gateEvidence: string;
  ttlSeconds?: string;
  json?: boolean;
}

interface ConsumeCommandOptions {
  dispatch: string;
  lane: string;
  role: string;
  workitem: string;
  input: string;
  json?: boolean;
}

function role(value: string): PipelineDispatchRole {
  if (value !== 'exec' && value !== 'review') {
    throw new DispatchError('DISPATCH_INVALID_FIELD', '--role must be exec or review', 'role');
  }
  return value;
}

function mode(value: string): PipelineGateMode {
  const aliases: Record<string, PipelineGateMode> = {
    gh: 'gate-high',
    '--gh': 'gate-high',
    'gate-high': 'gate-high',
    gm: 'gate-medium',
    '--gm': 'gate-medium',
    'gate-medium': 'gate-medium',
    gl: 'gate-low',
    '--gl': 'gate-low',
    'gate-low': 'gate-low',
  };
  const resolved = aliases[value];
  if (!resolved) {
    throw new DispatchError(
      'DISPATCH_INVALID_FIELD',
      '--mode must be gate-high, gate-medium, or gate-low',
      'mode',
    );
  }
  return resolved;
}

function evidence(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new DispatchError(
      'DISPATCH_INVALID_FIELD',
      '--gate-evidence must be valid JSON',
      'gate.evidence',
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DispatchError(
      'DISPATCH_INVALID_FIELD',
      '--gate-evidence must be a JSON object',
      'gate.evidence',
    );
  }
  return parsed as Record<string, unknown>;
}

function ttlMs(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
    throw new DispatchError(
      'DISPATCH_INVALID_FIELD',
      '--ttl-seconds must be an integer between 1 and 86400',
      'ttlSeconds',
    );
  }
  return seconds * 1_000;
}

function output(value: Record<string, unknown>, options: { json?: boolean }, human: string): void {
  process.stdout.write(options.json ? `${JSON.stringify(value)}\n` : `${human}\n`);
}

function structuredFailure(error: unknown): void {
  if (error instanceof DispatchError) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.toJSON() })}\n`);
    process.exitCode = 1;
    return;
  }
  throw error;
}

export function runPipelineDispatchIssue(options: IssueCommandOptions): void {
  try {
    const issued = issuePipelineDispatch({
      lane: options.lane,
      role: role(options.role),
      workitem: options.workitem,
      input: options.input,
      mode: mode(options.mode),
      evidence: evidence(options.gateEvidence),
      ttlMs: ttlMs(options.ttlSeconds),
    });
    output(
      { ok: true, status: 'issued', envelopePath: issued.path, envelope: issued.envelope },
      options,
      `pipeline dispatch issued: ${issued.path}`,
    );
  } catch (error) {
    structuredFailure(error);
  }
}

function consumeOptions(options: ConsumeCommandOptions): {
  dispatch: string;
  expectedLane: string;
  expectedRole: PipelineDispatchRole;
  expectedWorkitem: string;
  expectedInput: string;
} {
  return {
    dispatch: options.dispatch,
    expectedLane: options.lane,
    expectedRole: role(options.role),
    expectedWorkitem: options.workitem,
    expectedInput: options.input,
  };
}

export function runPipelineDispatchVerify(options: ConsumeCommandOptions): void {
  try {
    const envelope = verifyPipelineDispatch(consumeOptions(options));
    output(
      { ok: true, status: 'verified', envelope },
      options,
      `pipeline dispatch verified: ${envelope.dispatchId}`,
    );
  } catch (error) {
    structuredFailure(error);
  }
}

export function runPipelineDispatchClaim(options: ConsumeCommandOptions): void {
  try {
    const result = claimPipelineDispatch(consumeOptions(options));
    output(
      {
        ok: true,
        status: 'claimed',
        claimPath: result.claimPath,
        claim: result.claim,
        envelope: result.envelope,
      },
      options,
      `pipeline dispatch claimed: ${result.envelope.dispatchId}`,
    );
  } catch (error) {
    structuredFailure(error);
  }
}

export type { PipelineDispatchError };
