import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRedactor, parseArgs, runHistoryCheck, SECRET_ENV_KEYS } from '../server/history-check.js';

// Plan step 3 data check. Default is a dry run (no request, no file); --live
// performs the capped calls and writes aggregates to .history-check/.
const redact = createRedactor(SECRET_ENV_KEYS.map(name => process.env[name]));
const OUT_DIR = fileURLToPath(new URL('../.history-check/', import.meta.url));

/** One redacted line, never a stack or an error message (fetch errors can carry a keyed URL). */
function fail(code: string): void {
  process.stderr.write(`${redact(`history:check 중단: ${code}`)}\n`);
  process.exitCode = 1;
}
const errorName = (error: unknown) => error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
process.on('uncaughtException', error => { fail(`unexpected_exception:${errorName(error)}`); process.exit(1); });
process.on('unhandledRejection', error => { fail(`unhandled_rejection:${errorName(error)}`); process.exit(1); });

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if ('error' in options) {
    fail(`${options.error} (사용법: npm run history:check -- [--live] [--only fsc,massive,marketaux])`);
    return;
  }
  const result = await runHistoryCheck({
    env: process.env,
    fetcher: globalThis.fetch,
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    print: line => console.log(redact(line)),
  }, options);
  if (result.mode !== 'live') return;
  await mkdir(OUT_DIR, { recursive: true });
  for (const output of result.outputs) {
    if (!/^[A-Za-z0-9._-]+$/.test(output.name)) throw new Error('bad_output_name');
    await writeFile(`${OUT_DIR}${output.name}`, redact(output.content), 'utf8');
  }
}

// Our own failures carry a fixed snake_case code as their message; anything else shows only its class name.
const failureCode = (error: unknown) => error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : errorName(error);
void main().catch(error => fail(failureCode(error)));
