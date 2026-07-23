import fs from 'node:fs';
// @ts-expect-error This fixture is executed directly with Node's --experimental-strip-types.
import { PipelineDispatchError, claimPipelineDispatch } from '../../src/core/pipeline-dispatch.ts';

const [dispatch, lane, input, start] = process.argv.slice(2) as [string, string, string, string];

while (!fs.existsSync(start)) {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

try {
  claimPipelineDispatch({
    dispatch,
    expectedLane: lane,
    expectedRole: 'exec',
    expectedWorkitem: 'work',
    expectedInput: input,
  });
  process.exitCode = 0;
} catch (error) {
  if (error instanceof PipelineDispatchError && error.code === 'DISPATCH_ALREADY_CLAIMED') {
    process.exitCode = 2;
  } else {
    throw error;
  }
}
