/**
 * The typed client (ts/http-client.ts) beyond the shared encode cases: talking to the transcoder in process,
 * lenient reads of answers, and every kind of failed response.
 */
import { describe, expect, test, vi } from 'vitest';
import { create } from '@bufbuild/protobuf';
import { LabUiService } from '../ts/lab/ui/v1/lab_ui_service_pb.ts';
import { BookSchema, BookService, Genre, ListBooksResponseSchema, ShelfSchema } from '../ts/prototest/v1/prototest_pb.ts';
import { createHttpClient, HttpEncodeError, HttpResponseError, RpcStatusError, type HttpCall } from '../ts/http-client.ts';
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '../ts/http-transcoder.ts';
import { Code, errorDetail, readDetail, RpcError } from '../ts/rpc-status.ts';

type Handlers = ServiceHandlers<ShapeOf<typeof BookService>, undefined>;

function server(overrides: Partial<Handlers>) {
  const empty = Object.fromEntries(BookService.methods.map((m) => [m.localName, () => Promise.resolve(create(m.output))])) as unknown as Handlers;
  return new HttpTranscoder<ShapeOf<typeof BookService>, undefined>(BookService, { ...empty, ...overrides }, { domain: 'a.example.com', maxBodyBytes: 4096, authorize: () => undefined });
}

/** A transport straight into `api` (what fetch to the Worker does), recording each call. */
function inProcess(api: ReturnType<typeof server>, calls: HttpCall[] = []) {
  return async (call: HttpCall) => {
    calls.push(call);
    const init: RequestInit = { method: call.httpMethod, ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }) };
    const result = await api.handle(new Request(`https://api.example.com${call.url}`, init), undefined, 'rid');
    return result?.response ?? new Response('not found', { status: 404 });
  };
}

