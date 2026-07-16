const dryRun =
  process.env.npm_config_dry_run === 'true' ||
  process.env.npm_config_dry_run === '1' ||
  process.argv.includes('--dry-run');
if (dryRun || process.env.AWL_ALLOW_PUBLISH === '1') process.exit(0);
console.error(
  '❌ awl: npm publish is blocked. A human must explicitly set AWL_ALLOW_PUBLISH=1 after review.',
);
process.exit(1);
