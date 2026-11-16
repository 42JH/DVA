package com.kick.nanopoc

import org.json.JSONObject

internal data class ReplyProfile(
    val name: String = "",
    val phone: String = "",
    val style: String = "",
    val example: String = "",
) {
    fun personalize(instruction: String, latestMessage: String): String {
        val context = JSONObject().apply {
            if (style.isNotBlank()) put("평소 성격과 말투", style)
            if (example.isNotBlank()) put("내가 실제로 쓰는 표현 예시", example)
            if (name.isNotBlank() && nameRequest.containsMatchIn(latestMessage)) put("내 이름", name)
            if (phone.isNotBlank() && phoneRequest.containsMatchIn(latestMessage)) put("내 전화번호", phone)
        }
        if (context.length() == 0) return instruction
        return """
            $instruction
            상대에 맞는 위 말투와 답변 길이를 지키면서 아래 내 정보를 참고해.
            표현 예시에서는 말버릇만 참고하고 예시 속 사실을 현재 대화에 옮기지 마.
            이름과 전화번호는 상대가 내 정보를 명시적으로 요청한 경우에만 답변에 넣어.
            내 일정, 의사, 개인정보를 지어내지 마.
            내 정보: $context
        """.trimIndent()
    }

    private companion object {
        val nameRequest = Regex("이름|성함|성명")
        val phoneRequest = Regex("전화\\s*번호|휴대\\s*폰\\s*번호|핸드\\s*폰\\s*번호|연락처|연락\\s*가능한\\s*번호")
    }
}