describe('the typed client', () => {
  test('sends by the primary binding and returns the typed answer', async () => {
    const calls: HttpCall[] = [];
    const api = server({
      createBook: (request) => Promise.resolve({ ...(request.book ?? create(BookSchema)), name: `${request.parent}/books/${request.bookId}`, genre: Genre.POETRY }),
    });
    const client = createHttpClient(BookService, inProcess(api, calls));
    const book = await client.createBook({ parent: 'shelves/s1', bookId: 'b9', book: { title: 'T', copies: { a: 1 } } });
    expect(book.$typeName).toBe('prototest.v1.Book');
    expect(book).toMatchObject({ name: 'shelves/s1/books/b9', title: 'T', genre: Genre.POETRY, copies: { a: 1 } });
    expect(calls).toEqual([{ method: BookService.method.createBook, httpMethod: 'POST', url: '/v1/shelves/s1/books?book_id=b9', body: '{"title":"T","copies":{"a":1}}' }]);
  });

  test('reads answers leniently and reports what it skipped', async () => {
    const onUnrecognized = vi.fn();
    const send = () => Promise.resolve(Response.json({ books: [{ title: 'T', genre: 'opera', shiny: true }], next_page_token: 'n' }));
    const client = createHttpClient(BookService, send, { onUnrecognized });
    const page = await client.listBooks({ parent: 'shelves/s1' });
    expect(page.$typeName).toBe(ListBooksResponseSchema.typeName);
    expect(page.books[0]?.genre).toBe(Genre.UNSPECIFIED);
    expect(onUnrecognized).toHaveBeenCalledWith(BookService.method.listBooks, ['books[0].genre', 'books[0].shiny']);
  });

  test('a Status answer throws RpcStatusError with its reason, request ID and typed details', async () => {
    const api = server({
      getBook: () => Promise.reject(new RpcError(Code.NOT_FOUND, 'BOOK_GONE', 'gone', { details: [errorDetail(BookSchema, create(BookSchema, { title: 'last seen' }))] })),
    });
    const error = await createHttpClient(BookService, inProcess(api)).getBook({ name: 'shelves/s1/books/b1' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcStatusError);
    const status = (error as RpcStatusError).status;
    expect(status).toMatchObject({ httpStatus: 404, status: 'NOT_FOUND', reason: 'BOOK_GONE', requestId: 'rid', message: 'gone' });
    expect(readDetail(status, BookSchema)?.title).toBe('last seen');
  });

  test.each([
    ['an HTML error page', new Response('<html>login</html>', { status: 403, headers: { 'content-type': 'text/html' } })],
    ['a JSON error that is not a Status', Response.json({ error: 'nope' }, { status: 502 })],
    ['a 2xx that is not JSON', new Response('ok', { status: 200 })],
    ['a 2xx of the wrong type', Response.json({ books: 'many' })],
  ])('%s throws HttpResponseError', async (_name, response) => {
    const client = createHttpClient(BookService, () => Promise.resolve(response));
    await expect(client.listBooks({ parent: 'shelves/s1' })).rejects.toBeInstanceOf(HttpResponseError);
  });

  test('a request its binding cannot carry throws before anything is sent', async () => {
    const send = vi.fn();
    const client = createHttpClient(BookService, send);
    await expect(client.getBook({ name: 'books/b1' })).rejects.toBeInstanceOf(HttpEncodeError);
    await expect(client.countBooks({ shelf: 's1' })).rejects.toBeInstanceOf(HttpEncodeError);
    expect(send).not.toHaveBeenCalled();
  });

  test('a dot segment in a resource name throws before anything is sent', async () => {
    const send = vi.fn();
    const lab = createHttpClient(LabUiService, send);
    await expect(lab.getDeckSummary({ name: 'decks/../summary' })).rejects.toBeInstanceOf(HttpEncodeError);
    await expect(lab.getDeck({ name: 'decks/..' })).rejects.toBeInstanceOf(HttpEncodeError);
    await expect(lab.getDeck({ name: 'decks/.' })).rejects.toBeInstanceOf(HttpEncodeError);
    await expect(lab.deleteLikedPaper({ name: 'likedPapers/..' })).rejects.toBeInstanceOf(HttpEncodeError);
    expect(send).not.toHaveBeenCalled();
  });

  test('a value the wire profile cannot write throws HttpEncodeError before anything is sent', async () => {
    const send = vi.fn();
    const client = createHttpClient(BookService, send);
    await expect(client.listBooks({ parent: 'shelves/s1', pageSize: 2 ** 31 })).rejects.toBeInstanceOf(HttpEncodeError);
    await expect(client.updateShelf({ shelf: { name: 'shelves/s1' }, updateMask: { paths: ['Theme'] } })).rejects.toBeInstanceOf(HttpEncodeError);
    await expect(client.updateShelf({ shelf: { name: 'shelves/s1' }, updateMask: { paths: ['*', 'theme'] } })).rejects.toBeInstanceOf(HttpEncodeError);
    expect(send).not.toHaveBeenCalled();
  });

  test('an update with a mask sends only the masked fields, and the server reads them alone', async () => {
    const calls: HttpCall[] = [];
    const seen: unknown[] = [];
    const api = server({
      updateShelf: (request) => {
        seen.push({ paths: request.updateMask?.paths, theme: request.shelf?.theme, capacity: request.shelf?.capacity, genre: request.shelf?.genre });
        return Promise.resolve(request.shelf ?? create(ShelfSchema));
      },
    });
    const client = createHttpClient(BookService, inProcess(api, calls));
    // capacity and genre are set here but not masked: they are not sent, so the REQUIRED genre is not sent as null.
    await client.updateShelf({ shelf: { name: 'shelves/s1', theme: 'T', capacity: 5 }, updateMask: { paths: ['theme'] } });
    expect(calls.map((c) => [c.url, c.body])).toEqual([['/v1/shelves/s1?update_mask=theme', '{"theme":"T"}']]);
    expect(seen).toEqual([{ paths: ['theme'], theme: 'T', capacity: 0, genre: Genre.UNSPECIFIED }]);
  });

  test('a failing transport rejects with its own error', async () => {
    const client = createHttpClient(BookService, () => Promise.reject(new TypeError('network')));
    await expect(client.getBook({ name: 'shelves/s1/books/b1' })).rejects.toThrow('network');
  });
});
