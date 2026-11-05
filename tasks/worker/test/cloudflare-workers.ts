/**
 * Node stand-in for the `cloudflare:workers` module, which exists only inside workerd. vitest
 * aliases the import to this file (vitest.config.ts), so the unit tests can construct src/ops.ts's
 * entrypoint with a fake env; the runtime tests use the real class.
 */
export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected readonly ctx: ExecutionContext<Props>;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
