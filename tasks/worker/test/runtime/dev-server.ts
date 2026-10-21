import { createServer } from 'node:http';
import { fakeMail, type SyntheticMail } from './fake-mail.ts';
import { startHarness } from './harness.ts';
const port = Number(process.env.PORT ?? 8798);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const mail = fakeMail();
const server = await startHarness({ port, mail: mail.handle });
// The browser tests' synthetic Todofy, on its own port (8789, as test/browser/planning-stub.ts): PUT /mail replaces its
// mail, GET /mail answers the mail and the rpcs called since.
const control = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk: Buffer) => (body += chunk.toString()));
  request.on('end', () => {
    if (request.method === 'PUT' && request.url === '/mail') {
      mail.mail = JSON.parse(body) as SyntheticMail[];
      mail.calls.length = 0;
    } else if (request.method !== 'GET' || request.url !== '/mail') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mail));
  });
}).listen(Number(process.env.MAIL_CONTROL_PORT ?? 8789), '127.0.0.1');
console.log(`Tasks synthetic local D1 ready at ${server.url.origin}`);
async function close() {
  control.close();
  await server.dispose();
  process.exit(0);
}
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
