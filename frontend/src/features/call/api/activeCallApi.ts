// 진행 통화 수 (연동 명세 11/04 §4) — SSE 하나로 시작(최초 연결 · 재연결 때 서버가 현재값을 보냄). React를 모르는 API 층
// 숫자 전용: 분석 · 발화 · 녹취 도착 알림이나 목록 갱신 근거로 쓰지 않음. 받은 값을 그대로 쓰고 +1/-1 하지 않음
// 장애 중엔 숫자를 0으로 바꾸지 않고 '끊김'만 알림
import { api, API_BASE_URL, toLogin } from '@/shared/api/client'

type Timer = ReturnType<typeof setTimeout> | undefined

/** 현재값 한 번 (GET) — 스트림을 새로 붙이기 전에 숫자를 맞추고 세션도 확인 (401이면 client가 로그인 화면으로) */
const fetchActiveCallCount = async () =>
  (await api.get<{ data: { activeCallCount: number } }>('/calls/active-count')).data.activeCallCount

export function subscribeActiveCallCount(on: {
  count: (n: number) => void
  live: (ok: boolean) => void
}) {
  let src: EventSource | undefined
  let fails = 0 // GET도 연속으로 안 된 횟수 (서버 장애) — 다시 붙는 간격이 늘어남
  let heardSinceOpen = false // 이번 스트림에서 하나라도 받았나
  let stopped = false
  let staleTimer: Timer
  let quietTimer: Timer
  let retryTimer: Timer

  // 서버에서 받으면(스트림 값 · heartbeat · GET) 정상. 20초 동안 아무것도 못 받을 때만 끊김 — 잠깐 다시 붙는 동안은 안 깜빡임
  const fresh = () => {
    on.live(true)
    clearTimeout(staleTimer)
    staleTimer = setTimeout(() => on.live(false), 20000)
  }
  // heartbeat가 5초마다라 15초 조용하면 막힌 연결(절전 뒤 · 중간 프록시가 묶어 둠)
  const watch = () => {
    clearTimeout(quietTimer)
    quietTimer = setTimeout(() => reopen(true), 15000)
  }
  const heard = () => {
    heardSinceOpen = true
    fails = 0
    fresh()
    watch()
  }
  // 새로 붙기: GET으로 현재값(되면 정상 — 스트림이 막힌 곳에서도 15초쯤마다 숫자가 갱신됨) → 새 스트림 (옛 것은 닫아 둘이 되지 않게)
  // 간격: 조용해서 · 잘 되던 연결이 끊겨서면 1초, 스트림만 계속 안 되면 10초, 서버 장애(GET도 실패)면 3 · 6 · 10초
  const reopen = (afterQuiet: boolean) => {
    src?.close()
    clearTimeout(quietTimer)
    const wait =
      afterQuiet || heardSinceOpen ? 1000 : fails ? Math.min(10000, 1500 * 2 ** fails) : 10000
    retryTimer = setTimeout(() => {
      fetchActiveCallCount()
        .then(
          (n) => {
            fails = 0
            on.count(n)
            fresh()
          },
          () => fails++,
        )
        .finally(() => stopped || open())
    }, wait)
  }
  const open = () => {
    heardSinceOpen = false
    src = new EventSource(`${API_BASE_URL}/calls/active-count/stream`, { withCredentials: true })
    watch() // 첫 값도 15초 안에 안 오면
    src.addEventListener('active-call-count', (e) => {
      heard()
      on.count(
        (JSON.parse((e as MessageEvent<string>).data) as { activeCallCount: number })
          .activeCallCount,
      )
    })
    src.addEventListener('heartbeat', heard)
    src.addEventListener('session-expired', () => {
      stop()
      toLogin()
    })
    // stream-error는 서버가 닫음 → 브라우저가 다시 붙어 현재값을 받음 (그동안 20초 안이면 표시는 그대로)
    // 브라우저가 포기한 연결(HTTP 오류 — 배포 중 502 · 503 · 401)만 직접 다시. 브라우저가 다시 붙는 중이면 그대로 (겹쳐 만들지 않음)
    src.onerror = () => {
      if (src?.readyState === EventSource.CLOSED) reopen(false)
    }
  }
  const stop = () => {
    stopped = true
    src?.close()
    clearTimeout(staleTimer)
    clearTimeout(quietTimer)
    clearTimeout(retryTimer)
  }

  fresh() // 처음 20초는 붙는 중 = 정상으로 봄
  open()
  // 처음 숫자는 GET으로도 바로 (스트림이 늦거나 막혀도 빈칸이 오래 가지 않게). 스트림 값이 먼저 왔으면 그걸 둠
  fetchActiveCallCount().then(
    (n) => heardSinceOpen || on.count(n),
    () => {},
  )
  return stop // 화면 해제 · 로그아웃
}
