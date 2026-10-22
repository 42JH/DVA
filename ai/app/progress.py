from app.flow import engine


async def send_progress(call, conn) -> None:
    """음성 모델에 "다음에 물을 것 + 기록된 값". 바뀌었을 때만 보낸다."""
    text = engine.progress_text(call, call.cfg.progress.max_chars)
    if text != call.last_progress:
        await conn.session.thinking.append(content=text, delegation_id=None)
        call.last_progress = text
