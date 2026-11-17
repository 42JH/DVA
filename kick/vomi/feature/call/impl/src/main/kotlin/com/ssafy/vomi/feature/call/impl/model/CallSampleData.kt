package com.ssafy.vomi.feature.call.impl.model

import com.ssafy.vomi.core.model.call.CallMediaConnection
import com.ssafy.vomi.core.model.call.CallMessage
import com.ssafy.vomi.core.model.call.CallSpeaker
import com.ssafy.vomi.core.model.call.CallSummary
import com.ssafy.vomi.core.model.call.ReplySuggestion

// Preview/test fixtures only. Runtime state is observed from CallRepository.callState.
internal fun sampleCallState(friendId: String, friendName: String, isIncoming: Boolean = false) =
    CallUiState(
        isTextAudioAvailable = true,
        mediaConnection = CallMediaConnection.Connected,
        friendId = friendId,
        friendName = friendName,
        phase = if (isIncoming) CallPhase.Incoming else CallPhase.Active,
        messages = if (isIncoming) emptyList() else listOf(
            CallMessage(1L, CallSpeaker.Local, "안녕하세요. 텍스트로 통화하려고 합니다."),
            CallMessage(2L, CallSpeaker.Remote, "오늘 저녁에 시간 돼?"),
        ),
        suggestions = listOf(
            ReplySuggestion(1L, "오늘 저녁 괜찮아요!"),
            ReplySuggestion(2L, "내일 저녁은 어떠세요?"),
            ReplySuggestion(3L, "일정 확인하고 다시 말씀드릴게요."),
        ),
        backchannels = defaultBackchannels,
        summary = if (isIncoming) null else CallSummary(
            overview = "오늘 저녁에 만날 수 있는지 이야기하고 있어요.",
            highlights = listOf(
                "텍스트로 대화하겠다는 의사를 전달했어요.",
                "상대방이 오늘 저녁 시간을 물어봤어요.",
                "약속 시간과 장소는 아직 정하지 않았어요."
            ),
        ),
    )
