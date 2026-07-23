import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PIPELINE_DISPATCH_VERSION = 1 as const;

export type PipelineDispatchRole = 'exec' | 'review';
export type PipelineGateMode = 'gate-high' | 'gate-medium' | 'gate-low';

export interface PipelineDispatchEnvelope {
  version: typeof PIPELINE_DISPATCH_VERSION;
  dispatchId: string;
  nonce: string;
  lane: string;
  role: PipelineDispatchRole;
  workitem: string;
  input: {
    path: string;
    sha256: string;
  };
  gate: {
    mode: PipelineGateMode;
    autoApprove: boolean;
    recordOwner: 'coordinator';
    evidence: Record<string, unknown>;
  };
  noSubagents: boolean;
  issuedAt: string;
  expiresAt: string;
}

export type PipelineDispatchErrorCode =
  | 'DISPATCH_INVALID_DOCUMENT'
  | 'DISPATCH_DOCUMENT_READ_FAILED'
  | 'DISPATCH_MISSING_FIELD'
  | 'DISPATCH_UNKNOWN_FIELD'
  | 'DISPATCH_INVALID_FIELD'
  | 'DISPATCH_UNSUPPORTED_VERSION'
  | 'DISPATCH_PATH_OUTSIDE_LANE'
  | 'DISPATCH_LANE_MISMATCH'
  | 'DISPATCH_ROLE_MISMATCH'
  | 'DISPATCH_WORKITEM_MISMATCH'
  | 'DISPATCH_INPUT_MISMATCH'
  | 'DISPATCH_INPUT_OUTSIDE_LANE'
  | 'DISPATCH_INPUT_HASH_MISMATCH'
  | 'DISPATCH_EXPIRED'
  | 'DISPATCH_ALREADY_CLAIMED';

export class PipelineDispatchError extends Error {
  readonly code: PipelineDispatchErrorCode;
  readonly field?: string;

  constructor(code: PipelineDispatchErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'PipelineDispatchError';
    this.code = code;
    this.field = field;
  }

  toJSON(): { code: PipelineDispatchErrorCode; message: string; field?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.field ? { field: this.field } : {}),
    };
  }
}

export interface ValidatePipelineDispatchOptions {
  expectedLane?: string;
  expectedRole?: PipelineDispatchRole;
  expectedWorkitem?: string;
  expectedInput?: string;
  now?: Date;
}

export interface IssuePipelineDispatchOptions {
  lane: string;
  role: PipelineDispatchRole;
  workitem: string;
  input: string;
  mode: PipelineGateMode;
  evidence: Record<string, unknown>;
  now?: Date;
  ttlMs?: number;
}

export interface VerifyPipelineDispatchOptions {
  dispatch: string;
  expectedLane: string;
  expectedRole: PipelineDispatchRole;
  expectedWorkitem: string;
  expectedInput: string;
  now?: Date;
}

export interface PipelineDispatchClaim {
  dispatchId: string;
  nonce: string;
  envelopeSha256: string;
  claimedAt: string;
  consumerPid: number;
}

function fail(code: PipelineDispatchErrorCode, message: string, field?: string): never {
  throw new PipelineDispatchError(code, message, field);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('DISPATCH_INVALID_FIELD', `${field} must be an object`, field);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      fail(
        'DISPATCH_MISSING_FIELD',
        `${field === '' ? '' : `${field}.`}${key} is required`,
        field === '' ? key : `${field}.${key}`,
      );
    }
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(
        'DISPATCH_UNKNOWN_FIELD',
        `${field === '' ? '' : `${field}.`}${key} is not allowed`,
        field === '' ? key : `${field}.${key}`,
      );
    }
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('DISPATCH_INVALID_FIELD', `${field} must be a non-empty string`, field);
  }
  return value;
}

function canonicalExistingPath(value: unknown, field: string): string {
  const candidate = nonEmptyString(value, field);
  if (!path.isAbsolute(candidate)) {
    fail('DISPATCH_INVALID_FIELD', `${field} must be absolute`, field);
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(candidate);
  } catch {
    fail('DISPATCH_INVALID_FIELD', `${field} does not exist`, field);
  }
  if (canonical !== candidate) {
    fail('DISPATCH_INVALID_FIELD', `${field} must be canonical`, field);
  }
  return canonical;
}

