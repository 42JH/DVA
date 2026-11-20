# 배포 (develop-ai → Jenkins → Lightsail)

원본 S15P31D109 `ai/Jenkinsfile`·`ai/deploy/`를 그대로 쓴다(서버·경로·자격증명 같음). 리빌드는 develop-ai의 `ai/`에 들어가고, 이전 서버 파일은 `ai/old/`에 둔다(이미지·테스트에서 제외).

## 흐름
1. develop-ai에 머지 → Jenkins(`ai/Jenkinsfile`): `docker build ai` → 이미지에서 `import app.main` 확인 → `ai/deploy/upload.sh`
2. `upload.sh`: Jenkins 비밀 파일 `dva-ai` → 서버 `/home/ubuntu/dva-ai/shared/.env`, 서버에서 이미지 빌드, 릴리스 폴더에 `compose.yaml`·`config/`·`prompts/`·deploy 스크립트
3. `deploy.sh`: `docker compose --project-name dva-ai -f compose.yaml -f compose.deploy.yaml up --wait`(120s). 실패하면 직전 릴리스로 복구. 백엔드 네트워크 `dva-prod_ai_net`(별칭 `ai`)
4. 컨테이너를 다시 만들므로 **진행 중인 통화는 끊긴다**

## 리빌드가 원본 배포에 맞춘 것
- compose: `BACKEND_MOCK` 기본 false(운영 = 실제 BE), `BACKEND_API_URL`·`PBX_WEBHOOK_SECRET` 필수, `BACKEND_MODEL` 기본 `gpt-6-luna`(운영 `.env`에 없어도 뜸), `./config`·`./prompts` 읽기 전용 마운트(apply-faq-runtime.py의 FAQ 운영 선택이 반영되게)
- `deploy/compose.deploy.yaml`: 통화 로그 `/app/logs`를 볼륨 `ai_logs`로(릴리스 폴더에 흩어지지 않게)
- `/health`(원본 경로)와 `/healthz` 둘 다
- `.dockerignore`: `old`·`deploy`·`Jenkinsfile` 제외
- 볼륨 `qdrant_data`·`rag_state`는 원본과 같은 이름(project dva-ai) — 운영 색인을 그대로 쓴다. 새 볼륨 `ai_state`(결과 아웃박스)·`ai_logs`

## 운영 `.env`(Jenkins `dva-ai`)에 필요한 값
원본과 같은 키 + 선택: `BACKEND_MODEL`(없으면 gpt-6-luna), `BACKEND_EFFORT`, `LOG_LEVEL`. **`BACKEND_MOCK`은 비우거나 false**.

## 로컬 확인(Jenkins와 같은 순서)
```bash
bash -n deploy/upload.sh deploy/deploy.sh
docker build --pull --platform linux/amd64 --tag dva-ai-server:check .
docker run --rm dva-ai-server:check /app/.venv/bin/python -c "import app.main"
```
