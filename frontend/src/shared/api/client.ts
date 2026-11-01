// 공통 HTTP 클라이언트 — API 명세서 1장 공통 규약을 여기 한 곳에서 처리
// 기본 경로 · 세션 쿠키 · X-Request-Id · 응답 10초 제한 · 오류 본문 → ApiError · 401이면 로그인 화면으로
import { clearSession } from '@/shared/auth/session'

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api' // 10/26 BE 결정: v1 없음
const TIMEOUT_MS = 10_000 // 명세서 1.4 일반 응답 10초

/** 단건 응답 { data, meta } (명세서 1.1) */
export interface ApiItem<T> {
  data: T
  meta?: { requestId: string }
}

/** 목록 응답 { data[], hasNext, total_count } (연동 상세명세 10/31 §1). total_count = 검색 · 필터 후, limit · offset 전 전체 건수 */
export interface ApiList<T> {
  data: T[]
  hasNext: boolean
  total_count: number
}

type FieldError = { field: string; reason: string }

export class ApiError extends Error {
  readonly status: number // 0 = 연결 실패 · 시간 초과
  readonly code: string
  readonly details: FieldError[] // 입력칸별 오류 (폼에서 그대로 사용)

  constructor(status: number, code: string, message: string, details: FieldError[] = []) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** 메모리 가짜 api가 '찾는 것이 없음'을 알릴 때 (화면은 그 문구 그대로). 실서버로 바꾸면 ApiError 404가 이 자리 */
export class NotFoundError extends Error {}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** 명세서 1.2 멱등키 필수 API(FAQ-02 등)만. 버튼을 누를 때 crypto.randomUUID()로 한 번 만들고 재시도에 같은 값 */
  idempotencyKey?: string
  signal?: AbortSignal
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Request-Id': crypto.randomUUID(),
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const url = `${API_BASE_URL}${path}${query.size ? `?${query}` : ''}`

  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers,
      // 로그인 = HttpOnly 쿠키 dva_session (API 연동 상세명세 1장). JS는 쿠키를 못 읽고, 브라우저가 붙여 보냄
      // include: 개발 서버와 백엔드 주소가 달라도(교차 origin) 쿠키를 보냄. 같은 origin(/api 프록시 · 배포)이면 기본값과 같음
      credentials: 'include',
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    })
  } catch (e) {
    if (opts.signal?.aborted) throw e // 화면 이동 등으로 취소된 요청 — React Query가 처리
    throw timeout.aborted
      ? new ApiError(0, 'TIMEOUT', '응답이 늦어요. 잠시 뒤 다시 시도해 주세요.')
      : new ApiError(0, 'NETWORK_ERROR', '서버에 연결하지 못했어요.')
  }

  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined // 204 · 본문 없는 202는 undefined
  } catch {
    json = undefined // 프록시 오류 페이지 등 JSON이 아닌 본문
  }

  if (!res.ok) {
    // 로그인 요청 자체의 401(아이디 · 비밀번호 불일치)은 그 화면에서 보여 주고, 나머지 401은 토큰 만료로 보고 로그인 화면으로
    if (res.status === 401 && path !== '/auth/login') {
      clearSession()
      if (window.location.pathname !== '/login') window.location.assign('/login')
    }
    const err = (json as { error?: { code: string; message: string; details?: FieldError[] } })
      ?.error
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? '요청을 처리하지 못했어요.',
      err?.details,
    )
  }
  return json as T
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, opts),
  post: <T = void>(path: string, opts?: RequestOptions) => request<T>('POST', path, opts),
  put: <T = void>(path: string, opts?: RequestOptions) => request<T>('PUT', path, opts),
  patch: <T = void>(path: string, opts?: RequestOptions) => request<T>('PATCH', path, opts),
  delete: <T = void>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, opts),
}