function isoTimestamp(value: unknown, field: string): { raw: string; time: number } {
  const raw = nonEmptyString(value, field);
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== raw) {
    fail('DISPATCH_INVALID_FIELD', `${field} must be an ISO-8601 UTC timestamp`, field);
  }
  return { raw, time };
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readDispatchDocument(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail('DISPATCH_DOCUMENT_READ_FAILED', 'dispatch document could not be read', 'dispatch');
  }
  try {
    return JSON.parse(raw);
  } catch {
    fail('DISPATCH_INVALID_DOCUMENT', 'dispatch document is not valid JSON', 'dispatch');
  }
}

function dispatchDirectory(lane: string): string {
  return path.join(lane, '.tasks', 'dispatch');
}

function canonicalDispatchPath(dispatch: string, lane: string): string {
  if (!path.isAbsolute(dispatch)) {
    fail('DISPATCH_INVALID_FIELD', 'dispatch path must be absolute', 'dispatch');
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(dispatch);
  } catch {
    fail('DISPATCH_DOCUMENT_READ_FAILED', 'dispatch document could not be read', 'dispatch');
  }
  if (
    canonical !== dispatch ||
    path.dirname(canonical) !== dispatchDirectory(lane) ||
    path.extname(canonical) !== '.json'
  ) {
    fail(
      'DISPATCH_PATH_OUTSIDE_LANE',
      'dispatch path must be a canonical JSON file directly inside lane .tasks/dispatch',
      'dispatch',
    );
  }
  return canonical;
}

