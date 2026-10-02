// The owner API's bindings, wrapped so that a failed call to a dependency is told apart from a bug (proto/README.md,
// HTTP APIs: only a failed dependency is UNAVAILABLE, which a client may repeat; anything else unexpected is INTERNAL).
//
// withDependencies(env) answers an env whose D1 database (DB), R2 buckets (MAIL_STORE, BACKUP_STORE) and coordinator
// namespace (COORDINATOR) reject with DependencyError, carrying the binding's name only, when the underlying call rejects. The
// provider's error is dropped, never logged or answered: it can hold SQL, keys or URLs. A D1 statement made by the
// wrapped database works in its batch as one made by the real one; everything else of the env is the same object.
import type { Env } from './types.ts'

/** A call to a binding (D1, R2, a Durable Object) rejected: UNAVAILABLE, which the client may repeat. */
export class DependencyError extends Error {
  readonly binding: string
  constructor(binding: string) {
    super('dependency_failed')
    this.name = 'DependencyError'
    this.binding = binding
  }
}

function settled<T>(binding: string, run: () => Promise<T>): Promise<T> {
  let promise: Promise<T>
  try {
    promise = Promise.resolve(run())
  } catch {
    return Promise.reject(new DependencyError(binding))
  }
  return promise.catch((error: unknown) => {
    throw error instanceof DependencyError ? error : new DependencyError(binding)
  })
}

/** The real statement behind each wrapped one, for batch(). */
const realStatements = new WeakMap<object, D1PreparedStatement>()

/** `make()`, with a synchronous throw (a database that refuses a statement at once) as DependencyError too. */
function made<T>(binding: string, make: () => T): T {
  try {
    return make()
  } catch {
    throw new DependencyError(binding)
  }
}

function statement(real: D1PreparedStatement): D1PreparedStatement {
  const wrapped = {
    // A bind that throws is a bug (a value D1 cannot take), not a failed dependency.
    bind: (...values: unknown[]) => statement(real.bind(...values)),
    first: (column?: string) => settled('DB', () => (column === undefined ? real.first() : real.first(column))),
    all: () => settled('DB', () => real.all()),
    run: () => settled('DB', () => real.run()),
    raw: (options?: { columnNames?: boolean }) => settled('DB', () => real.raw(options as never)),
  }
  realStatements.set(wrapped, real)
  return wrapped as unknown as D1PreparedStatement
}

function database(real: D1Database): D1Database {
  return {
    prepare: (sql: string) => statement(made('DB', () => real.prepare(sql))),
    batch: (statements: D1PreparedStatement[]) => settled('DB', () => real.batch(statements.map(item => realStatements.get(item) ?? item))),
    exec: (sql: string) => settled('DB', () => real.exec(sql)),
    dump: () => settled('DB', () => real.dump()),
    withSession: () => { throw new TypeError('withSession is not used by the owner API') },
  } as unknown as D1Database
}

/** An R2 object body whose reads reject with DependencyError too (a stream that breaks, an object that is not JSON). */
function objectBody<T extends R2ObjectBody | null>(binding: string, object: T): T {
  if (object === null || !('body' in object)) return object
  return new Proxy(object, {
    get(target, key) {
      if (key === 'text' || key === 'json' || key === 'arrayBuffer' || key === 'blob') {
        return () => settled(binding, () => (target[key] as () => Promise<unknown>).call(target))
      }
      // The native object itself as `this`: workerd's getters refuse a proxy.
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

function bucket(binding: string, real: R2Bucket): R2Bucket {
  return {
    get: (key: string, options?: R2GetOptions) => settled(binding, async () => objectBody(binding, await real.get(key, options) as R2ObjectBody | null)),
    head: (key: string) => settled(binding, () => real.head(key)),
    put: (key: string, value: never, options?: R2PutOptions) => settled(binding, () => real.put(key, value, options)),
    delete: (keys: string | string[]) => settled(binding, () => real.delete(keys)),
    list: (options?: R2ListOptions) => settled(binding, () => real.list(options)),
  } as unknown as R2Bucket
}

function namespace(real: DurableObjectNamespace): DurableObjectNamespace {
  return new Proxy(real, {
    get(target, key) {
      if (key === 'get') {
        return (id: DurableObjectId) => {
          const stub = target.get(id)
          return { fetch: (input: RequestInfo | URL, init?: RequestInit) => settled('COORDINATOR', () => stub.fetch(input, init)) }
        }
      }
      // The native object itself as `this`: workerd's getters refuse a proxy.
      const value = Reflect.get(target, key) as unknown
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
    },
  })
}

/** `env` with DB, MAIL_STORE, BACKUP_STORE (when bound) and COORDINATOR wrapped (see above). */
export function withDependencies(env: Env): Env {
  return { ...env, DB: database(env.DB), MAIL_STORE: bucket('MAIL_STORE', env.MAIL_STORE),
    ...(env.BACKUP_STORE ? { BACKUP_STORE: bucket('BACKUP_STORE', env.BACKUP_STORE) } : {}), COORDINATOR: namespace(env.COORDINATOR) }
}
