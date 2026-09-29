/**
 * Node stand-in for the `cloudflare:workers` module, which exists only inside workerd. vitest
 * aliases the import to this file (vitest.config.ts), so the unit tests can load src/index.ts and
 * construct src/ops.ts's entrypoint with a fake env; the runtime tests use the real class.
 */
export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
