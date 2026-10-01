export type ServiceResult<T> =
  | {
      ok: true;
      data: T;
      status?: number;
    }
  | {
      ok: false;
      error: string;
      status: number;
    };

export function serviceOk<T>(data: T, status?: number): ServiceResult<T> {
  return { ok: true, data, status };
}

export function serviceError(error: string, status: number): ServiceResult<never> {
  return { ok: false, error, status };
}