export function validatePipelineDispatchEnvelope(
  value: unknown,
  options: ValidatePipelineDispatchOptions = {},
): PipelineDispatchEnvelope {
  const envelope = record(value, 'dispatch');
  exactKeys(
    envelope,
    [
      'version',
      'dispatchId',
      'nonce',
      'lane',
      'role',
      'workitem',
      'input',
      'gate',
      'noSubagents',
      'issuedAt',
      'expiresAt',
    ],
    '',
  );

  if (envelope.version !== PIPELINE_DISPATCH_VERSION) {
    fail('DISPATCH_UNSUPPORTED_VERSION', `version must be ${PIPELINE_DISPATCH_VERSION}`, 'version');
  }
  const dispatchId = nonEmptyString(envelope.dispatchId, 'dispatchId');
  if (!/^dispatch_[a-f0-9]{24}$/.test(dispatchId)) {
    fail(
      'DISPATCH_INVALID_FIELD',
      'dispatchId must be dispatch_ plus 24 lowercase hex chars',
      'dispatchId',
    );
  }
  const nonce = nonEmptyString(envelope.nonce, 'nonce');
  if (!/^[a-f0-9]{48}$/.test(nonce)) {
    fail('DISPATCH_INVALID_FIELD', 'nonce must be 48 lowercase hex chars', 'nonce');
  }

  const lane = canonicalExistingPath(envelope.lane, 'lane');
  const role = envelope.role;
  if (role !== 'exec' && role !== 'review') {
    fail('DISPATCH_INVALID_FIELD', 'role must be exec or review', 'role');
  }
  const workitem = nonEmptyString(envelope.workitem, 'workitem');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(workitem)) {
    fail('DISPATCH_INVALID_FIELD', 'workitem contains unsupported characters', 'workitem');
  }

  const input = record(envelope.input, 'input');
  exactKeys(input, ['path', 'sha256'], 'input');
  const inputPath = canonicalExistingPath(input.path, 'input.path');
  if (!fs.statSync(inputPath).isFile()) {
    fail('DISPATCH_INVALID_FIELD', 'input.path must identify a file', 'input.path');
  }
  if (!isInside(path.join(lane, '.tasks'), inputPath)) {
    fail(
      'DISPATCH_INPUT_OUTSIDE_LANE',
      'input.path must remain inside the lane .tasks directory',
      'input.path',
    );
  }
  const inputSha256 = nonEmptyString(input.sha256, 'input.sha256');
  if (!/^[a-f0-9]{64}$/.test(inputSha256)) {
    fail('DISPATCH_INVALID_FIELD', 'input.sha256 must be 64 lowercase hex chars', 'input.sha256');
  }
  if (sha256File(inputPath) !== inputSha256) {
    fail(
      'DISPATCH_INPUT_HASH_MISMATCH',
      'input content does not match the issued SHA-256',
      'input.sha256',
    );
  }

  const gate = record(envelope.gate, 'gate');
  exactKeys(gate, ['mode', 'autoApprove', 'recordOwner', 'evidence'], 'gate');
  const mode = gate.mode;
  if (mode !== 'gate-high' && mode !== 'gate-medium' && mode !== 'gate-low') {
    fail('DISPATCH_INVALID_FIELD', 'gate.mode is invalid', 'gate.mode');
  }
  if (typeof gate.autoApprove !== 'boolean') {
    fail('DISPATCH_INVALID_FIELD', 'gate.autoApprove must be boolean', 'gate.autoApprove');
  }
  if ((mode === 'gate-high') === gate.autoApprove) {
    fail(
      'DISPATCH_INVALID_FIELD',
      'gate.autoApprove must be false for gate-high and true otherwise',
      'gate.autoApprove',
    );
  }
  if (gate.recordOwner !== 'coordinator') {
    fail('DISPATCH_INVALID_FIELD', 'gate.recordOwner must be coordinator', 'gate.recordOwner');
  }
  const evidence = record(gate.evidence, 'gate.evidence');
  if (Object.keys(evidence).length === 0) {
    fail('DISPATCH_INVALID_FIELD', 'gate.evidence must not be empty', 'gate.evidence');
  }
  const evidenceKind = nonEmptyString(evidence.kind, 'gate.evidence.kind');
  const evidenceSource = nonEmptyString(evidence.source, 'gate.evidence.source');
  nonEmptyString(evidence.gate1Record, 'gate.evidence.gate1Record');
  nonEmptyString(evidence.plan, 'gate.evidence.plan');
  if (mode === 'gate-high') {
    if (evidenceKind !== 'human' || evidenceSource !== 'human-decision') {
      fail(
        'DISPATCH_INVALID_FIELD',
        'gate-high requires human evidence from human-decision',
        'gate.evidence',
      );
    }
    nonEmptyString(evidence.humanDecision, 'gate.evidence.humanDecision');
  } else if (evidenceKind !== 'auto' || evidenceSource !== 'pipeline-mode') {
    fail(
      'DISPATCH_INVALID_FIELD',
      `${mode} requires automatic evidence from pipeline-mode`,
      'gate.evidence',
    );
  }
  if (envelope.noSubagents !== true) {
    fail('DISPATCH_INVALID_FIELD', 'noSubagents must be true', 'noSubagents');
  }

  const issuedAt = isoTimestamp(envelope.issuedAt, 'issuedAt');
  const expiresAt = isoTimestamp(envelope.expiresAt, 'expiresAt');
  if (expiresAt.time <= issuedAt.time) {
    fail('DISPATCH_INVALID_FIELD', 'expiresAt must be after issuedAt', 'expiresAt');
  }
  if ((options.now ?? new Date()).getTime() > expiresAt.time) {
    fail('DISPATCH_EXPIRED', `dispatch expired at ${expiresAt.raw}`, 'expiresAt');
  }

  if (options.expectedLane) {
    const expectedLane = fs.realpathSync(options.expectedLane);
    if (lane !== expectedLane) {
      fail('DISPATCH_LANE_MISMATCH', 'dispatch lane does not match expected lane', 'lane');
    }
  }
  if (options.expectedRole && role !== options.expectedRole) {
    fail('DISPATCH_ROLE_MISMATCH', 'dispatch role does not match expected role', 'role');
  }
  if (options.expectedWorkitem && workitem !== options.expectedWorkitem) {
    fail(
      'DISPATCH_WORKITEM_MISMATCH',
      'dispatch workitem does not match expected workitem',
      'workitem',
    );
  }
  if (options.expectedInput) {
    const expectedInput = fs.realpathSync(options.expectedInput);
    if (inputPath !== expectedInput) {
      fail('DISPATCH_INPUT_MISMATCH', 'dispatch input does not match expected input', 'input.path');
    }
  }

  return {
    version: PIPELINE_DISPATCH_VERSION,
    dispatchId,
    nonce,
    lane,
    role,
    workitem,
    input: { path: inputPath, sha256: inputSha256 },
    gate: {
      mode,
      autoApprove: gate.autoApprove,
      recordOwner: 'coordinator',
      evidence,
    },
    noSubagents: true,
    issuedAt: issuedAt.raw,
    expiresAt: expiresAt.raw,
  };
}

