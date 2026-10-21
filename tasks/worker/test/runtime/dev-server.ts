import { fakeMail } from './fake-mail.ts';
import { startHarness } from './harness.ts';
const port = Number(process.env.PORT ?? 8798);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
// Todofy's Mail entry with no mail: the browser tests answer the Mail page's requests themselves.
const server = await startHarness({ port, mail: fakeMail().handle });
console.log(`Tasks synthetic local D1 ready at ${server.url.origin}`);
async function close() {
  await server.dispose();
  process.exit(0);
}
process.once('SIGTERM', () => {
  void close();
});
process.once('SIGINT', () => {
  void close();
});
