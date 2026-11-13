import 'dotenv/config';
import { get } from '@vercel/blob';
import {
  MISSING_TOKEN_LINE, STATUS_TOKEN_ENV, TOKEN_FORMAT_LINE, blobTokenProblem, createReadOnlyBlobHistoryStore, everyReadFailed,
  formatHistoryStatus, readHistoryStatus,
} from '../server/history-status.js';
import { createRedactor, unsafeNetworkEnv } from '../server/price-wire.js';

// Plan step 5 check (appendix E-2, E-3): reads the private news-history/v1/ files and prints their state.
// The token comes only from HISTORY_STATUS_BLOB_TOKEN, never BLOB_READ_WRITE_TOKEN: that name switches the
// local server's snapshot and history stores on, so a status token stored under it would let `npm run dev`
// read and write production files. The store this builds has no write method and a put that throws.
const token = process.env[STATUS_TOKEN_ENV]?.trim() ?? '';
const redact = createRedactor([token, process.env.BLOB_READ_WRITE_TOKEN]);

function print(line: string): void {
  console.log(redact(line));
}

/** One redacted line, never a stack or an error message. */
function fail(code: string): void {
  process.stderr.write(`${redact(`history:status 중단: ${code}`)}\n`);
  process.exitCode = 1;
}
const errorName = (error: unknown) => error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'unknown';
process.on('uncaughtException', error => { fail(`unexpected_exception:${errorName(error)}`); process.exit(1); });
process.on('unhandledRejection', error => { fail(`unhandled_rejection:${errorName(error)}`); process.exit(1); });

async function main(): Promise<void> {
  const problem = blobTokenProblem(token);
  if (problem) {
    process.stderr.write(`${redact(problem === 'missing' ? MISSING_TOKEN_LINE : TOKEN_FORMAT_LINE)}\n`);
    process.exitCode = 1;
    return;
  }
  // NODE_DEBUG=fetch and the like make Node print requests itself, past this redactor.
  const unsafe = unsafeNetworkEnv(process.env);
  if (unsafe) {
    fail(unsafe === 'node_debug_set'
      ? 'node_debug_set (NODE_DEBUG가 켜져 있으면 Node가 요청 정보를 직접 출력할 수 있습니다. 새 터미널 창에서 다시 실행하세요.)'
      : 'tls_unverified (NODE_TLS_REJECT_UNAUTHORIZED=0이면 토큰이 검증되지 않은 연결로 갈 수 있습니다. 그 설정을 지우고 다시 실행하세요.)');
    return;
  }
  const status = await readHistoryStatus(createReadOnlyBlobHistoryStore(token, { get }), Date.now());
  for (const line of formatHistoryStatus(status)) print(line);
  if (everyReadFailed(status)) process.exitCode = 1;
}

// Our own failures carry a fixed snake_case code as their message; anything else shows only its class name.
const failureCode = (error: unknown) => error instanceof Error && /^[a-z_]{1,40}$/.test(error.message) ? error.message : errorName(error);
void main().catch(error => fail(failureCode(error)));
