import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error This fixture is executed directly with Node's --experimental-strip-types.
import { runWithPortLease } from '../../src/core/port-lease.ts';

async function waitForFile(file: string): Promise<void> {
  if (fs.existsSync(file)) {
    return;
  }
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(poll);
        resolve();
      }
    }, 10);
  });
}

const serviceScript = [
  "const fs = require('node:fs');",
  'const [marker, stop] = process.argv.slice(1);',
  'fs.appendFileSync(marker, `${process.pid}\\n`);',
  'if (!fs.existsSync(stop)) {',
  '  const poll = setInterval(() => {',
  '    if (fs.existsSync(stop)) clearInterval(poll);',
  '  }, 10);',
  '}',
].join('\n');

const [mode, ...args] = process.argv.slice(2);

if (mode === 'contender') {
  const [installationRoot, portRaw, start, marker, stop, label] = args as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  process.stdout.write(`READY ${label}\n`);
  await waitForFile(start);
  const result = await runWithPortLease({
    installationRoot,
    port: Number(portRaw),
    url: `http://127.0.0.1:${portRaw}/`,
    identity: {
      lane: path.join(installationRoot, `lane-${label}`),
      branch: `work/${label}`,
      head: label.repeat(40).slice(0, 40),
      workitem: `WI-${label}`,
    },
    command: [process.execPath, '-e', serviceScript, marker, stop],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'completed' ? result.exitCode : 2;
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
