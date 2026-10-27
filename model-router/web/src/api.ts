import {
  createHttpClient,
  HttpEncodeError,
  HttpResponseError,
  RpcStatusError,
  type HttpCall,
} from '@ziyixi/proto/http-client'

import { fromWire, toWire } from '@ziyixi/proto/wire-json'
import {
  GenerationSchema,
  GenerateRequestSchema,
  ListModelsResponseSchema,
  ModelService,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_pb'
import type {
  GenerateRequest,
  Generation,
  Model,
} from '@ziyixi/proto/modelrouter/inference/v1/inference_wire'

import {
  ConsoleService,
  ListRequestsRequestSchema,
  ListRequestsResponseSchema,
  RequestRecordSchema,
  UsageSummarySchema,
} from '@ziyixi/proto/modelrouter/inference/v1/console_pb'
import type {
  ListRequestsResponse,
  RequestRecord,
  UsageSummary,
} from '@ziyixi/proto/modelrouter/inference/v1/console_wire'

export type TimeRange = 1 | 7 | 30 | 90
export interface RequestFilters {
  days: TimeRange
  app: string
  model: string
  state: string
  toTime: string
}
export interface RouterApi {
  listModels: () => Promise<readonly Model[]>
  listRequests: (filters: RequestFilters, pageToken?: string) => Promise<ListRequestsResponse>
  getRequest: (name: string) => Promise<RequestRecord>
  getUsage: (days: TimeRange, app?: string, model?: string) => Promise<UsageSummary>
  generate: (request: GenerateRequest) => Promise<Generation>
}

export class ApiError extends Error {
  readonly reason: string
  readonly status: number
  constructor(message: string, reason: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.reason = reason
    this.status = status
  }
}

function apiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (error instanceof RpcStatusError)
    return new ApiError(
      error.status.localizedMessage?.message || error.status.message || '请求失败，请重试。',
      error.status.reason || 'REQUEST_FAILED',
      error.status.httpStatus,
    )
  if (error instanceof HttpEncodeError) return new ApiError('请求参数无效。', 'BAD_REQUEST', 400)
  if (error instanceof HttpResponseError)
    return new ApiError('服务返回了无法识别的响应，请刷新后重试。', 'BAD_RESPONSE', error.httpStatus)
  return new ApiError('无法连接 ModelRouter，或登录已过期。请刷新页面后重试。', 'NETWORK_ERROR', 0)
}

async function sameOrigin(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw apiError(null)
  }
}

export async function send(call: HttpCall): Promise<Response> {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(call.httpMethod)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (mutation || call.body !== undefined) headers['Content-Type'] = 'application/json'
  if (mutation) headers['X-CSRF-Token'] = '1'
  return sameOrigin(call.url, {
    method: call.httpMethod,
    headers,
    ...(call.body === undefined ? {} : { body: call.body }),
  })
}

const model = createHttpClient(ModelService, send)
const owner = createHttpClient(ConsoleService, send)

async function request<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    throw apiError(error)
  }
}

export const api: RouterApi = {
  listModels: () =>
    request(async () => toWire(ListModelsResponseSchema, await model.listModels({})).models ?? []),
  listRequests: (filters, pageToken = '') =>
    request(async () => {
      const toTime = new Date(filters.toTime)
      const fromTime = new Date(toTime.getTime() - filters.days * 86_400_000)
      const query = fromWire(ListRequestsRequestSchema, {
        page_size: 25,
        ...(pageToken ? { page_token: pageToken } : {}),
        ...(filters.app ? { app: filters.app } : {}),
        ...(filters.model ? { model: filters.model } : {}),
        ...(filters.state ? { state: filters.state } : {}),
        from_time: fromTime.toISOString(),
        to_time: toTime.toISOString(),
      }).message
      return toWire(ListRequestsResponseSchema, await owner.listRequests(query))
    }),
  getRequest: (name) => request(async () => toWire(RequestRecordSchema, await owner.getRequest({ name }))),
  getUsage: (days, app = '', modelName = '') =>
    request(async () => toWire(UsageSummarySchema, await owner.getUsage({ days, app, model: modelName }))),
  generate: (input) =>
    request(async () =>
      toWire(GenerationSchema, await model.generate(fromWire(GenerateRequestSchema, input).message)),
    ),
}
