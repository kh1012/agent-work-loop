import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error This fixture is executed directly with Node's --experimental-strip-types.
import { runWithPortLease } from '../../src/core/port-lease.ts';

async function waitForFile(file: string): Promise<void> {
  if (fs.existsSync(file)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const directory = path.dirname(file);
    const watcher = fs.watch(directory, (event, name) => {
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

const [mode, ...args] = process.argv.slice(2);

if (mode === 'service') {
  const [marker, stop] = args as [string, string];
  fs.appendFileSync(marker, `${process.pid}\n`);
  await waitForFile(stop);
} else if (mode === 'contender') {
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
    command: [
      process.execPath,
      '--experimental-strip-types',
      new URL(import.meta.url).pathname,
      'service',
      marker,
      stop,
    ],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === 'completed' ? result.exitCode : 2;
} else {
  throw new Error(`unknown fixture mode: ${mode}`);
}
