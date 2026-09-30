/**
 * Node stand-in for the `cloudflare:workers` module, which exists only inside workerd. vitest aliases
 * the import to this file (vitest.config.ts) so unit tests can load src/ and construct classes with fake
 * bindings; the runtime suite (vitest.runtime.config.ts) uses the real classes in workerd.
 */
export class DurableObject<Env = unknown> {
  protected readonly ctx: DurableObjectState;
  protected readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown> {
  protected readonly ctx: ExecutionContext;
  protected readonly env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