export function issuePipelineDispatch(options: IssuePipelineDispatchOptions): {
  path: string;
  envelope: PipelineDispatchEnvelope;
} {
  const lane = canonicalExistingPath(options.lane, 'lane');
  const input = canonicalExistingPath(options.input, 'input.path');
  const ttlMs = options.ttlMs ?? 30 * 60 * 1_000;
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60 * 1_000) {
    fail('DISPATCH_INVALID_FIELD', 'ttlMs must be an integer between 1 and 86400000', 'ttlMs');
  }
  const issuedAt = options.now ?? new Date();
  const candidate: PipelineDispatchEnvelope = {
    version: PIPELINE_DISPATCH_VERSION,
    dispatchId: `dispatch_${crypto.randomBytes(12).toString('hex')}`,
    nonce: crypto.randomBytes(24).toString('hex'),
    lane,
    role: options.role,
    workitem: options.workitem,
    input: {
      path: input,
      sha256: sha256File(input),
    },
    gate: {
      mode: options.mode,
      autoApprove: options.mode !== 'gate-high',
      recordOwner: 'coordinator',
      evidence: options.evidence,
    },
    noSubagents: true,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString(),
  };

  let durable: unknown;
  try {
    durable = JSON.parse(JSON.stringify(candidate));
  } catch {
    fail('DISPATCH_INVALID_FIELD', 'dispatch evidence must be JSON serializable', 'gate.evidence');
  }
  const envelope = validatePipelineDispatchEnvelope(durable, {
    expectedLane: lane,
    expectedRole: options.role,
    expectedWorkitem: options.workitem,
    expectedInput: input,
    now: issuedAt,
  });
  const directory = dispatchDirectory(lane);
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${envelope.dispatchId}.json`);
  const temporary = path.join(directory, `.${envelope.dispatchId}.tmp-${process.pid}`);
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(envelope, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { path: target, envelope };
}

export function verifyPipelineDispatch(
  options: VerifyPipelineDispatchOptions,
): PipelineDispatchEnvelope {
  const lane = canonicalExistingPath(options.expectedLane, 'expectedLane');
  const dispatch = canonicalDispatchPath(options.dispatch, lane);
  return validatePipelineDispatchEnvelope(readDispatchDocument(dispatch), {
    expectedLane: lane,
    expectedRole: options.expectedRole,
    expectedWorkitem: options.expectedWorkitem,
    expectedInput: options.expectedInput,
    now: options.now,
  });
}

export function claimPipelineDispatch(options: VerifyPipelineDispatchOptions): {
  envelope: PipelineDispatchEnvelope;
  claimPath: string;
  claim: PipelineDispatchClaim;
} {
  const envelope = verifyPipelineDispatch(options);
  const claimPath = `${options.dispatch}.claimed`;
  try {
    fs.mkdirSync(claimPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      fail(
        'DISPATCH_ALREADY_CLAIMED',
        `dispatch ${envelope.dispatchId} was already claimed`,
        'dispatch',
      );
    }
    throw error;
  }

  try {
    const reverified = verifyPipelineDispatch(options);
    const claim: PipelineDispatchClaim = {
      dispatchId: reverified.dispatchId,
      nonce: reverified.nonce,
      envelopeSha256: sha256File(options.dispatch),
      claimedAt: (options.now ?? new Date()).toISOString(),
      consumerPid: process.pid,
    };
    fs.writeFileSync(path.join(claimPath, 'claim.json'), `${JSON.stringify(claim, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { envelope: reverified, claimPath, claim };
  } catch (error) {
    fs.rmSync(claimPath, { recursive: true, force: true });
    throw error;
  }
}
