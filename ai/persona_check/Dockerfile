# 시험 창구(persona_check) 이미지: 페르소나 적용 전 시나리오 시험. AI 서버 이미지에는 넣지 않고 이 이미지로 따로 띄운다.
# AI 서버 이미지 위에 얹는다 → 통화 코드(app/ 등)와 의존성이 늘 그 릴리스와 같다(다른 커밋의 코드로 시험하지 않게).
# 빌드(ai/ 에서): docker build --build-arg AI_IMAGE=<AI 서버 이미지> --file persona_check/Dockerfile --tag <이름> .
ARG AI_IMAGE
FROM ${AI_IMAGE}
USER root
# 통화를 걸 때 쓰는 WebRTC 라이브러리(서버 이미지 의존성에는 넣지 않았다). 시험 통화로 확인한 판으로 고정한다.
# 결과 폴더는 볼륨이 붙는 자리라 미리 만들어 appuser에게 준다(이름 붙은 볼륨은 처음 붙을 때 이 소유자를 따른다)
RUN uv pip install --python /app/.venv/bin/python --no-cache aiortc==1.16.0 \
    && mkdir -p /app/logs/persona_check \
    && chown -R appuser:appuser /app/logs/persona_check
COPY --chown=appuser:appuser persona_check ./persona_check
USER appuser
EXPOSE 8765
CMD ["/app/.venv/bin/python", "-m", "persona_check.server"]
