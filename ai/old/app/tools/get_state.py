from app.tools._base import Result, tool


@tool("get_state", "지금 통화 단계·빠진 항목·쓸 수 있는 도구·다음에 할 일을 읽는다. 아무것도 바꾸지 않는다.")
async def get_state(ctx, args) -> Result:
    return Result()
