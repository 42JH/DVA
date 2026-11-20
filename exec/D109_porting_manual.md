# Dva 포팅 매뉴얼

전화 AI 택배 접수 서비스 **Dva**를 GitLab 소스에서 다시 빌드하고 배포하기 위한 문서다.

- 저장소: `https://lab.ssafy.com/s15-final/S15P31D109.git`
- 작성일: 2026-11-18


---

## 0. 전체 구성

### 0.1 구성 요소

| 구성 요소                | 하는 일                                                              | 기술                               | 배포 형태                                   |
| ------------------------ | -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------- |
| 관리자 웹                | 주문·통화·FAQ·AI 상담가(페르소나) 관리 화면                          | React + Vite 정적 빌드             | 호스트 Nginx가 `/var/www/dva`를 직접 서빙   |
| 백엔드(모놀리식)         | 업무 API, 관리자 인증, PBX 웹훅 수신, 결제, 녹취 저장                | NestJS + PostgreSQL                | Docker Compose 프로젝트 `dva-prod`          |
| AI 상담 서버             | 전화 음성 상담(OpenAI SIP 세션), 주소 보정, FAQ 검색(RAG), 관제 화면 | FastAPI + Qdrant                   | Docker Compose 프로젝트 `dva-ai`            |
| 시험 창구(persona-check) | 페르소나 적용 전 시나리오 시험 통화                                  | FastAPI + aiortc                   | Compose 프로젝트 `dva-persona-check` (선택) |
| GPU 리랭커               | RAG 검색 결과 재순위                                                 | PyTorch + Qwen3-Reranker           | GCP VM, systemd + Docker (선택)             |
| 백엔드(MSA)              | 모놀리식과 같은 기능을 5개 서비스로 옮기는 병행 트랙                 | NestJS ×5 + PostgreSQL + Liquibase | 별도 서버의 k3s (선택)                      |
| Kick 서버                | Android 앱의 통화 신호·음성 합성 API                                 | NestJS + PostgreSQL + LiveKit      | Compose 프로젝트 `kick-backend` (선택)      |
| Android 앱 `vomi`        | 앱 간 음성 통화, 온디바이스 자막·답변 추천                           | Kotlin + Compose                   | debug APK 직접 설치                         |
| CI/CD                    | 빌드·검증·배포                                                       | Jenkins                            | Compose 프로젝트 `dva-jenkins`              |
| 관측                     | 로그·지표·알림                                                       | Loki, Prometheus, Alloy, Grafana   | Compose 프로젝트 `dva-observability` (선택) |

모놀리식 백엔드가 실제 통화·PBX·결제가 붙는 운영 대상이다. MSA는 같은 `develop-backend` push로 자동 배포되지만, 관리자 웹과 AI의 요청은 모놀리식으로 간다(호스트 Nginx의 `/api` 대상이 전부 모놀리식).

Android 앱 `vomi`와 Kick 서버는 Dva 상담 서버를 호출하지 않는 별도 기능이다. 앱은 Kick 서버와 LiveKit만 사용한다.

### 0.2 서버

| 서버                                   | 주소                                                              | 사양                                                        | 올라가는 것                                                                 |
| -------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------- |
| 주 서버 (AWS Lightsail `dva-monolith`) | `13.209.59.180`, `dva-d109.duckdns.org`, `13-209-59-180.sslip.io` | Ubuntu 24.04, 2 vCPU / 8GB / 160GB, linux/amd64             | 호스트 Nginx, 관리자 웹, 백엔드, AI, Jenkins, 관측, 결제 시연               |
| 보조 서버 (AWS Lightsail)              | `3.37.162.168`                                                    | 저장소에서 확인 불가                                        | Kick 서버와 그 Jenkins. AI 전용 배포 대상으로도 지정 가능(`AI_DEPLOY_HOST`) |
| MSA 서버 (SSAFY 제공)                  | `k15d109.p.ssafy.io`                                              | 단일 노드 k3s `v1.35.5+k3s1`                                | MSA 5개 서비스, PostgreSQL, Traefik                                         |
| GPU VM (GCP Compute Engine)            | `https://<고정 IP>.sslip.io`                                      | `g2-standard-4` + L4 1개, `asia-northeast3-a`, Ubuntu 22.04 | 리랭커                                                                      |

### 0.3 요청 흐름 (주 서버)

```text
인터넷 ──443──> 호스트 Nginx (TLS 종료)
  /                         → /var/www/dva (관리자 웹 정적 파일)
  /api/                     → 127.0.0.1:8082 컨테이너 Nginx → backend:3000 → db:5432
  /api/webhooks/pbx/call-ended → backend + (mirror) AI 127.0.0.1:8000
  /api/webhooks/openai/call-incoming, /pbx/webhook/call-ended, /monitor → AI 127.0.0.1:8000
  /jenkins/                 → 127.0.0.1:8080
  /grafana/                 → 127.0.0.1:3001
  /payment-test/            → 127.0.0.1:3002

backend ──(Docker 네트워크 dva-prod_ai_net)── ai   (http://ai:8000 ↔ http://backend:3000)
ai ── qdrant:6333 (내부 네트워크) / OpenAI / 카카오 로컬 / GPU 리랭커(HTTPS)
```

외부에 열린 포트는 호스트 Nginx의 80·443과 SSH뿐이다. 나머지는 전부 `127.0.0.1` 또는 Docker 내부 네트워크에만 묶여 있다.

---

## 1. 빌드 및 배포

### 1.1 사용 제품과 버전

#### 1.1.1 JVM · 웹서버 · WAS · DB 요약

