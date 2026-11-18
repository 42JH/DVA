package com.kick.nanopoc

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

internal class ChatScreen(private val activity: Activity) {
    private val ink = Color.rgb(25, 39, 34)
    private val muted = Color.rgb(82, 104, 95)
    private val accent = Color.rgb(23, 101, 79)
    private val white = Color.WHITE
    private val paper = Color.rgb(245, 248, 246)
    private val mint = Color.rgb(226, 242, 234)
    private val border = Color.rgb(220, 231, 224)

    private val root = column().apply {
        setBackgroundColor(white)
        isFocusableInTouchMode = true
    }
    private val room = column().apply { pad(16, 14, 16, 16) }
    private val scroll = ScrollView(activity).apply {
        setBackgroundColor(paper)
        isFillViewport = true
        addView(room)
    }
    private val messages = column().also(room::addView)
    private val empty = column().apply {
        gravity = Gravity.CENTER
        pad(14, 36, 14, 22)
        addView(label("음성 대화", 21f, ink, bold = true).apply { gravity = Gravity.CENTER })
        addView(label("마이크를 켜고 상대방처럼 말해 보세요.\n말이 끝나면 답변 3개를 추천해요.", 14f).apply {
            gravity = Gravity.CENTER
            pad(0, 8, 0, 0)
        })
    }
    private val partial = label("", 14f).apply {
        background = shape(white, 16)
        pad(14, 10, 14, 10)
        visibility = View.GONE
    }.also(room::addView)
    private val suggestions = column().apply {
        background = shape(white, 20, border)
        pad(12, 12, 12, 12)
        visibility = View.GONE
    }.also { room.addView(it, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) }) }
    private val suggestionTitle = label("추천 답변", 15f, ink, bold = true).also(suggestions::addView)
    private val candidates = column().also(suggestions::addView)
    private val modelState = label("", 12f, accent).apply {
        maxLines = 2
        ellipsize = android.text.TextUtils.TruncateAt.END
    }
    val settings = button("설정", primary = false).apply { contentDescription = "대화 및 모델 설정" }
    val micStatus = label("", 12f).apply {
        gravity = Gravity.CENTER_VERTICAL
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
    }
    val microphone = button("마이크 시작")
    val languagePack = button("한국어 음성 팩 준비", primary = false).apply { visibility = View.GONE }
    val draft = editField("상대방 메시지 입력").apply {
        maxLines = 3
        minHeight = dp(48)
    }
    val send = button("보내기").apply { isEnabled = false }

    init {
        val header = row().apply {
            pad(16, 8, 16, 8)
            addView(column().apply {
                addView(label("통화 도우미", 22f, ink, bold = true))
                addView(modelState)
            }, LinearLayout.LayoutParams(0, -2, 1f))
            addView(settings, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
        }
        root.addView(header)
        root.addView(divider())
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        root.addView(divider())
        root.addView(column().apply {
            pad(12, 6, 12, 8)
            addView(languagePack)
            addView(row().apply {
                addView(micStatus, LinearLayout.LayoutParams(0, -2, 1f))
                addView(microphone, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(8) })
            })
            addView(row().apply {
                addView(draft, LinearLayout.LayoutParams(0, -2, 1f))
                addView(send, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(8) })
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
        })
        if (Build.VERSION.SDK_INT >= 30) {
            activity.window.setDecorFitsSystemWindows(false)
            root.setOnApplyWindowInsetsListener { view, insets ->
                val safe = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
                val keyboard = insets.getInsets(WindowInsets.Type.ime())
                view.setPadding(safe.left, safe.top, safe.right, maxOf(safe.bottom, keyboard.bottom))
                insets
            }
        }
        activity.setContentView(root)
        root.requestFocus()
    }

    fun setModelState(value: CharSequence) {
        modelState.text = value
    }

    fun setMicrophone(active: Boolean, enabled: Boolean) {
        microphone.text = if (active) "마이크 중지" else "마이크 시작"
        microphone.background = touchBackground(if (active) Color.rgb(150, 50, 55) else accent)
        microphone.isEnabled = enabled
    }

    fun setPartial(value: String) {
        partial.visibility = if (value.isBlank()) View.GONE else View.VISIBLE
        partial.text = if (value.isBlank()) "" else "받아쓰는 중 · $value"
        if (value.isNotBlank()) scrollToLatest()
    }

    fun showTranscript(transcript: String) {
        messages.removeAllViews()
        if (transcript.isBlank()) messages.addView(empty)
        transcript.lineSequence().filter { it.isNotBlank() }.forEach { line ->
            val own = line.startsWith("나:")
            val text = when {
                own -> line.removePrefix("나:").trim()
                line.startsWith("상대방:") -> line.removePrefix("상대방:").trim()
                else -> line
            }
            val bubble = column().apply {
                background = shape(if (own) mint else white, 18, if (own) null else border)
                pad(13, 9, 13, 10)
                addView(label(if (own) "나" else "상대방", 12f, if (own) accent else muted, bold = true))
                addView(label(text, 16f, ink).apply { pad(0, 3, 0, 0) })
            }
            messages.addView(bubble, LinearLayout.LayoutParams(-2, -2).apply {
                gravity = if (own) Gravity.END else Gravity.START
                if (own) marginStart = dp(40) else marginEnd = dp(40)
                bottomMargin = dp(8)
            })
        }
        scrollToLatest()
    }

    fun clearSuggestions() {
        streamingReply = null
        candidates.removeAllViews()
        suggestions.visibility = View.GONE
    }

    fun showGenerating() {
        clearSuggestions()
        suggestionTitle.text = "답변을 만드는 중…"
        suggestions.visibility = View.VISIBLE
        scrollToLatest()
    }

    private var streamingReply: Button? = null

    fun showReplyPreview(text: String) {
        if (text.isEmpty()) {
            removeReplyPreview()
            return
        }
        val preview = streamingReply ?: addReplyButton().also {
            streamingReply = it
            it.isEnabled = false
        }
        if (preview.text.toString() != text) {
            preview.text = text
            scrollToLatest()
        }
    }

    fun addReply(reply: String, count: Int, select: () -> Unit) {
        suggestionTitle.text = "추천 답변 · $count/3 생성 중"
        val button = streamingReply ?: addReplyButton()
        streamingReply = null
        button.apply {
            text = reply
            isEnabled = true
            setOnClickListener { select() }
        }
        scrollToLatest()
    }

    private fun addReplyButton() = button("", primary = false).apply {
        gravity = Gravity.START or Gravity.CENTER_VERTICAL
        candidates.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(6) })
    }

    private fun removeReplyPreview() {
        streamingReply?.let { candidates.removeView(it) }
        streamingReply = null
    }

    fun finishReplies(timing: String) {
        removeReplyPreview()
        suggestionTitle.text = timing
    }

    fun showGenerationError(heading: String, detail: String) {
        removeReplyPreview()
        suggestionTitle.text = heading
        candidates.addView(label(detail, 14f).apply {
            pad(0, 6, 0, 0)
            setTextIsSelectable(true)
        })
        scrollToLatest()
    }

    private fun scrollToLatest() {
        scroll.post { scroll.scrollTo(0, room.height - scroll.height) }
    }

    fun column() = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }

    private fun row() = LinearLayout(activity).apply { gravity = Gravity.CENTER_VERTICAL }

    fun label(value: String, size: Float, color: Int = muted, bold: Boolean = false) =
        TextView(activity).apply {
            text = value
            textSize = size
            setTextColor(color)
            if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }

    fun button(value: String, primary: Boolean = true) = Button(activity).apply {
        text = value
        textSize = 14f
        isAllCaps = false
        minWidth = 0
        minimumWidth = 0
        minHeight = dp(48)
        minimumHeight = dp(48)
        stateListAnimator = null
        background = touchBackground(if (primary) accent else mint)
        setTextColor(ColorStateList(
            arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()),
            intArrayOf(if (primary) muteOnAccent else muted, if (primary) white else accent),
        ))
        pad(14, 8, 14, 8)
    }

    fun editField(placeholder: String) = EditText(activity).apply {
        hint = placeholder
        textSize = 15f
        setTextColor(ink)
        setHintTextColor(muted)
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        gravity = Gravity.TOP or Gravity.START
        background = shape(paper, 16, border)
        pad(12, 10, 12, 10)
    }

    private fun divider() = View(activity).apply {
        setBackgroundColor(border)
        layoutParams = LinearLayout.LayoutParams(-1, dp(1))
    }

    private fun touchBackground(color: Int) = RippleDrawable(
        ColorStateList.valueOf(0x2215332A), shape(color, 16), null,
    )

    private fun shape(color: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = dp(radius).toFloat()
        if (stroke != null) setStroke(dp(1), stroke)
    }

    fun View.pad(left: Int, top: Int, right: Int, bottom: Int) {
        setPadding(dp(left), dp(top), dp(right), dp(bottom))
    }

    private fun dp(value: Int) = (value * activity.resources.displayMetrics.density + 0.5f).toInt()

    private companion object {
        const val muteOnAccent = 0xFFD4E4DE.toInt()
    }
}
