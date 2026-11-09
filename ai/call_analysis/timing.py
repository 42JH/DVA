"""녹음 시간 분석(코드, 토큰 없음) — 통화가 끝난 뒤 저장된 녹음으로만 한다(실시간 AI는 건드리지 않음).

녹음은 한 채널 8kHz라 두 목소리가 섞여 있어 소리 크기로 말소리 구간만 찾고, 누가 말했는지는 대본 발화 시각으로 붙인다.
대본 offsetSeconds(초 단위): AI 발화는 말 시작 무렵, 고객 발화는 받아쓰기가 끝난 말 끝 무렵이다(11/06 녹음 4건 대조).
→ 앞 발화 시각부터 이번 발화 시각(+1초) 사이의 가장 긴 침묵을 '이번 발화 앞 침묵'으로 본다. 옆 사람 말 같은 잡음은 침묵을
끊으므로 짧게 잡힐 수 있다(모르면 짧게 → 응답 지연을 지어내지 않는 쪽).
판정 모델이 이 침묵과 고객 반응을 함께 보고 응답 지연을 정한다 — 명세상 시간 초과만으로 정하지 않는다.
"""

import io
import wave

import numpy as np

FRAME_SEC = 0.02
ON_DB = 15.0  # 바닥 소음(하위 10%)보다 이만큼 크면 말소리
JOIN_SEC = 0.35  # 이보다 짧은 끊김은 한 말소리로 잇는다(숨, 말 사이)
MIN_SEC = 0.25  # 이보다 짧은 소리는 버린다(잡음)
SHOW_PAUSE = 2.0  # 판정 입력에 적는 침묵(초). 대화 중 1초 안팎의 쉼은 보통이다
# 대본 시각으로 잰 공백: 옆 사람 말 같은 잡음이 녹음 침묵을 메우면 녹음으로는 못 잰다(11/06 175번: 40초 무응답이 2초로).
# 앞 발화 끝 ~ 이번 발화 시작을 글자 수로 어림해 이보다 길면 녹음 값 대신 쓴다. 어림이라 짧은 공백에는 쓰지 않는다
TEXT_GAP_MIN = 8.0
AI_CPS, CUSTOMER_CPS = 7.0, 5.0  # 말 속도(초당 글자): AI 음성 · 고객 말(11/06 녹음 대조 어림)


def speech_segments(wav: bytes) -> list[tuple[float, float]]:
    """WAV(16비트) → 말소리 구간 [(시작초, 끝초)]. 여러 채널이면 섞어서 본다."""
    with wave.open(io.BytesIO(wav)) as w:
        rate, ch = w.getframerate(), w.getnchannels()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    n = int(rate * FRAME_SEC)
    if len(x) < n:
        return []
    db = 20 * np.log10(np.sqrt(np.mean(x[: len(x) // n * n].reshape(-1, n) ** 2, axis=1)) + 1e-6)
    on = db > np.percentile(db, 10) + ON_DB
    segs: list[list[float]] = []
    for i in np.flatnonzero(on):
        a, b = i * FRAME_SEC, (i + 1) * FRAME_SEC
        if segs and a - segs[-1][1] <= JOIN_SEC:
            segs[-1][1] = b
        else:
            segs.append([a, b])
    return [(round(float(a), 2), round(float(b), 2)) for a, b in segs if b - a >= MIN_SEC]


def longest_silence(segs: list[tuple[float, float]], t0: float, t1: float) -> float:
    """[t0, t1] 안에서 가장 긴 침묵(초) — 말소리 구간 사이의 빈틈을 창에 맞춰 자른 길이."""
    edges = [(-1e9, t0)] + [s for s in segs if s[1] > t0 and s[0] < t1] + [(t1, 1e9)]
    return round(max(max(0.0, min(b[0], t1) - max(a[1], t0)) for a, b in zip(edges, edges[1:])), 1)


def text_gap(prev: tuple[int, bool, str], cur: tuple[int, bool, str]) -> float:
    """대본만으로 어림한 두 발화 사이 공백(초). 발화 = (offsetSeconds, 고객인지, 글). AI 시각은 말 시작, 고객 시각은 말 끝 무렵."""
    (a, a_cust, a_text), (b, b_cust, b_text) = prev, cur
    end = a if a_cust else a + len(a_text.replace(" ", "")) / AI_CPS
    start = b - len(b_text.replace(" ", "")) / CUSTOMER_CPS if b_cust else b
    return round(start - end, 1)


def pauses(offsets: list[int | None], segs: list[tuple[float, float]],
           said: list[tuple[bool, str]] | None = None) -> list[tuple[float, bool] | None]:
    """발화 순서대로 offsetSeconds → 각 발화 앞 (침묵 초, 대본 어림인지)(SHOW_PAUSE 이상만, 아니면 None).
    said = 발화마다 (고객인지, 글) — 주면 대본 공백이 TEXT_GAP_MIN 넘고 녹음 값보다 길 때 그 값을 쓴다(잡음으로 녹음이 못 잰 침묵)."""
    out: list[tuple[float, bool] | None] = [None] * len(offsets)
    for i in range(1, len(offsets)):
        a, b = offsets[i - 1], offsets[i]
        if a is None or b is None or b < a:
            continue
        gap, guessed = longest_silence(segs, a, b + 1), False
        if said:
            est = text_gap((a, *said[i - 1]), (b, *said[i]))
            if est >= TEXT_GAP_MIN and est > gap:
                gap, guessed = est, True
        out[i] = (gap, guessed) if gap >= SHOW_PAUSE else None
    return out


if __name__ == "__main__":  # 확인: 말 2초 · 침묵 3초 · 말 1초짜리 가짜 녹음
    rate = 8000
    t = np.arange(rate * 6) / rate
    x = np.where((t < 2) | (t >= 5), 8000 * np.sin(2 * np.pi * 220 * t), 30 * np.sin(2 * np.pi * 50 * t)).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate), w.writeframes(x.tobytes())
    segs = speech_segments(buf.getvalue())
    assert len(segs) == 2 and abs(segs[0][1] - 2) < 0.05 and abs(segs[1][0] - 5) < 0.05, segs
    assert text_gap((10, False, "가" * 14), (30, True, "여보세요")) == 17.2  # AI 2초 말한 뒤 고객이 30초에 말 끝냄
    assert longest_silence(segs, 1, 6) == 3.0 and pauses([1, 5], segs) == [None, (3.0, False)] and pauses([1, 2], segs) == [None, None]
    print("ok", segs)
