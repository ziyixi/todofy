/**
 * A synthetic Todofy Mail entry (todofy.mail.v1 MailService) for the `MAIL` binding: the same transcoder Todofy's
 * gateway serves it with, over mail a test keeps in memory. MarkMailConverted and DeleteMailSummaries follow Todofy's
 * rules (runtime/mail.py): a compare-and-set on the pending mail, and a repeat for the same task answers as done.
 */
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { HttpTranscoder, type ServiceHandlers, type ShapeOf } from '@ziyixi/proto/http-transcoder';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import {
  DeleteMailSummariesResponseSchema,
  ListMailItemsResponseSchema,
  MailInboxSchema,
  MailItemSchema,
  MailService,
  PollMailReadyResponseSchema,
} from '@ziyixi/proto/todofy/mail/v1/mail_service_pb';

export interface SyntheticMail {
  id: string;
  title: string;
  summary?: string;
  /** Milliseconds; days ago, the inbox counts it as carried over. */
  receivedAt?: number;
  /** A task an older Todofy linked, or the converted one. */
  taskId?: string;
  pending?: boolean;
  /** Changes the etag, as an edit of the mail would. */
  version?: number;
}
export interface FakeMail {
  mail: SyntheticMail[];
  /** Every rpc called, by name, in order. */
  calls: string[];
  /** Answers the next calls of an rpc (by name) with UNAVAILABLE, as many times as given. */
  failures: Map<string, number>;
  handle: (request: Request) => Promise<Response>;
}

const DAY = 86_400_000;
/** The etag the fake answers for a mail, which changes when it is marked. */
export const mailEtag = (mail: SyntheticMail) =>
  `${mail.id}:${String(mail.version ?? 0)}:${mail.taskId ?? ''}:${String(mail.pending !== false)}`;

export function fakeMail(mail: SyntheticMail[] = []): FakeMail {
  const fake: FakeMail = {
    mail,
    calls: [],
    failures: new Map(),
    async handle(request) {
      const result = await transcoder.handle(request, undefined, crypto.randomUUID());
      return result?.response ?? new Response(null, { status: 404 });
    },
  };
  const find = (name: string) => {
    const found = fake.mail.find((item) => `mailItems/${item.id}` === name);
    if (!found) throw new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'no such mail');
    return found;
  };
  const item = (mail: SyntheticMail, summary = false) =>
    create(MailItemSchema, {
      name: `mailItems/${mail.id}`,
      id: mail.id,
      title: mail.title,
      brief: '',
      receiveTime: timestampFromMs(mail.receivedAt ?? Date.now()),
      hasSummary: Boolean(mail.summary),
      etag: mailEtag(mail),
      taskId: mail.taskId ?? '',
      summary: summary ? (mail.summary ?? '') : '',
      pending: mail.pending !== false,
    });
  /** One rpc's answer: recorded, and refused while a failure is set for it. */
  function answer<T>(rpc: string, work: () => T): Promise<T> {
    return new Promise((resolve) => {
      fake.calls.push(rpc);
      const left = fake.failures.get(rpc) ?? 0;
      if (left > 0) {
        fake.failures.set(rpc, left - 1);
        throw new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'synthetic outage');
      }
      resolve(work());
    });
  }
  const handlers: ServiceHandlers<ShapeOf<typeof MailService>, undefined> = {
    listMailItems: () =>
      answer('ListMailItems', () =>
        create(ListMailItemsResponseSchema, {
          mailItems: fake.mail.filter((mail) => mail.pending !== false).map((mail) => item(mail)),
        }),
      ),
    getMailItem: (input) => answer('GetMailItem', () => item(find(input.name), true)),
    markMailConverted: (input) =>
      answer('MarkMailConverted', () => {
        const mail = find(input.name);
        if (mail.pending !== false) {
          if (input.etag !== mailEtag(mail)) throw new RpcError(Code.ABORTED, 'ETAG_MISMATCH', 'the mail changed');
          Object.assign(mail, { pending: false, taskId: input.taskId });
          return item(mail);
        }
        if (mail.taskId === input.taskId) return item(mail);
        throw new RpcError(Code.FAILED_PRECONDITION, 'NOT_PENDING', 'the mail no longer awaits a decision');
      }),
    deleteMailSummaries: (input) =>
      answer('DeleteMailSummaries', () => {
        const kept = input.eventIds.filter((id) => fake.mail.some((mail) => mail.id === id && mail.pending === false));
        fake.mail = fake.mail.filter((mail) => mail.pending === false || !input.eventIds.includes(mail.id));
        return create(DeleteMailSummariesResponseSchema, {
          deletedEventIds: input.eventIds.filter((id) => !kept.includes(id)),
          keptEventIds: kept,
        });
      }),
    getMailInbox: () =>
      answer('GetMailInbox', () => {
        const pending = fake.mail.filter((mail) => mail.pending !== false);
        const now = Date.now();
        return create(MailInboxSchema, {
          name: 'mailInbox',
          pendingCount: pending.length,
          carryoverCount: pending.filter((mail) => {
            const age = now - (mail.receivedAt ?? now);
            return age >= DAY && age <= 14 * DAY;
          }).length,
        });
      }),
    pollMailReady: () => answer('PollMailReady', () => create(PollMailReadyResponseSchema, { cursor: '0' })),
  };
  const transcoder = new HttpTranscoder(MailService, handlers, {
    domain: 'todofy.example.test',
    maxBodyBytes: 32 * 1024,
    authorize: () => undefined,
  });
  return fake;
}