| 구분                  | 제품                                                                               | 버전                                                                              | 근거 파일                                                                           |
| --------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| JVM                   | 애플리케이션은 JVM을 쓰지 않는다(Node.js·Python). JVM이 쓰이는 곳은 아래 3곳뿐이다 |                                                                                   |                                                                                     |
| JVM (Jenkins)         | Jenkins 컨트롤러·에이전트                                                          | JDK 21 (`jenkins/jenkins:2.580.1-jdk21`, `jenkins/inbound-agent:jdk21`)           | `infra/jenkins/compose.yaml`, `infra/jenkins/agent.Dockerfile`                      |
| JVM (Liquibase)       | MSA DB 마이그레이션                                                                | `liquibase/liquibase:5.0.4` 이미지 내장 JRE (버전은 이미지 내부, 확인 불가)       | `msa/liquibase/Dockerfile`                                                          |
| JVM (Android 빌드)    | Gradle 데몬 / 컴파일 타깃                                                          | JDK 21 / JVM target 17                                                            | `kick/vomi/gradle/gradle-daemon-jvm.properties`, `build-logic/.../KotlinAndroid.kt` |
| 웹서버 (호스트)       | Nginx                                                                              | Ubuntu apt 패키지(문서 기록 1.24)                                                 | `infra/https/setup-ip-https.sh`                                                     |
| 웹서버 (컨테이너)     | Nginx                                                                              | `nginx:stable-alpine`                                                             | `compose.prod.yaml`                                                                 |
| 웹서버 (GPU VM)       | Caddy                                                                              | `caddy:2.10.2-alpine`                                                             | `ai/deploy/gcp/dvr-reranker-proxy.service`                                          |
| 웹서버 (MSA)          | Traefik (k3s 내장 Ingress)                                                         | 버전 확인 불가                                                                    | `msa/services/*/k8s.yaml`                                                           |
| WAS (백엔드·MSA·Kick) | Node.js + NestJS (Express 5.2.1)                                                   | Node 24 (`node:24-bookworm-slim`), NestJS 11.2.7                                  | `backend/Dockerfile`, `backend/package-lock.json`                                   |
| WAS (AI)              | Python + FastAPI + Uvicorn                                                         | Python 3.14 (`python:3.14-slim`), FastAPI 0.162.0, Uvicorn 0.54.0 (워커 1개 고정) | `ai/Dockerfile`, `ai/uv.lock`                                                       |
| DB                    | PostgreSQL                                                                         | 17 (`postgres:17-alpine`, MSA 검증 이미지는 `17.11-bookworm`)                     | `compose.prod.yaml`, `msa/liquibase/verify.py`                                      |
| 벡터 DB               | Qdrant                                                                             | 서버 `v1.13.4`, 클라이언트 1.19.1                                                 | `ai/compose.yaml`, `ai/pyproject.toml`                                              |
| 인증서                | Certbot (Let's Encrypt)                                                            | pip `certbot>=5.4` (검증 당시 5.8.0)                                              | `infra/https/setup-ip-https.sh`                                                     |
| 컨테이너              | Docker / Compose                                                                   | 최소 버전 명시 없음. 기록된 실측값: Docker 29.9.2, Compose v5.6.1                 | `infra/jenkins/MIGRATION-2026-10-25.md`, `infra/deploy/README.md`                   |
| CI                    | Jenkins                                                                            | 2.580.1 (빌드용 `docker:29-dind`)                                                 | `infra/jenkins/compose.yaml`                                                        |

`node:24-bookworm-slim`, `postgres:17-alpine`, `nginx:stable-alpine`, `python:3.14-slim`은 패치 버전이 고정되지 않은 태그라 빌드 시점에 따라 세부 버전이 달라진다.

#### 1.1.2 관리자 웹 (`frontend/`)

| 항목                     | 버전                                      |
| ------------------------ | ----------------------------------------- |
| 런타임 / 패키지 매니저   | Node.js 24 / npm (`package-lock.json` v3) |
| React / react-dom        | 19.3.1                                    |
| Vite                     | 8.3.5 (`@vitejs/plugin-react` 6.1.2)      |
| TypeScript               | 6.0.3                                     |
| Tailwind CSS             | 4.3.3 (`@tailwindcss/vite`)               |
| React Router             | 8.5.0                                     |
| TanStack Query           | 5.104.5                                   |
| MSW (개발 전용 가짜 API) | 3.0.3                                     |
| 린트·포맷                | ESLint 10.13.0, Prettier 3.9.10           |
| 테스트                   | `tsx` 4.23.15 + Node 내장 `node --test`   |

`package.json`에 `engines`가 없다. 의존성 요구치상 Node 22.22 이상이면 설치되지만 CI와 팀 문서는 Node 24를 쓴다.

#### 1.1.3 백엔드 모놀리식 (`backend/`)

| 항목            | 버전                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------- |
| 런타임          | Node.js 24 (`node:24-bookworm-slim`, CI 실측 24.22.1)                                       |
| 프레임워크      | NestJS 11.2.7, `@nestjs/config` 4.0.4, `@nestjs/swagger` 11.4.7, Express 5.2.1              |
| 언어            | TypeScript 5.9.3 (target ES2022, CommonJS)                                                  |
| DB 접근         | `pg` 8.23.1로 직접 SQL (ORM 없음)                                                           |
| AWS SDK         | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` 3.1157.0                              |
| 검증            | class-validator 0.14.4, class-transformer 0.5.1                                             |
| 테스트          | Node 내장 `node:test` (Jest 없음)                                                           |
| DB 마이그레이션 | 자체 셸 러너 `infra/database/migrate.sh` + SQL 66개(`backend/migrations/001~067`, 006 결번) |

#### 1.1.4 백엔드 MSA (`msa/`)

| 항목                | 버전                                                                              |
| ------------------- | --------------------------------------------------------------------------------- |
| 서비스              | customer(3001), order(3002), delivery(3003), consultation(3004), operations(3005) |
| 런타임 / 프레임워크 | Node.js 24, NestJS 11.2.7, `pg` 8.23.1, Jest 30.5.2                               |
| 오케스트레이션      | k3s `v1.35.5+k3s1` 단일 노드, Ingress Traefik                                     |
| DB                  | PostgreSQL 17.11, 서비스별 데이터베이스 5개                                       |
| 마이그레이션        | Liquibase 5.0.4 + PostgreSQL JDBC 42.7.14                                         |
| 관측                | Prometheus v3.15.1, Loki 3.7.9, Alloy v1.21.2, Grafana 13.3.0                     |
| 배포 스크립트       | Bash + Python 3.11 이상                                                           |

서비스 간 통신은 HTTP 직접 호출과 PostgreSQL outbox/inbox다. 메시지 브로커·Redis·API 게이트웨이는 없다.

#### 1.1.5 AI 상담 서버 (`ai/`)

| 항목                   | 버전                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 런타임 / 패키지 매니저 | Python 3.14 / uv 0.11.28 (`uv.lock`)                                                                                          |
| 웹                     | FastAPI 0.162.0, Starlette 1.10.0, Uvicorn 0.54.0                                                                             |
| OpenAI SDK             | `openai[realtime]` 3.35.1                                                                                                     |
| RAG                    | LangChain core 1.7.4, langchain-openai 1.7.3, langchain-qdrant 1.1.0, qdrant-client 1.19.1, kiwipiepy 0.24.1, rank-bm25 0.2.2 |
| 기타                   | pydantic 2.14.2, tiktoken 0.14.0, numpy 2.5.4                                                                                 |
| 테스트                 | pytest 9.2.0                                                                                                                  |
| GPU 리랭커 이미지      | `pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime`, transformers 4.52.4                                                          |
| 시험 창구 추가 의존    | aiortc 1.16.0                                                                                                                 |

코드에 적힌 모델 이름: 음성 세션 `gpt-live-1`, 위임·판정 `gpt-6-luna`, 임베딩 `text-embedding-3-large`(3072차원), 리랭커 `Qwen/Qwen3-Reranker-0.6B`, 시험 창구 TTS `gpt-4o-mini-tts`, 받아쓰기 `gpt-4o-transcribe`.

`ai/old/`는 폐기된 이전 구현이다. 현재 코드와 이미지에 포함되지 않는다.

#### 1.1.6 Android 앱 (`kick/vomi/`)과 Kick 서버 (`kick/backend/`)

| 항목                            | 버전                                                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gradle wrapper                  | 9.5.0                                                                                                                                                                                                         |
| Android Gradle Plugin           | 9.2.1                                                                                                                                                                                                         |
| Kotlin / KSP                    | 2.3.21 / 2.3.5                                                                                                                                                                                                |
| JDK                             | Gradle 데몬 21, 소스·타깃 호환 17                                                                                                                                                                             |
| compileSdk / targetSdk / minSdk | 37 / 37 / 26                                                                                                                                                                                                  |
| Compose BOM                     | 2026.02.01                                                                                                                                                                                                    |
| 주요 라이브러리                 | Hilt 2.59.2, Retrofit 3.0.0, OkHttp logging 5.3.2, kotlinx-serialization 1.11.0, coroutines 1.11.0, LiveKit Android 2.30.0, ML Kit `genai-prompt` 1.0.0-beta4, Room 2.8.4, DataStore 1.2.1, Navigation3 1.1.3 |
| applicationId / 버전            | `com.ssafy.vomi` / versionCode 1, versionName 1.0                                                                                                                                                             |
| Kick 서버                       | Node.js 24, NestJS 11.2.7, `pg` 8.23.1, `livekit-server-sdk` 2.19.3, TypeScript 5.9.3, PostgreSQL 17                                                                                                          |
| 로컬 LiveKit(시험용)            | LiveKit Server v1.13.11                                                                                                                                                                                       |

NDK·CMake·네이티브 코드는 없다.

#### 1.1.7 IDE

IDE 설정 파일(`.idea/`, `.vscode/`)은 `.gitignore` 대상이라 저장소에 없다. 제출 전에 팀이 실제 사용한 버전을 적는다.

| 영역    | IDE                                             | 버전        |
| ------- | ----------------------------------------------- | ----------- |
| FE      | (기입 필요)                                     | (기입 필요) |
| BE      | (기입 필요)                                     | (기입 필요) |
| AI      | (기입 필요)                                     | (기입 필요) |
| Android | Android Studio — AGP 9.2.1을 지원하는 버전 필요 | (기입 필요) |

---

### 1.2 환경 변수

실제 비밀 값은 저장소에 없다. `.gitignore`가 `.env`, `.env.*`, `*.pem`, `*.key`, `**/secrets/`를 제외한다. 아래 표의 값은 서버의 환경 파일이나 Jenkins credential에 직접 넣는다.

#### 1.2.1 관리자 웹

운영 빌드에는 환경 파일이 필요 없다. `.env.production`은 의도적으로 두지 않았고, API는 화면과 같은 주소의 `/api`를 쓴다.

| 변수                       | 용도                                          | 기본값                                       | 비고                   |
| -------------------------- | --------------------------------------------- | -------------------------------------------- | ---------------------- |
| `VITE_API_BASE_URL`        | API 기본 경로(빌드 때 번들에 들어감)          | `/api`                                       | 운영은 설정하지 않음   |
| `VITE_USE_MOCK`            | `true`이고 개발 모드일 때만 MSW 가짜 API 사용 | `.env.development`에 `true`                  | 운영 빌드에서는 무시   |
| `DEV_PROXY_TARGET`         | 개발 서버 `/api` 프록시 대상                  | `.env.development`에 `https://13.209.59.180` | `npm run dev`에만 사용 |
| `VITE_SCENARIO_TEST`       | `false`일 때만 시나리오 시험 화면을 끔        | 켜짐                                         |                        |
| `VITE_TEST_BEFORE_APPLY`   | `true`면 통화 반영 전 시험 관문을 켬          | 꺼짐                                         |                        |
| `DEPLOY_HOST`              | 배포 대상 호스트(`deploy/ci-deploy.sh`)       | `13.209.59.180`                              |                        |
| `DVA_RELEASES`, `DVA_LIVE` | 서버의 판 폴더·라이브 링크 경로               | `/var/www/dva-releases`, `/var/www/dva`      |                        |

개인 덮어쓰기는 `frontend/.env.development.local`에 둔다(Git 제외).

#### 1.2.2 백엔드 모놀리식

예시 파일: `backend/.env.example`. 운영 값은 서버 `/home/ubuntu/dva-deploy/shared/.env`(권한 600)에 둔다. 검증 규칙은 `backend/src/config/environment.ts`, `backend/src/payments/payment-config.ts`.

`NODE_ENV=production`에서는 env 파일을 읽지 않고 컨테이너에 주입된 환경 변수만 쓴다.

| 변수                                                              | 용도                                                                                             | 기본값                 | 필수                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------ |
| `NODE_ENV`                                                        | development / test / production                                                                  | development            | compose가 고정                                   |
| `PORT`                                                            | 리슨 포트                                                                                        | 3000                   | compose가 고정                                   |
| `AUTH_PROXY_HOPS`                                                 | 로그인 IP 제한용 프록시 홉 수(0·1·2)                                                             | 0                      | 운영 2, 로컬 compose 1 (compose가 고정)          |
| `SECURITY_LOG_HMAC_KEY`                                           | 보안 로그 가명화 키, 64자리 hex                                                                  | 개발은 임시 키         | **운영 필수**                                    |
| `DB_HOST`, `DB_PORT`                                              | DB 주소                                                                                          | — , 5432               | compose가 `db` 고정                              |
| `DB_USER`, `DB_PASSWORD`, `DB_NAME`                               | DB 계정·DB명(PostgreSQL 컨테이너 초기화에도 사용)                                                | 없음                   | **필수**                                         |
| `AI_AGENT_URL`                                                    | AI 서버 내부 주소                                                                                | 없음                   | compose가 `http://ai:8000` 고정                  |
| `AI_BUSINESS_TOKEN`                                               | AI→BE 업무 API Bearer, 32자 이상                                                                 | 빈 값                  | 없으면 AI의 업무 호출 503                        |
| `AI_PERSONA_TOKEN`                                                | 페르소나 조회·알림 공유 토큰, 32자 이상                                                          | 빈 값                  | 없으면 페르소나 저장 503                         |
| `AI_FAQ_TOKEN`                                                    | FAQ 변경 알림(BE→AI) 토큰, 32자 이상                                                             | 빈 값                  | 없으면 알림 워커 꺼짐                            |
| `AI_INSIGHTS_TOKEN`                                               | 통화 분석·이벤트 수집 토큰, 32자 이상                                                            | 빈 값                  | 없으면 해당 API 503                              |
| `PERSONA_CHECK_URL`                                               | 시험 창구 주소(운영 `http://persona-check:8765`)                                                 | 빈 값                  | 선택                                             |
| `PERSONA_CHECK_TOKEN`                                             | 시험 창구 토큰, 64자리 hex                                                                       | 빈 값                  | 선택                                             |
| `CALL_ANALYSIS_OPENAI_API_KEY`                                    | 통화 불만 판정 전용 OpenAI 키                                                                    | 빈 값                  | 없으면 판정 워커 꺼짐                            |
| `CALL_ANALYSIS_CONCURRENCY`                                       | 동시 판정 수(1~4)                                                                                | 2                      | 선택                                             |
| `CORS_ORIGINS`                                                    | 허용할 화면 주소 목록(쉼표)                                                                      | 빈 목록                | 사실상 필수(없으면 로그인 403)                   |
| `SWAGGER_ENABLED`                                                 | Swagger 노출                                                                                     | 개발 true, 그 외 false | 선택                                             |
| `PBX_WEBHOOK_TOKEN`                                               | PBX 통화 종료 웹훅 Bearer, 32바이트 이상                                                         | 빈 값                  | **운영 필수**                                    |
| `DVER_API_URL`                                                    | 디버 접수 API 주소                                                                               | 코드 기본값 있음       | 선택                                             |
| `DVER_API_KEY`                                                    | 디버 `X-API-Key`                                                                                 | 빈 값                  | 없으면 최종 접수 503                             |
| `ORDER_PAYMENTS_ENABLED`                                          | 실주문 토스 결제 연동                                                                            | false                  | 선택                                             |
| `PAYMENT_PUBLIC_URL`                                              | 결제 페이지 공개 주소. HTTPS, 경로가 정확히 `/api/payments`, origin이 `CORS_ORIGINS`에 있어야 함 | 빈 값                  | 결제를 켜면 필수                                 |
| `TOSS_TEST_CLIENT_KEY`                                            | 토스 결제위젯 클라이언트 키(`test_gck_`만 허용)                                                  | 빈 값                  | 결제를 켜면 필수                                 |
| `TOSS_TEST_SECRET_KEY`                                            | 토스 결제위젯 시크릿 키(`test_gsk_`만 허용)                                                      | 빈 값                  | 결제를 켜면 필수                                 |
| `TOSS_BILLING_SECRET_KEY`                                         | 토스 자동결제 시크릿(`test_sk_` 또는 `live_sk_`)                                                 | 빈 값                  | 카드 등록에 필요                                 |
| `PAYMENT_CARD_ENCRYPTION_KEY`                                     | 빌링키 암호화 키, 64자리 hex                                                                     | 빈 값                  | 카드 기능에 필요. **한 번 정하면 바꾸지 않는다** |
| `PAYMENT_MATTERMOST_WEBHOOK_URL`                                  | 결제 안내 Mattermost 웹훅                                                                        | 빈 값                  | 선택                                             |
| `AWS_REGION`                                                      | S3 리전                                                                                          | ap-northeast-2         | 선택                                             |
| `S3_RECORDINGS_BUCKET`                                            | 녹취 저장 버킷                                                                                   | 빈 값                  | 없으면 녹취 업로드 꺼짐                          |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` | AWS 자격 증명                                                                                    | 빈 값                  | 인스턴스 역할이 없으면 필요                      |
| `RECORDING_ALLOWED_HOSTS`                                         | 녹취 원본을 내려받을 수 있는 호스트                                                              | 코드 기본값 있음       | 선택                                             |
| `RECORDING_MATCH_WINDOW_SECONDS`                                  | 통화·녹취 시작 시각 매칭 허용 차(1~300)                                                          | 30                     | 선택                                             |

배포 스크립트가 만드는 `releases/<버전>/release.env`: `BACKEND_IMAGE`, `POSTGRES_IMAGE`, `NGINX_IMAGE` (직접 작성하지 않는다).

#### 1.2.3 AI 상담 서버

예시 파일: `ai/.env.example`(값은 따옴표 없이 쓴다). 운영 값은 Jenkins Secret file `dva-ai`에 두고, 배포할 때마다 서버 `/home/ubuntu/dva-ai/shared/.env`를 덮어쓴다. 서버에서 직접 고친 값은 다음 배포에 사라진다.

| 변수                                                                     | 용도                                                           | 기본값                                 | 필수                                            |
| ------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------- |
| `OPENAI_API_KEY`                                                         | 음성 세션·위임·임베딩                                          | 없음                                   | **필수**                                        |
| `OPENAI_WEBHOOK_SECRET`                                                  | OpenAI 수신 웹훅 서명 검증(`whsec_…`)                          | 없음                                   | **필수**                                        |
| `OPENAI_PROJECT_ID`                                                      | PBX 담당에게 전달할 SIP 대상 프로젝트 ID(코드는 읽지 않음)     | 없음                                   | 메모용                                          |
| `BACKEND_MODEL`                                                          | 위임 모델                                                      | compose `gpt-6-luna`                   | 선택                                            |
| `BACKEND_EFFORT`                                                         | 위임 추론 강도                                                 | `low`                                  | 선택                                            |
| `PBX_WEBHOOK_SECRET`                                                     | PBX 종료 웹훅 Bearer(백엔드 `PBX_WEBHOOK_TOKEN`·PBX와 같은 값) | 없음                                   | **필수**                                        |
| `MONITOR_USER`, `MONITOR_PASSWORD`                                       | 관제 화면 `/monitor` HTTP Basic                                | 없음                                   | **필수**                                        |
| `BACKEND_API_URL`                                                        | 백엔드 주소(운영 `http://backend:3000`)                        | 없음                                   | **필수**                                        |
| `BACKEND_MOCK`                                                           | `true`면 메모리 가짜 백엔드                                    | `false`                                | 선택                                            |
| `AI_BUSINESS_TOKEN`                                                      | 고객·주문·PIN·초안 API Bearer(백엔드와 같은 값)                | 없음                                   | 실제 백엔드에 붙이면 **필수**(없으면 기동 실패) |
| `AI_PERSONA_TOKEN`                                                       | 페르소나 조회와 BE→AI `/internal/persona/*` 인증               | 없음                                   | 선택(없으면 기본 프롬프트)                      |
| `AI_INSIGHTS_TOKEN`                                                      | 통화 이벤트·분석 전송                                          | 없음                                   | 선택                                            |
| `AI_FAQ_TOKEN`                                                           | BE→AI `/internal/faqs/refresh` 인증                            | 없음                                   | FAQ 동기화 수신을 켜면 필수                     |
| `KAKAO_REST_API_KEY`                                                     | 카카오 로컬 검색(지번·우편번호)                                | 없음                                   | 선택(없으면 건너뜀)                             |
| `QDRANT_API_KEY`                                                         | Qdrant 서버·클라이언트 키(임의 생성 값)                        | 없음                                   | **필수**                                        |
| `QDRANT_URL`                                                             | Qdrant 주소                                                    | compose가 `http://qdrant:6333` 고정    | —                                               |
| `RAG_RERANKER_URL`                                                       | 리랭커 주소(`/rerank` 앞까지, HTTPS)                           | 없음                                   | 선택(없으면 매뉴얼 검색 꺼짐)                   |
| `RAG_RERANKER_API_KEY`                                                   | 리랭커 Bearer 키                                               | 없음                                   | 위와 같음                                       |
| `AI_PORT`                                                                | 호스트 `127.0.0.1` 바인드 포트                                 | 8000                                   | 선택                                            |
| `ADDRESS_DATA_DIR`                                                       | 주소 DB 폴더                                                   | `./data` (운영은 `release.env`가 지정) | 선택                                            |
| `LOG_LEVEL`                                                              | 로그 레벨                                                      | `INFO`                                 | 선택                                            |
| `CONFIG_DIR`, `PROMPTS_DIR`, `CALL_LOG_DIR`, `ADDRESS_DB`, `OUTBOX_PATH` | 경로 변경용                                                    | 컨테이너 내부 기본 경로                | 선택. 빈 값으로 두지 않는다                     |

비밀이 아닌 운영 수치(RAG, FAQ 동기화, 요금표, 통화 한도 등)는 `ai/config/server.toml`에 있다. 모르는 키가 있으면 기동에 실패한다.

시험 창구 — Jenkins Secret file `dva-persona-check` → 서버 `shared/persona-check.env`:

| 변수                            | 용도                                                | 필수              |
| ------------------------------- | --------------------------------------------------- | ----------------- |
| `PERSONA_CHECK_TOKEN`           | 창구 Bearer(백엔드 `PERSONA_CHECK_TOKEN`과 같은 값) | 필수              |
| `PERSONA_CHECK_OPENAI_API_KEY`  | 시험 전용 OpenAI 키                                 | 필수              |
| `PERSONA_CHECK_MAX_CONCURRENCY` | 동시 시험 통화 수                                   | 선택(배포 기본 2) |

GPU 리랭커 — VM의 `/etc/dvr-reranker/runtime.conf`: `RAG_RERANKER_API_KEY`(VM에서 `openssl rand -hex 32`로 생성). 같은 값을 AI 서버 `.env`에 넣는다.

Jenkins 쪽: 전역 환경 변수 `AI_DEPLOY_HOST`(없으면 `13.209.59.180`).

#### 1.2.4 백엔드 MSA

환경 파일이 없다. 모든 값은 k8s Secret과 `msa/services/<서비스>/k8s.yaml`로 주입한다.

| Secret (네임스페이스 `dva`)                                                  | 키                                                                                                                                                                                                                         | 만드는 주체                      |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `customer-db`, `order-db`, `delivery-db`, `consultation-db`, `operations-db` | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`                                                                                                                                                                   | 직접 생성(필수)                  |
| `order-runtime`                                                              | `ORDER_PAYMENTS_ENABLED`, `PAYMENT_PUBLIC_URL`, `TOSS_TEST_CLIENT_KEY`, `TOSS_TEST_SECRET_KEY`, `TOSS_BILLING_SECRET_KEY`, `PAYMENT_CARD_ENCRYPTION_KEY`, `PAYMENT_MATTERMOST_WEBHOOK_URL`, `DVER_API_URL`, `DVER_API_KEY` | 직접 생성(선택)                  |
| `consultation-runtime`                                                       | `PBX_WEBHOOK_TOKEN`, `AI_INSIGHTS_TOKEN`, `CALL_ANALYSIS_OPENAI_API_KEY`, `CALL_ANALYSIS_CONCURRENCY`, `AWS_REGION`, `S3_RECORDINGS_BUCKET`, `RECORDING_ALLOWED_HOSTS`, AWS 자격 증명                                      | 직접 생성(선택)                  |
| `msa-ai-business`                                                            | `AI_BUSINESS_TOKEN`                                                                                                                                                                                                        | 직접 생성(선택, AI와 같은 값)    |
| `msa-ai-persona`                                                             | `AI_AGENT_URL`, `AI_PERSONA_TOKEN`, `AI_FAQ_TOKEN`                                                                                                                                                                         | 직접 생성(선택)                  |
| `msa-persona-check`                                                          | `PERSONA_CHECK_URL`, `PERSONA_CHECK_TOKEN`                                                                                                                                                                                 | 직접 생성(선택)                  |
| `msa-customer-auth`, `msa-consultation-auth`, `msa-security-logs`            | 서비스 간 토큰, 보안 로그 HMAC 키                                                                                                                                                                                          | 배포 스크립트가 처음에 자동 생성 |
| `dva-observability/msa-grafana-admin`                                        | `password`                                                                                                                                                                                                                 | 직접 생성(관측을 쓸 때)          |

선택 Secret이 없으면 서비스는 뜨지만 해당 기능이 503을 낸다.

#### 1.2.5 Kick 서버와 Android 앱

Kick 서버 — 예시 `kick/backend/.env.example`. 운영 값은 Jenkins 홈의 `kick-backend/.env`와 `kick-backend/test-accounts.env`.

| 변수                                                   | 용도                                            | 필수                       |
| ------------------------------------------------------ | ----------------------------------------------- | -------------------------- |
| `POSTGRES_PASSWORD`                                    | Kick DB 비밀번호(첫 배포 때 스크립트가 생성)    | 필수                       |
| `KICK_BACKEND_PORT`                                    | 호스트 `127.0.0.1` 포트                         | 기본 3010                  |
| `KICK_TEST_ACCOUNT_1_TOKEN` ~ `_5_TOKEN`               | 테스트 계정 Bearer 토큰(`openssl rand -hex 32`) | 1·2는 첫 배포 때 자동 생성 |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | LiveKit 접속 정보                               | 없으면 통화 입장 503       |
| `ELEVENLABS_API_KEY`                                   | 음성 복제·합성                                  | 없으면 음성 기능 503       |
| `KICK_TTS_FIXED_SETTINGS`                              | `true`면 합성 설정 고정                         | 기본 `false`               |
| `KICK_SIGNUP_CODE`                                     | 팀 테스트용 가입 코드                           | 선택                       |
| `FCM_SERVICE_ACCOUNT_BASE64`                           | 백그라운드 수신 알림용 Firebase 서비스 계정     | 선택                       |

Android 앱:

| 설정                                                                          | 위치                                                                     | 용도                                                                           | 필수                             |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------------------------------- |
| `sdk.dir`                                                                     | `kick/vomi/local.properties` (Git 제외)                                  | Android SDK 경로                                                               | 필수                             |
| `KICK_TEST_ACCOUNT_1_TOKEN`, `KICK_TEST_ACCOUNT_2_TOKEN`                      | 환경 변수 또는 `kick/vomi/android-test.properties`(예시 `.example` 복사) | debug 빌드에 들어가는 테스트 계정 토큰. Kick 서버의 같은 이름 값과 일치해야 함 | 없어도 빌드는 되지만 로그인 불가 |
| `KICK_SIMULATION_URL`, `VOMI_RUN_AUTH_LIVE_TESTS`, `VOMI_RUN_CALL_LIVE_TESTS` | 환경 변수                                                                | 테스트 전용                                                                    | 선택                             |

서버 주소는 환경 변수가 아니라 소스 상수다. `core/network/.../NetworkConfig.kt`의 `BASE_URL`(`https://3.37.162.168/kick/`)과 `API_HOST`를 함께 고쳐 다시 빌드해야 한다.

#### 1.2.6 관측·결제 시연 (선택)

| 파일                                                                            | 변수                                                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/srv/dva-observability/settings` (예시 `infra/observability/settings.example`) | `OBS_DATA_DIR`, `OBS_RUNTIME_DIR`, `APP_PROJECT`, `APP_NETWORK`, `GRAFANA_ROOT_URL`, `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`(24자 이상), `MATTERMOST_WEBHOOK_URL`(비우면 알림 정지) |
| `/srv/dva-payment-test/settings` (예시 `infra/payment-test/settings.example`)   | `MATTERMOST_WEBHOOK_URL`, `PAYMENT_TEST_ENABLED`, `PAYMENT_TEST_PUBLIC_URL`, `TOSS_TEST_CLIENT_KEY`, `TOSS_TEST_SECRET_KEY`, `PAYMENT_TEST_OPERATOR_TOKEN`                                 |

#### 1.2.7 양쪽에 같은 값을 넣어야 하는 토큰

| 값               | 백엔드 변수           | AI 변수                | 그 외                                       |
| ---------------- | --------------------- | ---------------------- | ------------------------------------------- |
| AI 업무 API 토큰 | `AI_BUSINESS_TOKEN`   | `AI_BUSINESS_TOKEN`    |                                             |
| 페르소나 토큰    | `AI_PERSONA_TOKEN`    | `AI_PERSONA_TOKEN`     |                                             |
| 통화 분석 토큰   | `AI_INSIGHTS_TOKEN`   | `AI_INSIGHTS_TOKEN`    |                                             |
| FAQ 알림 토큰    | `AI_FAQ_TOKEN`        | `AI_FAQ_TOKEN`         |                                             |
| PBX 웹훅 토큰    | `PBX_WEBHOOK_TOKEN`   | `PBX_WEBHOOK_SECRET`   | PBX 쪽 설정                                 |
| 시험 창구 토큰   | `PERSONA_CHECK_TOKEN` | —                      | `persona-check.env`의 `PERSONA_CHECK_TOKEN` |
| 리랭커 키        | —                     | `RAG_RERANKER_API_KEY` | GPU VM `runtime.conf`                       |

---

### 1.3 빌드와 배포 절차

#### 1.3.1 새 서버에 올리는 순서

1. 서버 준비: Docker, 디렉터리, 환경 파일 ([1.3.2](#132-서버-공통-준비))
2. 호스트 Nginx와 HTTPS 인증서 ([1.3.3](#133-호스트-nginx와-https))
3. Jenkins ([1.3.7](#137-jenkins))
4. AI 서버 — Docker 네트워크 `dva-prod_ai_net`을 만들고 `ai:8000`을 띄운다 ([1.3.4](#134-ai-상담-서버))
5. 백엔드 — 배포 스크립트가 DB와 AI 상태를 함께 확인하므로 AI가 먼저 떠 있어야 한다 ([1.3.5](#135-백엔드-모놀리식))
6. 관리자 웹 ([1.3.6](#136-관리자-웹fe))
7. 초기 데이터: 최초 관리자, FAQ, 주소 DB, 매뉴얼 색인
8. 외부 연동: OpenAI 웹훅 등록, PBX 라우팅·웹훅 ([2장](#2-외부-서비스))
9. 선택 항목: 관측, 결제 시연, GPU 리랭커, MSA, Kick 서버·Android 앱

#### 1.3.2 서버 공통 준비

- OS: Ubuntu 24.04, linux/amd64
- 설치: Docker와 Compose 플러그인, `bash`, `flock`, `curl`, `sha256sum`, `python3`(3.11 이상), `openssl`
- 접속 계정 `ubuntu`가 비밀번호 없이 `sudo -n docker`를 실행할 수 있어야 한다.
- 방화벽: TCP 22, 80, 443만 연다.

```bash
# 백엔드 배포 루트와 환경 파일
umask 077
mkdir -p ~/dva-deploy/shared ~/dva-deploy/releases
# ~/dva-deploy/shared/.env 를 1.2.2 표대로 작성한 뒤
chmod 600 ~/dva-deploy/shared/.env

# AI 배포 루트
mkdir -p ~/dva-ai/shared/data
```

서버 디렉터리 구조:

```text
/home/ubuntu/dva-deploy/          # 백엔드
├─ shared/.env                    # 운영 설정·비밀 (600)
├─ shared/db-backups/             # 마이그레이션 전 백업
├─ releases/<버전>/               # images.tar, release.env, compose.prod.yaml, deploy.sh, migrations ...
├─ current-release, previous-release, deploy.lock
└─ https/                         # infra/https 사본

/home/ubuntu/dva-ai/              # AI
├─ shared/.env                    # Jenkins 'dva-ai'가 매 배포 덮어씀
├─ shared/persona-check.env       # 선택
├─ shared/faq-runtime.json        # 선택 (FAQ 동기화 스위치)
├─ shared/data/address.db         # 주소 DB (직접 올림)
├─ releases/<버전>/               # deploy.sh, release.env, compose*.yaml, config/, prompts/
└─ current-release, previous-release, deploy.lock

/var/www/dva-releases/<버전>/     # 관리자 웹 판
/var/www/dva -> 현재 판 (심볼릭 링크)
/home/ubuntu/dva-jenkins/         # Jenkins
/srv/dva-observability/, /srv/dva-payment-test/   # 선택
```

#### 1.3.3 호스트 Nginx와 HTTPS

저장소 설정은 `infra/https/`에 있다. IP와 도메인이 설정 파일에 그대로 적혀 있으므로 다른 서버로 옮길 때는 먼저 값을 바꾼다([1.4](#14-배포-특이사항) 5번).

```bash
# infra/https 폴더를 서버 ~/dva-deploy/https 로 복사한 뒤
sudo bash ~/dva-deploy/https/setup-ip-https.sh bootstrap   # nginx·python3-venv·certbot 설치
sudo bash ~/dva-deploy/https/setup-ip-https.sh staging     # 시험 발급
sudo bash ~/dva-deploy/https/setup-ip-https.sh issue       # 실제 발급
```

| 항목        | 값                                                                                                                                                                                                                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 설정 파일   | 저장소 `infra/https/https.conf` → 서버 `/etc/nginx/sites-available/dva-ip`                                                                                                                                                                                                                    |
| 80 포트     | ACME 검증 경로만 응답. HTTPS로 넘기지 않음                                                                                                                                                                                                                                                    |
| 443 포트    | TLS 1.2/1.3, `underscores_in_headers on`, 기본 본문 16k                                                                                                                                                                                                                                       |
| 인증서      | Let's Encrypt **IP 인증서**(유효 약 160시간), `/etc/letsencrypt/live/dva-ip/`                                                                                                                                                                                                                 |
| 갱신        | systemd `dva-certbot-renew.timer`(매시간) → 갱신 후 `/opt/dva-ip-https/reload-nginx.sh`                                                                                                                                                                                                       |
| 주요 경로   | `/api/` → `127.0.0.1:8082`(본문 2m, 읽기 85초, 로그인 분당 30회 제한) · `/api/calls/active-count/stream` 버퍼링 끔 · `/api/webhooks/openai/call-incoming`, `/pbx/webhook/call-ended`, `/monitor` → `127.0.0.1:8000` · `/jenkins/` → `8080` · `/grafana/` → `3001` · `/payment-test/` → `3002` |
| 추가 도메인 | `13-209-59-180.sslip.io`(OpenAI 웹훅 전용, 인증서 `dva-sslip`), `dva-d109.duckdns.org`(관리자 웹, 인증서 `dva-duckdns`)                                                                                                                                                                       |

OpenAI는 IP 주소로는 웹훅을 보내지 않으므로 도메인 주소가 하나 필요하다.

저장소의 `https.conf`는 `/`에 404를 돌려준다. 관리자 웹을 내려면 `frontend/deploy/nginx-admin-web.conf`의 블록을 443 server 블록에 넣는다.

```nginx
root /var/www/dva;
location ^~ /assets/ { expires 30d; add_header Cache-Control "public, immutable"; }
location / { try_files $uri $uri/ /index.html; }
```

압축(`gzip_types text/css application/javascript image/svg+xml application/json; gzip_vary on; gzip_comp_level 5;`)과 보안 헤더 5개는 같은 파일을 참고한다. 수정 후 `sudo nginx -t && sudo systemctl reload nginx`.

호스트 Nginx 설정은 어떤 자동 배포도 바꾸지 않는다. 항상 서버에서 직접 고친다.

#### 1.3.4 AI 상담 서버

**로컬 실행** (`ai/` 디렉터리)

```bash
cp .env.example .env            # 최소: OPENAI_API_KEY, OPENAI_WEBHOOK_SECRET, BACKEND_API_URL,
                                # PBX_WEBHOOK_SECRET, MONITOR_USER, MONITOR_PASSWORD, QDRANT_API_KEY
uv sync
uv run pytest -q
docker compose up -d --build
curl http://127.0.0.1:8000/healthz
```

백엔드 없이 띄울 때는 `BACKEND_MOCK=true`로 둔다(`BACKEND_API_URL`은 그래도 값이 있어야 한다).

**운영 배포** — `ai/Jenkinsfile`

| 항목          | 값                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 에이전트 라벨 | `linux-docker-builder`                                                                                                                                                        |
| 단계          | Checkout → Build Image(`docker build --pull --platform linux/amd64 ai`) → Test(이미지 안에서 `uv sync --frozen && uv run --frozen pytest -q`) → Deploy(`ai/deploy/upload.sh`) |
| Credential    | `dva-lightsail-ssh`(SSH 키), `dva-ai`(Secret file, 운영 `.env`), `dva-persona-check`(Secret file, 선택)                                                                       |
| 릴리스 이름   | `<커밋 12자>-<빌드 번호>`                                                                                                                                                     |
| 트리거        | Jenkinsfile에 없음. Jenkins 작업 설정에서 `develop-ai`, Script Path `ai/Jenkinsfile`로 지정                                                                                   |

`upload.sh`는 이미지를 보내지 않고 소스를 서버로 보내 **서버에서 이미지를 다시 빌드**한다. 그 뒤 서버의 `deploy.sh`가 다음을 한다.

1. Docker 네트워크 `dva-prod_ai_net`이 없으면 만든다.
2. `docker compose --project-name dva-ai --env-file shared/.env --env-file <릴리스>/release.env -f compose.yaml -f compose.deploy.yaml up -d --no-build --wait --wait-timeout 120`
3. 실패하면 직전 릴리스로 자동 복구한다. 이미지는 현재·직전 두 개만 남긴다.
4. `shared/persona-check.env`가 있으면 시험 창구도 띄운다(실패해도 AI 배포 결과는 바뀌지 않는다).

Jenkins 없이 수동으로 배포할 때:

```bash
DEPLOY_HOST=<서버 IP> AI_ENV_FILE=<운영 .env 경로> \
  bash ai/deploy/upload.sh <버전> <SSH 개인 키 파일> ubuntu
```

대상 서버의 호스트 키가 `ai/deploy/known_hosts`에 있어야 한다(호스트 키 검증을 끄지 않는다).

**컨테이너 구성**

| 서비스   | 이미지                  | 포트             | 볼륨                                                                                  |
| -------- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `ai`     | `dva-ai-server:<버전>`  | `127.0.0.1:8000` | `rag_state`, `ai_state`, `ai_logs`, `config`·`prompts`(읽기 전용), 주소 DB(읽기 전용) |
| `qdrant` | `qdrant/qdrant:v1.13.4` | 호스트 노출 없음 | `qdrant_data`                                                                         |

**초기 데이터**

- 주소 DB: 행안부 주소 DB 텍스트를 받아 한 번 빌드한 뒤 서버 `~/dva-ai/shared/data/address.db`로 올린다.
  ```bash
  uv run python -X utf8 -m app.address.gazetteer <주소DB 텍스트 폴더> data/address.db
  ```
  없으면 주소 보정 없이 뜬다.
- 매뉴얼 색인: `uv run python -m scripts.index_markdown` (컬렉션 `manuals_dev_openai_large`, 원문 `ai/manuals/delivery_faq.md`). 운영 Qdrant는 내부 네트워크에만 있어 이 명령을 운영에 적용하는 절차는 저장소에 없다([부록 A](#부록-a-저장소만으로-확인할-수-없는-항목)).
- 관리 FAQ 모드(백엔드 FAQ와 동기화, 기본 꺼짐): 서버 `shared/faq-runtime.json`에 `{"receive_enabled": true, "process_enabled": true}`, `AI_FAQ_TOKEN` 설정 후 `python -m scripts.bootstrap_faq --enqueue`.

**GPU 리랭커 (선택)** — `ai/deploy/gcp/README.md` 순서를 따른다.

`provision.ps1`(VM·방화벽·고정 IP) → `bootstrap.sh`(드라이버·Docker·API 키 생성) → `bundle.py` → VM에 풀기 → `install.sh`(이미지 빌드·모델 다운로드·systemd 등록) → `proxy.sh <IP>.sslip.io`(Caddy HTTPS). 끝나면 AI `.env`의 `RAG_RERANKER_URL`, `RAG_RERANKER_API_KEY`를 채운다.

#### 1.3.5 백엔드 (모놀리식)

**로컬 실행**

```bash
# 방법 1: 저장소 루트에서 Compose (루트 .env 에 DB_USER, DB_PASSWORD, DB_NAME 필요)
docker compose up -d --build --wait
curl http://127.0.0.1:8081/api/health

# 방법 2: Node 직접 실행
cd backend && npm ci
cp .env.example .env.development      # DB 접속 정보와 AI_AGENT_URL 입력
npm run start:dev                      # http://localhost:3000/api/docs
```

애플리케이션은 시작할 때 마이그레이션 001만 적용한다. 002 이후는 `infra/database/migrate.sh`로 따로 적용해야 업무 API가 동작한다.

```bash
sh infra/database/migrate.sh [--no-backup] [DB 컨테이너 이름=dva-prod-db-1] [백업 폴더]
```

검증: `npm run check`(린트·포맷·단위 테스트), `node backend/scripts/check.cjs`(Docker로 통합 테스트와 Nginx 설정까지 검증).

**운영 배포** — 루트 `Jenkinsfile`

| 항목           | 값                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jenkins 작업   | `dva-ci-linux-validation`                                                                                                                                                                                                     |
| 에이전트 라벨  | `linux-docker-builder`                                                                                                                                                                                                        |
| 단계           | Checkout → Verify → Backend checks(`check.cjs`) → Observability checks → Payment demo checks → Build and Package Images(`infra/deploy/package.sh`) → Verify Deployment Access → Deploy to Lightsail(`infra/deploy/upload.sh`) |
| Credential     | `dva-lightsail-ssh`(SSH 키, 사용자 `ubuntu`), `gitlab-dva-readonly`(GitLab 읽기)                                                                                                                                              |
| 자동 배포 조건 | GitLab 프로젝트 `1462697`의 `develop-backend` push이고 변경 경로가 `backend/`, `Jenkinsfile`, `compose*.yaml`, `infra/(deploy\|nginx\|https\|jenkins\|database\|observability\|payment-test)/` 중 하나를 포함할 때            |
| 수동 배포      | 파라미터 `DEPLOY_LIGHTSAIL=true`                                                                                                                                                                                              |
| 웹훅 주소      | `https://<호스트>/jenkins/project/dva-ci-linux-validation` (Generic Webhook Trigger)                                                                                                                                          |

이미지 레지스트리를 쓰지 않는다. 흐름은 다음과 같다.

1. `package.sh <버전>`: 백엔드 이미지를 빌드하고 PostgreSQL·Nginx 이미지와 함께 `.deploy/<버전>/images.tar`로 저장한다. 같은 폴더에 `release.env`, `compose.prod.yaml`, `deploy.sh`, 마이그레이션 SQL, 체크섬을 넣는다.
2. `upload.sh <버전> <SSH 키> ubuntu`: 체크섬과 호스트 키를 확인하고 `releases/<버전>`으로 `scp`한 뒤 서버의 `deploy.sh`를 실행한다.
3. 서버 `deploy.sh`: 이미지 로드 → 환경 변수 사전 검증 → DB 스키마 상태 확인 → 마이그레이션(`migrate.sh`)과 `verify.sql` → `docker compose --project-name dva-prod ... up -d --no-build --pull never --wait --wait-timeout 180` → `/nginx-health`, `/api/health`, 내부 `/health/ready` 확인 → `current-release` 갱신.

Jenkins 없이 수동으로 배포할 때(저장소 루트, Docker 필요):

```bash
bash infra/deploy/package.sh <버전>
bash infra/deploy/upload.sh <버전> <SSH 개인 키 파일> ubuntu
```

버전은 소문자·숫자·`.`·`-`만 쓴다. `upload.sh`의 대상 서버는 스크립트에 고정돼 있다([1.4](#14-배포-특이사항) 5번).

**롤백**

```bash
bash ~/dva-deploy/releases/<현재 버전>/deploy.sh --rollback
```

직전 릴리스의 이미지와 설정을 다시 적용한다. DB는 되돌리지 않는다.

**초기 데이터** (첫 배포 후 한 번)

```bash
# 최초 관리자: DB 접속 환경 변수를 주고 비밀번호를 표준 입력으로 넣는다
npm run build && node scripts/bootstrap-admin.cjs <로그인ID> <이름>

# FAQ 32건 (backend/data/delivery-faq.json)
node dist/faqs/bootstrap-faq.js <관리자 로그인ID>
```

**컨테이너 구성** (`compose.prod.yaml`, 프로젝트 `dva-prod`)

| 서비스    | 이미지                | 포트                    | 네트워크                                              |
| --------- | --------------------- | ----------------------- | ----------------------------------------------------- |
| `db`      | `postgres:17-alpine`  | 호스트 노출 없음        | `db_net`(internal)                                    |
| `backend` | `dva-backend:<버전>`  | 3000 (호스트 노출 없음) | `web_net`, `ai_net`(외부 `dva-prod_ai_net`), `db_net` |
| `nginx`   | `nginx:stable-alpine` | `127.0.0.1:8082`        | `web_net`                                             |

볼륨 `postgres_data`에 DB 데이터가 있다.

#### 1.3.6 관리자 웹(FE)

**로컬 실행** (`frontend/` 디렉터리)

```bash
npm ci
npm run dev                 # http://localhost:5173, /api 는 DEV_PROXY_TARGET 으로 넘어감
npm run lint
TZ=Asia/Seoul npm test      # 테스트는 한국 시간 전제
npm run build               # 타입 검사 포함, 산출물 frontend/dist/
```

**운영 배포** — `frontend/Jenkinsfile`

| 항목          | 값                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jenkins 작업  | `dva-fe` — Script Console에서 `frontend/deploy/jenkins-fe-job.groovy`를 한 번 실행해 만든다                                                                                |
| 에이전트 라벨 | `linux-docker-builder`                                                                                                                                                     |
| 트리거        | 2분마다 pollSCM. GitLab 웹훅 없음                                                                                                                                          |
| 단계          | Checkout → Install(`npm ci`) → Lint → Test → Build(`npm run build`, `dist/mockServiceWorker.js` 삭제, tgz 묶기) → Deploy(`deploy/ci-deploy.sh`) → Smoke(새 번들 이름 확인) |
| Credential    | `dva-lightsail-ssh`, `gitlab-dva-readonly`                                                                                                                                 |

> `jenkins-fe-job.groovy`의 브랜치는 `*/develop-fe`다. 이 브랜치는 원격에서 삭제됐으므로 작업의 Branch Specifier를 FE 소스가 있는 브랜치(현재 `*/develop`)로 바꿔야 한다.

배포는 `dist`를 tgz로 묶어 서버로 보내고, 서버의 `release.sh`가 `/var/www/dva-releases/<버전>`에 푼 뒤 `/var/www/dva` 링크를 바꾼다. 최근 5개 판을 보관한다.

```bash
# 수동 배포 (Git Bash, Node 24)
cd frontend && npm ci
bash deploy/deploy.sh <SSH 개인 키 파일>

# 직전 판으로 되돌리기
ssh -i <SSH 개인 키 파일> ubuntu@<서버> 'sudo bash -s -- --rollback' < frontend/deploy/release.sh
```

화면 주소가 백엔드 `CORS_ORIGINS`에 들어 있어야 로그인된다.

#### 1.3.7 Jenkins

`infra/jenkins/` 구성(Compose 프로젝트 `dva-jenkins`, 설치 경로 `/home/ubuntu/dva-jenkins`):

| 서비스     | 이미지                                                                                                 | 비고                                     |
| ---------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| controller | `jenkins/jenkins:2.580.1-jdk21`                                                                        | `127.0.0.1:8080`, 경로 접두사 `/jenkins` |
| docker     | `docker:29-dind`                                                                                       | 빌드 전용 Docker                         |
| agent      | `dva-jenkins-agent:linux-20261025` (`agent.Dockerfile`: inbound-agent jdk21 + Node 24 + Docker 29 CLI) | 노드 이름·라벨 `linux-docker-builder`    |

`install.sh`와 `bootstrap.groovy`는 기존 Jenkins 백업을 옮겨 오는 용도다. 백업이 없는 새 환경에서는 그대로 쓸 수 없으므로 다음을 직접 구성한다.

- 노드: 이름·라벨 `linux-docker-builder`(Docker, Node 24, bash, git, ssh 사용 가능)
- 플러그인: Pipeline, Git, Credentials Binding, SSH Credentials, Generic Webhook Trigger (MSA까지 쓰면 Lockable Resources, Timestamper)
- Credential과 작업:

| Credential ID         | 종류                                     | 쓰는 작업      |
| --------------------- | ---------------------------------------- | -------------- |
| `dva-lightsail-ssh`   | SSH Username with private key (`ubuntu`) | 백엔드, FE, AI |
| `gitlab-dva-readonly` | GitLab 읽기                              | 백엔드, FE     |
| `dva-ai`              | Secret file (AI 운영 `.env`)             | AI             |
| `dva-persona-check`   | Secret file (선택)                       | AI             |
| `dva-msa-ssh`         | SSH private key                          | MSA            |
| `gitlab-ssafy`        | GitLab 읽기                              | Kick           |

| 작업                                   | 브랜치            | Script Path                |
| -------------------------------------- | ----------------- | -------------------------- |
| `dva-ci-linux-validation`              | `develop-backend` | `Jenkinsfile`              |
| `dva-fe`                               | FE 소스 브랜치    | `frontend/Jenkinsfile`     |
| (AI 작업, 이름은 저장소에서 확인 불가) | `develop-ai`      | `ai/Jenkinsfile`           |
| `dva-msa`                              | `develop-backend` | `msa/Jenkinsfile`          |
| `kick-backend`                         | Kick 배포 브랜치  | `kick/backend/Jenkinsfile` |

#### 1.3.8 MSA (선택)

`msa/README.md`가 기준 문서다.

- 사전 준비(서버): k3s 단일 노드(amd64), 네임스페이스 `dva`, PostgreSQL과 데이터베이스 5개, Secret `<서비스>-db` 5개. `ubuntu` 계정이 `sudo -n k3s kubectl`, `ctr`, `crictl`을 쓸 수 있어야 한다.
- Jenkins: 작업 `dva-msa`, 에이전트 라벨 `msa-builder`(docker, node, python3, git, bash, ssh, scp, sha256sum), credential `dva-msa-ssh`, lock `dva-msa-database-deploy`.
- 이미지 빌드(저장소 루트에서, context는 반드시 `msa`):
  ```bash
  docker build -t dva-<서비스>:local -f msa/services/<서비스>/Dockerfile msa
  ```
  빌드 중에 린트와 테스트가 함께 돈다.
- 배포: 레지스트리 없이 `docker save` → `scp` → `k3s ctr images import`. DB는 Liquibase 일회성 Job으로 적용한다. 순서는 DB → operations → customer → consultation → delivery → order.
- 서버 경로: `/home/ubuntu/msa-deploy/{releases,apps,backups}`.
- 초기 데이터: `node scripts/bootstrap-admin.cjs <로그인ID> <이름>`, `node dist/faqs/bootstrap-faq.js <관리자ID>` (operations 서비스).
- 관측: `kubectl apply -k msa/observability` (수동).

#### 1.3.9 Kick 서버와 Android 앱 (선택)

**Kick 서버** (`kick/backend/`)

```bash
cp .env.example .env        # POSTGRES_PASSWORD, 테스트 계정 토큰 입력
docker compose up --build -d --wait
curl -f http://127.0.0.1:3010/health
```

- 마이그레이션(`migrations/001~006`)과 테스트 계정은 앱이 시작할 때 적용한다.
- 운영: Jenkins 작업 `kick-backend`(5분마다 pollSCM, 에이전트 `built-in`), 파라미터 `DEPLOY_KICK=true`로 배포. 환경 파일은 Jenkins 홈 `kick-backend/.env`, `kick-backend/test-accounts.env`.
- 호스트 Nginx의 HTTPS server 블록에 `kick/backend/deploy/nginx-kick.conf`를 include하면 `https://<서버>/kick/api/…`로 열린다.

**Android 앱** (`kick/vomi/`, Windows PowerShell 기준)

```powershell
# local.properties 에 sdk.dir 작성, android-test.properties.example 을 android-test.properties 로 복사해 토큰 입력
.\gradlew.bat assembleDebug
.\gradlew.bat :app:lintDebug
```

- 필요한 것: JDK 21, Android SDK Platform 37, 인터넷(Google Maven, Maven Central, JitPack, Gradle 배포판).
- 산출물은 debug APK다. release 빌드는 토큰이 비어 로그인할 수 없고, 서명 설정(keystore)도 저장소에 없다.
- 통화 검증에는 기기 2대와 계정 2개가 필요하다. 자막은 Android 13(API 33) 이상, 답변 추천은 AICore(Gemini Nano) 지원 기기에서만 동작한다.

---

### 1.4 배포 특이사항

1. **배포 순서 의존**: 백엔드 `compose.prod.yaml`은 Docker 네트워크 `dva-prod_ai_net`을 외부 네트워크로 참조한다. 이 네트워크는 AI의 `deploy.sh`가 만든다. 백엔드 `deploy.sh`는 `/health/ready`(DB와 AI 확인)를 검사하므로 AI가 없으면 배포가 실패 처리된다.
2. **AI는 호스트 `127.0.0.1:8000`에도 열려 있어야 한다**: 호스트 Nginx가 OpenAI 웹훅, PBX 웹훅 mirror, `/monitor`를 그 주소로 보낸다.
3. **AI는 프로세스 하나만 띄운다**: 통화 상태와 웹훅 중복 제거가 프로세스 메모리에 있다(Uvicorn 워커 1개, 인스턴스 1개). 배포하면 진행 중인 통화가 끊긴다.
4. **프록시 홉 수**: 운영은 호스트 Nginx와 컨테이너 Nginx 두 단계라 `AUTH_PROXY_HOPS=2`다. 프록시 구조를 바꾸면 이 값도 맞춘다.
5. **서버 주소가 파일에 고정돼 있다**. 다른 서버로 옮기려면 아래를 모두 바꾼다.

   | 대상                                     | 파일                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
   | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | 주 서버 IP `13.209.59.180`               | `infra/deploy/upload.sh`, `infra/deploy/upload.ps1`, `infra/https/http.conf`, `infra/https/https.conf`, `infra/https/setup-ip-https.sh`, `infra/https/check-api-routing.sh`, `infra/jenkins/bootstrap.groovy`, `infra/observability/settings.example`, `infra/payment-test/settings.example`, `infra/payment-test/configure.mjs`, `frontend/Jenkinsfile`, `frontend/deploy/ci-deploy.sh`, `frontend/deploy/deploy.sh`, `frontend/.env.development`, `frontend/.env.example`, `frontend/scripts/sync-backend-dto.mjs`, `ai/Jenkinsfile` |
   | SSH 호스트 키                            | `infra/deploy/known_hosts`, `frontend/deploy/known_hosts`, `ai/deploy/known_hosts`, `msa/deploy/known_hosts`                                                                                                                                                                                                                                                                                                                                                                                                                           |
   | GitLab 프로젝트 ID `1462697`·저장소 주소 | `infra/deploy/should-deploy.sh`, `infra/jenkins/configure-monolith-trigger.groovy`, `infra/jenkins/configure-jobs.groovy`, `frontend/deploy/jenkins-fe-job.groovy`                                                                                                                                                                                                                                                                                                                                                                     |
   | MSA 호스트 `k15d109.p.ssafy.io`          | `msa/deploy/ssh-common.sh`, `msa/services/*/k8s.yaml`(Ingress host, CORS)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
   | Kick 주소 `3.37.162.168`                 | `kick/vomi/core/network/.../NetworkConfig.kt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
   | 녹취 S3 버킷 이름                        | `frontend/deploy/nginx-admin-web.conf`(CSP)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
   | 서버 경로 `/home/ubuntu/...`             | 각 배포 스크립트                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

6. **호스트 Nginx는 자동 배포 대상이 아니다**: 저장소 `infra/https/https.conf`와 서버 파일을 비교해 직접 반영하고 `nginx -t` 후 reload한다.
7. **환경 변수 변경은 컨테이너를 다시 만들어야 반영된다**: `docker restart`로는 안 된다. 백엔드는 현재 릴리스의 `deploy.sh`를 다시 실행하고, AI는 Jenkins credential `dva-ai`를 고친 뒤 다시 배포한다.
8. **DB 비밀번호**: PostgreSQL 볼륨이 한 번 만들어진 뒤에는 `.env`만 바꿔도 DB 계정 비밀번호가 바뀌지 않는다.
9. **마이그레이션 파일은 수정하지 않는다**: 적용된 파일의 체크섬을 원장(`db_migrations.applied_versions`)에 저장한다. Windows에서 줄바꿈이 바뀌어도 체크섬이 달라져 배포가 멈춘다(`.gitattributes`를 지킨다).
10. **롤백 제한**: 테이블을 없애는 마이그레이션(008, 010, 019, 021, 042, 043, 045, 047, 053, 054, 055, 064, 065)이 적용된 뒤에는 그 이전 버전으로 돌아갈 수 없다. DB 자동 복원은 없다.
11. **금지 명령**: `docker compose down -v`, 전체 `prune`, `--remove-orphans`(백엔드 스택). DB·RAG 상태 볼륨이 지워진다.
12. **운영 빌드의 통계 페이지는 목데이터다**: `frontend/src/features/stats/api/dashboardApi.ts`의 `STATS_DEMO = import.meta.env.PROD`. 실데이터로 바꾸려면 코드를 고쳐 다시 빌드한다.
13. **AI 요청 헤더에 밑줄이 있다**(`call_session_seq`): AI와 백엔드 사이에 Nginx를 두면 `underscores_in_headers on`이 필요하다.
14. **웹훅 서명**: OpenAI 웹훅은 원문 바이트로 서명을 검증한다. 프록시가 본문을 바꾸면 400이 된다.
15. **결제 설정 제약**: `PAYMENT_PUBLIC_URL`은 경로가 정확히 `/api/payments`여야 하고, 결제위젯 키는 테스트 키만 통과한다. 규칙에 맞지 않으면 백엔드가 뜨지 않는다.
16. **GPU 리랭커는 켠 뒤 30분이 지나면 자동으로 꺼진다**: 요청이 VM을 깨우지 않는다. 꺼져 있으면 매뉴얼 검색만 실패한다. VM을 새로 만들면 주소와 키가 바뀌므로 `dva-ai` credential도 고친다.
17. **AI 이미지에 포함되는 것과 마운트되는 것**: `policy/`, `manuals/`는 이미지에 들어가므로 수정하면 다시 빌드한다. `config/`, `prompts/`는 릴리스 폴더에서 읽기 전용으로 마운트한다.
18. **루트 `compose.yaml`(develop-ai 브랜치)로는 현재 AI가 뜨지 않는다**: 초기 골격이라 AI 환경 변수가 없다. AI는 `ai/compose.yaml`로 띄운다.
19. **MSA 운영 설정이 Swagger를 켠다**: 배포 검사가 `/<서비스>/docs-json` 200을 요구한다. 끄면 배포 검사가 실패한다.
20. **관측 스택**: 여유 공간 25GiB 이상과 네트워크 `dva-prod_web_net`이 먼저 있어야 한다.
21. **Android 앱은 IP 주소로 HTTPS를 호출한다**: 서버 인증서가 기기에서 신뢰되고 그 IP에 유효해야 한다.

---

### 1.5 주요 계정과 프로퍼티가 정의된 파일 목록

#### 저장소 안 (값은 없고 이름·구조만 있음)

| 영역    | 파일                                                                                                                                                                | 내용                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| BE      | `backend/.env.example`                                                                                                                                              | 백엔드 환경 변수 예시                           |
| BE      | `compose.yaml`, `compose.prod.yaml`                                                                                                                                 | DB 계정·토큰·외부 키 주입 정의                  |
| BE      | `backend/src/config/environment.ts`, `backend/src/config/application-config.module.ts`                                                                              | 환경 변수 검증·로딩 규칙                        |
| BE      | `backend/src/payments/payment-config.ts`                                                                                                                            | 결제 변수 검증                                  |
| BE      | `backend/src/database/database.service.ts`                                                                                                                          | DB 연결 설정                                    |
| BE      | `backend/scripts/bootstrap-admin.cjs`, `backend/src/faqs/bootstrap-faq.ts`                                                                                          | 최초 관리자·FAQ 생성                            |
| BE      | `backend/migrations/*.sql`, `infra/database/migrate.sh`, `infra/database/verify.sql`                                                                                | 스키마 원본과 적용·검증                         |
| BE      | `docs/database/monolith.dbml`, `docs/database/README.md`                                                                                                            | ERD(DBML)와 DB 운영 문서                        |
| 인프라  | `Jenkinsfile`, `infra/deploy/{package,upload,deploy,should-deploy}.sh`, `infra/deploy/known_hosts`                                                                  | 배포 대상·credential ID·호스트 키               |
| 인프라  | `infra/https/{http,https}.conf`, `infra/https/setup-ip-https.sh`, `infra/nginx/default.prod.conf`                                                                   | 웹서버·인증서 설정                              |
| 인프라  | `infra/jenkins/compose.yaml`, `agent.Dockerfile`, `bootstrap.groovy`, `configure-jobs.groovy`, `configure-monolith-trigger.groovy`                                  | Jenkins 구성                                    |
| 인프라  | `infra/observability/settings.example`, `infra/payment-test/settings.example`                                                                                       | 관측·결제 시연 설정 예시                        |
| MSA     | `msa/services/*/k8s.yaml`, `msa/services/*/src/config/environment.ts`, `msa/services/delivery/src/environment.ts`                                                   | Secret 참조와 환경 변수 규칙                    |
| MSA     | `msa/liquibase/changelog/*/db.changelog.xml`, `msa/liquibase/run-service.sh`                                                                                        | 서비스별 스키마와 DB 접속 조립                  |
| MSA     | `msa/Jenkinsfile`, `msa/deploy/ssh-common.sh`, `msa/deploy/app-release.py`, `msa/deploy/known_hosts`                                                                | 서버·경로·자동 생성 Secret 이름                 |
| FE      | `frontend/.env.example`, `frontend/.env.development`, `frontend/vite.config.ts`                                                                                     | 화면 환경 변수와 개발 프록시                    |
| FE      | `frontend/Jenkinsfile`, `frontend/deploy/*`                                                                                                                         | 배포 스크립트·Jenkins 작업 정의·Nginx 블록 사본 |
| AI      | `ai/.env.example`                                                                                                                                                   | AI 환경 변수 예시                               |
| AI      | `ai/config/server.toml`, `ai/app/config.py`                                                                                                                         | 운영 수치와 설정 규칙                           |
| AI      | `ai/compose.yaml`, `ai/deploy/compose.deploy.yaml`, `ai/deploy/compose.persona-check.yaml`                                                                          | 컨테이너·볼륨·네트워크                          |
| AI      | `ai/Jenkinsfile`, `ai/deploy/{upload,deploy}.sh`, `ai/deploy/known_hosts`                                                                                           | 배포 대상·credential ID                         |
| AI      | `ai/deploy/gcp/README.md`, `ai/deploy/gcp/provision.ps1`                                                                                                            | GCP 프로젝트·VM 설정                            |
| AI      | `ai/policy/*`, `ai/prompts/*`                                                                                                                                       | 업무 규칙·프롬프트                              |
| Kick    | `kick/backend/.env.example`, `kick/backend/compose.yaml`, `kick/backend/scripts/deploy.sh`                                                                          | Kick 서버 설정                                  |
| Android | `kick/vomi/android-test.properties.example`, `kick/vomi/gradle/libs.versions.toml`, `kick/vomi/app/build.gradle.kts`, `kick/vomi/core/network/.../NetworkConfig.kt` | 토큰 주입·버전·서버 주소                        |

#### 저장소 밖 (직접 만들어야 함, Git에 올리지 않음)

| 위치      | 파일                                                                                                                                                             | 내용                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 주 서버   | `/home/ubuntu/dva-deploy/shared/.env`                                                                                                                            | 백엔드 DB 계정과 모든 토큰·키                      |
| 주 서버   | `/home/ubuntu/dva-ai/shared/.env`, `shared/persona-check.env`, `shared/faq-runtime.json`                                                                         | AI·시험 창구 설정                                  |
| 주 서버   | `/etc/nginx/sites-available/dva-ip`, `/etc/letsencrypt/live/{dva-ip,dva-sslip,dva-duckdns}/`                                                                     | 호스트 Nginx 설정과 인증서                         |
| 주 서버   | `/srv/dva-observability/settings`, `/srv/dva-payment-test/settings`                                                                                              | 관측·결제 시연 설정                                |
| 주 서버   | `/home/ubuntu/dva-jenkins/home/`                                                                                                                                 | Jenkins credential 저장소                          |
| Jenkins   | credential `dva-lightsail-ssh`, `gitlab-dva-readonly`, `dva-ai`, `dva-persona-check`, `dva-msa-ssh`, `gitlab-ssafy`, 웹훅 Secret token                           |                                                    |
| MSA 서버  | 네임스페이스 `dva`의 Secret([1.2.4](#124-백엔드-msa))                                                                                                            | DB 접속·토큰                                       |
| 보조 서버 | Jenkins 홈 `kick-backend/.env`, `kick-backend/test-accounts.env`                                                                                                 | Kick DB 비밀번호·테스트 토큰·LiveKit·ElevenLabs 키 |
| GPU VM    | `/etc/dvr-reranker/runtime.conf`, `/etc/dvr-reranker/Caddyfile`                                                                                                  | 리랭커 키·HTTPS 설정                               |
| 개발 PC   | `backend/.env.development`, `ai/.env`, `frontend/.env.development.local`, `kick/vomi/local.properties`, `kick/vomi/android-test.properties`, SSH 개인 키(`.pem`) |                                                    |

---

## 2. 외부 서비스

| 서비스                       | 쓰는 곳              | 용도                                                   | 필요한 값(변수)                                                                                                                                          | 준비할 것                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **OpenAI API**               | AI                   | 전화 음성 세션(SIP), 위임·판정, 임베딩                 | `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET`, `OPENAI_PROJECT_ID`                                                                                           | 프로젝트 생성 후 API 키 발급. 프로젝트 웹훅에 `https://<도메인>/api/webhooks/openai/call-incoming` 등록(이벤트 `live.transport.incoming`), 서명 비밀을 `OPENAI_WEBHOOK_SECRET`에 저장. SIP 수신 기능 활성화. 웹훅 주소는 IP가 아니라 도메인이어야 한다 |
| OpenAI API (전용 키)         | 백엔드, 시험 창구    | 통화 불만 판정, 시나리오 시험                          | `CALL_ANALYSIS_OPENAI_API_KEY`, `PERSONA_CHECK_OPENAI_API_KEY`                                                                                           | 운영 키와 한도·청구를 나누려고 별도 키를 쓴다                                                                                                                                                                                                          |
| **디버 IP-PBX**              | AI, 백엔드           | 전화를 SIP 트렁크로 OpenAI에 전달, 통화 종료·녹취 웹훅 | `PBX_WEBHOOK_TOKEN`(백엔드), `PBX_WEBHOOK_SECRET`(AI)                                                                                                    | PBX 쪽에 SIP 대상 `sip:<프로젝트 ID>@sip.api.openai.com;transport=tls`, 웹훅 주소 `https://<서버>/api/webhooks/pbx/call-ended`, Bearer 토큰 전달. 규격 문서 `infra/webhooks/PBX-CALL-ENDED.md`, `ai/docs/be-contract/ai/pbx-sip.md`                    |
| **디버 접수 API**            | 백엔드               | 완성된 주문을 택배 접수                                | `DVER_API_URL`, `DVER_API_KEY`                                                                                                                           | 디버에서 주소와 키를 받는다                                                                                                                                                                                                                            |
| **토스페이먼츠**             | 백엔드               | 결제위젯 카드 결제, 자동결제(빌링)                     | `TOSS_TEST_CLIENT_KEY`, `TOSS_TEST_SECRET_KEY`, `TOSS_BILLING_SECRET_KEY`, `PAYMENT_CARD_ENCRYPTION_KEY`, `PAYMENT_PUBLIC_URL`, `ORDER_PAYMENTS_ENABLED` | 개발자센터에서 테스트 키 발급. 결제위젯은 `test_gck_`/`test_gsk_` 키만 허용. 자동결제는 빌링 계약 상점의 키가 필요. 문서 `docs/api/order-payment-integration.md`                                                                                       |
| **AWS S3**                   | 백엔드               | 통화 녹취 저장, 재생용 서명 주소                       | `AWS_REGION`, `S3_RECORDINGS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                       | 비공개 버킷과 IAM 사용자·정책 생성. 문서 `docs/api/recording-s3-setup.md`                                                                                                                                                                              |
| **AWS Lightsail**            | 전체                 | 주 서버·보조 서버                                      | SSH 키(Jenkins `dva-lightsail-ssh`)                                                                                                                      | 인스턴스 생성, 고정 IP, 방화벽 80·443·22                                                                                                                                                                                                               |
| **카카오 로컬 API**          | AI                   | 도로명 → 지번·우편번호, 상호 검색                      | `KAKAO_REST_API_KEY`                                                                                                                                     | 카카오 개발자 콘솔에서 앱 등록 후 REST API 키 발급                                                                                                                                                                                                     |
| 카카오(다음) 우편번호        | 관리자 웹            | 주소 검색 창                                           | 키 없음                                                                                                                                                  | `react-daum-postcode` 사용                                                                                                                                                                                                                             |
| **행정안전부 주소 DB**       | AI                   | 주소 보정용 로컬 DB                                    | 키 없음                                                                                                                                                  | 주소 DB 텍스트를 내려받아 `app.address.gazetteer`로 `address.db` 빌드                                                                                                                                                                                  |
| **GCP Compute Engine**       | AI                   | 리랭커 GPU VM                                          | gcloud 로그인, `RAG_RERANKER_URL`, `RAG_RERANKER_API_KEY`                                                                                                | 결제 계정 연결, GPU(L4) 할당량, gcloud CLI. 문서 `ai/deploy/gcp/README.md`                                                                                                                                                                             |
| Hugging Face Hub             | GPU VM               | 리랭커 모델 다운로드                                   | 토큰 없음(공개 모델)                                                                                                                                     | `Qwen/Qwen3-Reranker-0.6B`                                                                                                                                                                                                                             |
| **Let's Encrypt**            | 주 서버, GPU VM, MSA | HTTPS 인증서                                           | (`ACME_EMAIL` 선택)                                                                                                                                      | 주 서버는 Certbot, GPU VM은 Caddy, MSA는 Traefik이 발급                                                                                                                                                                                                |
| DuckDNS                      | 주 서버              | 관리자 웹 도메인 `dva-d109.duckdns.org`                | DuckDNS 계정                                                                                                                                             | 도메인을 서버 IP에 연결                                                                                                                                                                                                                                |
| sslip.io                     | 주 서버, GPU VM      | IP 기반 도메인(`<IP>.sslip.io`)                        | 가입 없음                                                                                                                                                |                                                                                                                                                                                                                                                        |
| **Mattermost**               | 백엔드, 관측         | 결제 안내 메시지, 장애 알림                            | `PAYMENT_MATTERMOST_WEBHOOK_URL`, 관측 `MATTERMOST_WEBHOOK_URL`                                                                                          | 채널별 Incoming Webhook 생성                                                                                                                                                                                                                           |
| jsDelivr CDN                 | 관리자 웹            | Pretendard 웹폰트 1.3.9                                | 키 없음                                                                                                                                                  |                                                                                                                                                                                                                                                        |
| **GitLab (lab.ssafy.com)**   | CI                   | 소스, 웹훅                                             | Jenkins `gitlab-dva-readonly`, `gitlab-ssafy`, 웹훅 Secret token                                                                                         | 읽기 토큰 발급, 프로젝트 웹훅 등록                                                                                                                                                                                                                     |
| **LiveKit**                  | Kick 서버, Android   | 앱 간 음성 통화 방                                     | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`                                                                                                   | LiveKit Cloud 프로젝트 생성 후 키 발급. 앱은 서버가 준 주소와 토큰만 쓴다                                                                                                                                                                              |
| **ElevenLabs**               | Kick 서버            | 목소리 복제, 음성 합성                                 | `ELEVENLABS_API_KEY`                                                                                                                                     | Starter 이상 요금제, API 키에 Voices·Text to Speech 권한. 문서 `kick/backend/README.md`                                                                                                                                                                |
| Firebase Cloud Messaging     | Kick 서버            | 백그라운드 수신 알림(선택)                             | `FCM_SERVICE_ACCOUNT_BASE64`                                                                                                                             | 서비스 계정 JSON을 base64로 저장. 앱 쪽 연결은 아직 없다                                                                                                                                                                                               |
| Google ML Kit GenAI / AICore | Android              | 온디바이스 답변 추천(Gemini Nano)                      | 키 없음                                                                                                                                                  | 지원 기기에서 모델을 내려받는다                                                                                                                                                                                                                        |

소셜 로그인, 지도 SDK, 분석 도구는 쓰지 않는다. 관리자 로그인은 백엔드의 자체 계정과 세션 쿠키(`dva_session`)다.

---

## 3. DB 덤프 파일 최신본

**저장소에는 DB 덤프 파일이 없다.** 제출용 덤프는 운영 서버에서 아래 명령으로 만들어 이 폴더(`exec/`)에 넣는다. 덤프에는 고객·주문·통화 데이터가 들어가므로 공개 저장소에 올리지 않도록 주의한다.

### 3.1 덤프 대상

| DB          | 위치                                                             | 내용                                                                         |
| ----------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 모놀리식 DB | 주 서버 컨테이너 `dva-prod-db-1` (볼륨 `dva-prod_postgres_data`) | 업무 테이블 31개(`public`), `pbx_webhooks`, `db_migrations`                  |
| MSA DB 5개  | MSA 서버 k3s `dva` 네임스페이스의 `deployment/postgres`          | `customer_db`, `order_db`, `delivery_db`, `consultation_db`, `operations_db` |
| Kick DB     | 보조 서버 Compose 프로젝트 `kick-backend`의 `db`                 | `kick`                                                                       |
| Qdrant      | 주 서버 볼륨 `dva-ai_qdrant_data`                                | 매뉴얼·FAQ 벡터. 원문에서 다시 색인할 수 있어 덤프 대상이 아니다             |

### 3.2 덤프 만들기

```bash
# 모놀리식 (주 서버)
sudo docker exec dva-prod-db-1 sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > dva_monolith_$(date +%Y%m%d).dump
sha256sum dva_monolith_*.dump > dva_monolith.sha256

# Kick (보조 서버)
sudo docker exec kick-backend-db-1 pg_dump -U kick -d kick -Fc > kick_$(date +%Y%m%d).dump

# MSA (MSA 서버, DB마다 반복. <계정>은 Secret <서비스>-db 의 PGUSER)
sudo k3s kubectl -n dva exec deploy/postgres -- pg_dump -U <계정> -d customer_db -Fc > customer_db.dump
```

`migrate.sh`를 백업 모드(`--no-backup` 없이)로 실행해도 같은 형식의 덤프가 `~/dva-deploy/shared/db-backups/`에 생긴다.

### 3.3 덤프로 복원하기

```bash
# 빈 DB에 복원 (모놀리식)
sudo docker exec -i dva-prod-db-1 sh -c \
  'exec pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < dva_monolith_YYYYMMDD.dump
```

덤프에는 마이그레이션 원장(`db_migrations.applied_versions`)이 들어 있으므로, 복원한 뒤 배포하면 이미 적용된 SQL은 건너뛴다.

### 3.4 덤프 없이 빈 DB에서 시작하기

1. 백엔드를 배포한다(`deploy.sh`가 DB를 띄우고 `backend/migrations/001~067`을 적용한 뒤 `verify.sql`로 확인한다).
2. `bootstrap-admin.cjs`로 최초 관리자를 만든다.
3. `bootstrap-faq.js`로 FAQ 32건을 넣는다.

스키마 원본은 `backend/migrations/`, ERD는 `docs/database/monolith.dbml`이다. MSA는 `msa/liquibase/changelog/`가 스키마 원본이다.

---

## 부록 A. 저장소만으로 확인할 수 없는 항목

제출 전에 담당자가 채우거나 서버에서 확인해야 한다.

| 항목                                                                                                      | 상태                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 사용한 IDE와 버전                                                                                         | 저장소에 흔적 없음. [1.1.7](#117-ide)에 기입 필요                                                                                |
| 운영 `.env`의 실제 값과 켜져 있는 기능(결제, S3 버킷명, Swagger, CORS 주소 등)                            | 서버·Jenkins에만 있음                                                                                                            |
| 서버의 실제 호스트 Nginx 설정(`/etc/nginx/sites-available/dva-ip`, `/etc/nginx/snippets/dva-routes.conf`) | 저장소 `infra/https/https.conf`와 다르다(관리자 웹 블록, 도메인용 server 블록, `http2`). 서버 파일을 함께 제출하는 것이 안전하다 |
| `dva-sslip`, `dva-duckdns` 인증서 발급 명령                                                               | 스크립트는 IP 인증서 `dva-ip`만 다룬다                                                                                           |
| Jenkins 플러그인 목록·버전, AI 작업 이름과 트리거, `msa-builder` 노드 구성                                | Jenkins 설정에만 있음                                                                                                            |
| 운영 Qdrant에 매뉴얼을 처음 색인하는 절차                                                                 | Qdrant가 내부 네트워크에만 있고 색인 스크립트가 이미지에 없다                                                                    |
| 운영 DB에 `bootstrap-admin.cjs`를 실행하는 접속 경로                                                      | 운영 이미지에 스크립트가 없고 DB에 호스트 포트가 없다                                                                            |
| 행안부 주소 DB 다운로드 출처, 카카오 앱 등록 절차                                                         | 문서 없음                                                                                                                        |
| PBX 제품·설정 화면, OpenAI 콘솔의 SIP 설정 세부                                                           | 요건만 문서에 있음                                                                                                               |
| MSA 서버의 PostgreSQL·Traefik 설치 매니페스트, DB·계정·Secret 생성 절차                                   | 파이프라인 범위 밖                                                                                                               |
| 보조 서버(`3.37.162.168`) 사양, Kick 서버의 LiveKit이 Cloud인지 자체 호스팅인지                           | 문서에 Cloud 언급만 있음                                                                                                         |
| Android release 서명·배포 채널                                                                            | 저장소에 keystore·서명 설정 없음                                                                                                 |
| Docker·Compose 최소 버전                                                                                  | 실측 기록만 있음                                                                                                                 |
| DB 덤프 파일                                                                                              | 저장소에 없음. [3.2](#32-덤프-만들기)로 생성 필요                                                                                |

---

## 4. 시연 시나리오

관리자 웹에서 택배 접수가 어떻게 관리되는지 보여 주는 순서다.

### 4.1 사전 준비

- 접속 주소: `https://dva-d109.duckdns.org/`
- 관리자 계정으로 로그인한다.
- 시연 전에 AI 상담가와 통화를 한 건 이상 끝내 둔다. 통화 내역과 상세 화면에 보여 줄 기록이 필요하다.
- 통화 중에 FAQ에 없는 질문을 한 번 해 둔다. 미답변 문의 화면에 그 질문이 기록돼 있어야 한다.

### 4.2 시연 순서

| 순서 | 화면 (메뉴 · 경로)               | 보여 줄 것                                                                                        | 설명                                                                                                 |
| ---- | -------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1    | 통화 · `/calls`                  | AI 상담가의 통화 목록                                                                             | 이곳에서 AI 상담가의 통화 내역을 확인할 수 있다                                                      |
| 2    | 통화 상세 · `/calls/<통화 번호>` | 목록에서 통화 한 건을 열어 대화 내용과 AI 상담가의 행동 기록을 보여 준다                          | 상세 페이지에서는 실제 대화 내용뿐만 아니라 AI 상담가가 어떤 행동을 수행했는지도 함께 확인할 수 있다 |
| 3    | FAQ · `/faqs`                    | 등록된 FAQ 목록                                                                                   | AI 상담가는 사전에 등록된 FAQ를 기반으로 고객의 질문에 답변한다                                      |
| 4    | 미답변 문의 · `/unanswered`      | 통화 중 답하지 못한 질문 목록                                                                     | 등록되지 않은 질문이 들어오면 미답변 문의 페이지에 자동으로 기록된다                                 |
| 5    | 미답변 문의 → [FAQ 등록]         | 기록된 질문 줄의 [FAQ 등록]을 눌러 답변을 쓰고 저장한다. 저장하면 FAQ가 생기고 그 질문은 처리된다 | 관리자는 해당 내용을 확인하고 새로운 FAQ를 추가할 수 있다                                            |
| 6    | 통화 상세 · `/calls/<통화 번호>` | 통화 종료 후 후처리 결과(고객이 표현한 불만, AI 상담가의 응대 데이터)                             | 통화 종료 후 녹음 데이터를 후처리해 고객이 직접 표현한 불만이나 AI 상담가의 응대 데이터를 수집한다   |
| 7    | 통계 · `/stats`                  | 수집한 결과의 통계                                                                                | 수집한 결과를 통계로 확인할 수 있다                                                                  |

### 4.3 시연 필요 설정

| 기능                   | 필요한 설정                                                       | 없을 때                                              |
| ---------------------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| 통화 기록·행동 기록    | 백엔드와 AI의 `AI_INSIGHTS_TOKEN`(같은 값)                        | AI가 통화 이벤트·분석을 보내지 않아 상세 화면이 빈다 |
| 미답변 문의 기록       | 위와 같음                                                         | 미답변 문의가 쌓이지 않는다                          |
| 통화 후처리(불만 판정) | 백엔드 `CALL_ANALYSIS_OPENAI_API_KEY`                             | 판정 워커가 꺼진다                                   |
| 녹음                   | 백엔드 `S3_RECORDINGS_BUCKET`, AWS 자격 증명, `PBX_WEBHOOK_TOKEN` | 녹취가 저장되지 않는다                               |

