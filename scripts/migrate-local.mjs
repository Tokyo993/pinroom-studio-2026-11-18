import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { configureToolEnvironment } from './tool-environment.mjs';

configureToolEnvironment(process.cwd());
let config;
try { config = JSON.parse(await readFile('dist/server/wrangler.json', 'utf8')); }
catch { console.error('Сначала выполните npm run build.'); process.exit(1); }
for (const binding of config.d1_databases || []) binding.migrations_dir = '../../drizzle';
await writeFile('dist/server/local-migrations.json', JSON.stringify(config, null, 2));
// Wrangler keeps an applied-migration ledger inside the local database.
// This command never connects to or changes the hosted database.
const result = spawnSync(process.execPath, ['--import', './scripts/sites-env.mjs',
  './node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', '--local',
  '--config', 'dist/server/local-migrations.json', '--persist-to', '.wrangler/state'],
  { stdio: ['ignore', 'inherit', 'inherit'], env: process.env });
process.exit(result.status ?? 1);
