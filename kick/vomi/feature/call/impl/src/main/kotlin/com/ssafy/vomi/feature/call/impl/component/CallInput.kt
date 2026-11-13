package com.ssafy.vomi.feature.call.impl.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import com.ssafy.vomi.core.designsystem.component.Text
import com.ssafy.vomi.core.designsystem.icon.VomiIcons
import com.ssafy.vomi.core.designsystem.theme.VomiTheme
import com.ssafy.vomi.feature.call.impl.R
import com.ssafy.vomi.feature.call.impl.model.CallUiState

@Composable
internal fun CallInput(
    state: CallUiState,
    onDraftChange: (String) -> Unit,
    onMicrophoneClick: () -> Unit,
    onSendClick: () -> Unit,
    modifier: Modifier = Modifier,
    onInputBoundsChanged: (Rect) -> Unit = {},
    isDropTargetActive: Boolean = false,
    focusRequest: Int = 0,
) {
    var editingValue by remember {
        mutableStateOf(TextFieldValue(state.draft, selection = TextRange(state.draft.length)))
    }
    // External drafts start at the end; ordinary edits retain selection and IME composition.
    val inputValue = if (editingValue.text == state.draft) editingValue else {
        TextFieldValue(state.draft, selection = TextRange(state.draft.length))
    }
    SideEffect { editingValue = inputValue }
    val focusRequester = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(focusRequest) {
        if (focusRequest > 0 && state.canType) {
            // Re-selecting the same suggestion must also move a manually repositioned cursor.
            editingValue = inputValue.copy(
                selection = TextRange(inputValue.text.length),
                composition = null,
            )
            focusRequester.requestFocus()
            keyboard?.show()
        }
    }
    LaunchedEffect(state.isMicrophoneEnabled) {
        if (state.isMicrophoneEnabled) {
            focusManager.clearFocus()
            keyboard?.hide()
        }
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        CallRoundButton(
            icon = if (state.isMicrophoneEnabled) R.drawable.ic_microphone else R.drawable.ic_microphone_off,
            description = stringResource(if (state.isMicrophoneEnabled) R.string.call_mic_off_action else R.string.call_mic_on_action),
            onClick = onMicrophoneClick,
            modifier = Modifier.size(48.dp),
            color = if (state.isMicrophoneEnabled) Color(0xFFB9D7FA) else Color.White.copy(alpha = 0.22f),
            tint = if (state.isMicrophoneEnabled) Color(0xFF182234) else Color.White,
        )
        Row(
            modifier = Modifier
                .weight(1f)
                .onGloballyPositioned { onInputBoundsChanged(it.boundsInRoot()) }
                .border(
                    width = 1.dp,
                    color = if (isDropTargetActive) Color(0xFFB9D7FA) else Color.Transparent,
                    shape = RoundedCornerShape(24.dp),
                )
                .background(
                    Color.White.copy(alpha = if (state.canType) 0.24f else 0.10f),
                    RoundedCornerShape(24.dp)
                )
                .heightIn(min = 48.dp)
                .padding(start = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = inputValue,
                onValueChange = { value ->
                    editingValue = value
                    if (value.text != state.draft) onDraftChange(value.text)
                },
                enabled = state.canType,
                textStyle = VomiTheme.typography.bodyR14.copy(color = Color.White.copy(alpha = if (state.canType) 1f else 0.45f)),
                cursorBrush = SolidColor(Color(0xFFB9D7FA)),
                maxLines = 4,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Sentences,
                    imeAction = ImeAction.Send
                ),
                keyboardActions = KeyboardActions(onSend = { onSendClick() }),
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focusRequester)
                    .padding(vertical = 8.dp),
                decorationBox = { innerTextField ->
                    Box {
                        if (state.draft.isEmpty()) {
                            Text(
                                text = stringResource(
                                    when {
                                        isDropTargetActive -> R.string.call_input_drop_hint
                                        state.isMicrophoneEnabled -> R.string.call_input_mic_enabled
                                        else -> R.string.call_input_hint
                                    },
                                ),
                                color = Color.White.copy(alpha = 0.45f),
                                style = VomiTheme.typography.bodyR14,
                            )
                        }
                        innerTextField()
                    }
                },
            )
            CallRoundButton(
                icon = VomiIcons.Send,
                description = stringResource(R.string.call_send),
                onClick = onSendClick,
                enabled = state.canSend,
                color = Color.Transparent,
                tint = Color.White.copy(alpha = if (state.canSend) 1f else 0.25f),
            )
        }
    }
}
