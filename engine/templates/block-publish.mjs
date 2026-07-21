import fs from 'node:fs';

const dryRun =
  process.env.npm_config_dry_run === 'true' ||
  process.env.npm_config_dry_run === '1' ||
  process.argv.includes('--dry-run');

// Same rationale as engine/templates/pre-push.sample: this script can't tell
// a human's `npm publish` apart from one an agent ran programmatically, so
// it checks for a controlling terminal instead of demanding the override
// variable from everyone.
function hasControllingTerminal() {
  try {
    fs.closeSync(fs.openSync('/dev/tty', 'r+'));
    return true;
  } catch {
    return false;
  }
}

if (dryRun || process.env.AWL_ALLOW_PUBLISH === '1' || hasControllingTerminal()) {
  process.exit(0);
}
console.error(
  '❌ awl: npm publish is blocked (no interactive terminal detected). A human at a terminal can publish directly; otherwise set AWL_ALLOW_PUBLISH=1 after review.',
);
process.exit(1);
