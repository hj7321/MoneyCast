import 'dotenv/config';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT는 1~65535 정수여야 합니다.');

const server = createApp();
server.listen(port, host, () => console.log(`MoneyCast API: http://${host}:${port}`));
server.on('error', error => {
  console.error(error instanceof Error && 'code' in error ? `API 시작 실패: ${error.code}` : 'API 시작 실패');
  process.exitCode = 1;
});
