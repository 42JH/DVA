# Kick 백엔드

NestJS 모놀리스와 PostgreSQL 17을 Docker Compose로 실행합니다. 기본 API 주소는
`http://127.0.0.1:3010/health`입니다. DB 질의가 성공하면 200, DB 연결이 실패하면 503을 반환합니다.

로컬에서 `.env.example`을 `.env`로 복사하고 `POSTGRES_PASSWORD`에 로컬 DB 비밀번호를 넣습니다.

```sh
docker compose up --build -d --wait
curl -f http://127.0.0.1:3010/health
docker compose down
```

PostgreSQL은 Compose 내부 네트워크에서 접근합니다. DB 볼륨은 일반적인 `docker compose down` 후에도
보존됩니다. 로컬 포트가 겹치면 `.env`의 `KICK_BACKEND_PORT`를 바꿉니다.

## 테스트 계정과 통화

앱이 시작될 때 PostgreSQL 마이그레이션을 적용하고 서로 친구인 `kick-test-1`, `kick-test-2`를
한 번 생성합니다. 로컬 `.env`의 `KICK_TEST_ACCOUNT_1_TOKEN`과 `KICK_TEST_ACCOUNT_2_TOKEN`에
각각 `openssl rand -hex 32`로 만든 값을 넣습니다. Lightsail 배포는 Jenkins 홈 아래
`kick-backend/test-accounts.env`에 토큰을 한 번 생성해 재사용합니다.

통화 API는 계정의 토큰을 `Authorization: Bearer <token>`으로 받습니다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/friends` | 내 친구의 `id`, `displayName` 목록 |
| `POST /api/calls` | `{"calleeId":"kick-test-2","requestId":"<클라이언트가 생성한 UUID>"}`를 받아 `REQUESTED` 상태로 저장 |
| `GET /api/calls/active` | `{ "accountId": "kick-test-1", "call": null }` 또는 현재 발신·수신·수락된 통화. 포그라운드에서 주기적으로 조회 |
| `GET /api/calls/events` | 인증된 계정의 현재 통화를 SSE `event: call`로 전송. 연결 직후와 통화 상태가 바뀔 때 전송하며 JSON은 `/calls/active`와 동일 |
| `GET /api/calls/:id` | 두 참가자가 통화 상태를 조회 |
| `PATCH /api/calls/:id` | `{"action":"accept"}` 또는 `reject`는 수신자, `cancel`은 발신자, `end`는 수락 후 양쪽에서 호출 |
| `POST /api/calls/:id/join` | 수락된 통화의 두 참가자에게 각각 `{ "url": "...", "token": "..." }` 반환 |

발신 성공 시 `id`, `callerId`, `calleeId`, `status`, `requestedAt`을 반환합니다. 같은 발신자가
동일한 `requestId`와 수신자로 재시도하면 기존 요청을 반환하고, 같은 ID를 다른 수신자에게 사용하면
409를 반환합니다. 두 계정 사이에 활성 통화가 있으면 새 발신은 409입니다. 발신은 60초 후, 수락된 통화는
2시간 후 상태 조회 시 만료됩니다. 친구가 아닌 대상이나 권한 없는 통화는 404, 잘못된 입력은 400,
토큰이 없거나 틀리면 401입니다. LiveKit 설정이 없으면 입장 API는 503을 반환합니다.

### Cloud 키 없이 로컬 테스트

Git에서 제외되는 `.env.livekit-test`에 로컬 DB 비밀번호와 테스트 계정 토큰 두 개를 준비합니다.
Compose 2.24.4 이상과 공식 Windows LiveKit 실행 파일이 필요합니다. `192.168.0.10`을 PC의 실제
Wi-Fi IPv4로 바꾸고 두 PowerShell에 같은 값을 설정합니다. [LiveKit v1.13.11](https://github.com/livekit/livekit/releases/tag/v1.13.11)

테스트 설정 파일이 없으면 PowerShell 7에서 한 번 생성합니다.

```powershell
if (-not (Test-Path .env.livekit-test)) {
  'POSTGRES_PASSWORD', 'KICK_TEST_ACCOUNT_1_TOKEN', 'KICK_TEST_ACCOUNT_2_TOKEN' | ForEach-Object {
    "$_=" + [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  } | Set-Content .env.livekit-test -Encoding ascii
}
```

```powershell
$env:KICK_TEST_HOST = "192.168.0.10"
docker compose --env-file .env.livekit-test -p kick-livekit-test -f compose.yaml -f compose.livekit-test.yaml up --build -d --wait
# 두 번째 PowerShell에서 같은 디렉터리와 같은 KICK_TEST_HOST 값으로 실행
& "C:\path\to\livekit-server.exe" --config livekit.local.yaml --bind $env:KICK_TEST_HOST --node-ip $env:KICK_TEST_HOST
```

위 예시의 Kick 주소는 `http://192.168.0.10:3010`이고 LiveKit 주소는 `ws://192.168.0.10:7880`입니다.
같은 Wi-Fi의 기기에서 Kick API의 TCP 3010과 LiveKit의 TCP 7880·7881, UDP 7882에 연결할 수
있어야 합니다. 테스트용 키와 평문 HTTP·WS는 신뢰할 수 있는 네트워크에서만 사용하고 Android
디버그 빌드에서 해당 호스트를 허용합니다. 테스트가 끝나면 LiveKit을 종료하고 같은 Compose 옵션으로
`down`을 실행합니다. [LiveKit 포트](https://docs.livekit.io/transport/self-hosting/ports-firewall/)

### Android 연동과 확인

서버 주소, 가입·친구·음성 API, 백그라운드 수신 알림과 두 폰 테스트 절차는 [Android 연동 가이드](ANDROID-HANDOFF.md)를 참고합니다.

1. 두 기기에 각각 `kick-test-1`, `kick-test-2`의 테스트용 Bearer 토큰을 설정합니다.
   Lightsail 연동 시 베이스 URL은 `https://3.37.162.168/kick`이고 이 뒤에 표의 `/api/…`를 붙입니다.
   친구 목록에서 선택한 ID로 발신하며, 한 번의 발신을 재시도할 때는 동일한 `requestId`를 사용합니다.
   배포 계정 토큰은 Jenkins 상태 디렉터리의 `kick-backend/test-accounts.env`에 있습니다. 각 기기에
   해당 토큰만 테스트 빌드의 로컬 설정으로 주입합니다.
2. 앱이 포그라운드일 때 OkHttp SSE 등으로 `GET /api/calls/events`를 구독합니다. `call.status`가
   `REQUESTED`이고 `call.calleeId == accountId`일 때만 `call.id` 기준으로 수신 화면 또는 앱 내 알림을
   한 번 띄웁니다. 연결이 끊기면 재연결하면 되고, 첫 이벤트가 현재 상태입니다. 화면을 닫을 때 구독을
   취소합니다. `call: null`이면 수신 화면을 닫고, 정확한 종료 상태는 `GET /api/calls/:id`로 확인합니다.
3. 수신자가 `PATCH /api/calls/:id`에 `{"action":"accept"}`를 보냅니다. 두 앱은 `ACCEPTED`를
   확인한 후 각자의 `/join` 응답으로 같은 방에 접속합니다. LiveKit에서 마이크만 게시합니다.
   서버에 LiveKit Cloud 설정이 없으면 `/join`이 503을 반환합니다.
   통화가 종료되면 앱도 방에서 나갑니다. 입장 토큰은 발급 후 2분 동안 쓸 수 있습니다.
   이미 접속한 앱의 종료 처리는 통화 상태 조회 결과를 따릅니다.
4. TTS는 아래 PCM 스트리밍 절차로 보냅니다. 보내는 쪽 마이크를 끈 상태에서 상대가 음성을 듣는지
   확인합니다.
5. 수신 앱에서 상대방 마이크의 `RemoteAudioTrack`에 `addSink`를 붙이고 PCM을 기기 내 STT 엔진에
   전달합니다. 두 기기에서 번갈아 말해 각 화면에 상대 음성의 자막이 뜨는지 확인합니다.
   [LiveKit Android addSink](https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.room.track/-remote-audio-track/add-sink.html)

### 실기기 없이 미디어 경로 확인

로컬 Compose를 띄운 뒤 Python 3.11 이상의 가상환경에 테스트용 SDK를 설치합니다. 16 kHz·16-bit
mono WAV, 합성 MP3, WAV 언어와 같은 Vosk 모델의 압축을 푼 디렉터리를 준비합니다. 공개 영어 샘플은
아래 명령에 적힌 문구를 포함합니다.
[공개 WAV 샘플](https://github.com/alphacep/vosk-api/blob/master/python/example/test.wav) ·
[Vosk 모델](https://alphacephei.com/vosk/models/)

```sh
python -m pip install livekit==1.2.1 vosk==0.3.45
python test/livekit_media.py --base http://192.168.0.10:3010 --env-file .env.livekit-test --wav /path/to/test.wav --mp3 /path/to/tts.mp3 \
  --model /path/to/vosk-model-small-en-us-0.15 --expected "one zero zero zero one"
```

스크립트는 두 테스트 계정으로 발신·수락 후 방에 입장합니다. 상대방이 마이크를 음소거 상태로 관측한
뒤 MP3를 보내 원본과 일치하는지 확인하고, 양방향 원격 오디오를 STT에 전달해 예상 문구를 검사합니다.

PCM 경로는 `.env.livekit-test`에 `ELEVENLABS_API_KEY`를 넣고 Compose를 다시 실행한 뒤
첫 번째 테스트 계정의 음성 상태가 `READY`인지 확인합니다. 같은 명령에서 `--mp3 /path/to/tts.mp3`를
`--pcm-text "안녕하세요"`로 바꾸면 Kick에서 받은 PCM을 상대에게 청크 단위로 전달합니다. 상대가 첫
청크를 받으면 나머지를 읽고, 양쪽 바이트가 일치하는지 확인합니다.

LiveKit Cloud로 연결할 때는 기본 `compose.yaml`에 전달할 로컬 또는 Lightsail의 Git 제외
`.env`에 `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`을 설정합니다. 기기는
`/join`의 URL과 토큰으로만 LiveKit에 접속합니다.
[LiveKit 키 발급](https://docs.livekit.io/reference/api/projects/keys/)

## 계정별 ElevenLabs 보이스 클론

1. ElevenLabs에서 Starter 이상 요금제가 적용된 워크스페이스를 준비합니다. **Developers →
   API Keys**에서 키를 생성하고 Voices의 조회·생성·삭제와 Text to Speech 사용 범위를 허용합니다.
   키는 로컬 `.env` 또는 Lightsail의 Jenkins 홈 아래 `kick-backend/.env`에
   `ELEVENLABS_API_KEY`로 저장합니다. 설정을 바꾸면 Compose를 다시 적용합니다.
2. 두 계정에 대응하는 본인 또는 복제·외부 전송에 동의한 화자의 녹음 파일을 각각 준비합니다.
   한 사람만 말하는 조용한 환경에서 1~2분 분량을 녹음해 MP3 또는 WAV(최대 10 MiB)로 저장합니다.
3. 계정별 Bearer 토큰으로 `POST /api/voice`에 `audio` 파일 하나와 `consent=true`를
   multipart로 전송합니다. Kick이 ElevenLabs Instant Voice Cloning API를 호출해 반환된 음성 ID를
   해당 계정에 저장합니다. 원본 파일은 Kick DB에 저장하지 않습니다.

| 요청 | 동작 |
| --- | --- |
| `GET /api/voice` | 내 클론 상태 조회. `VERIFICATION_REQUIRED`면 ElevenLabs에서 본인 확인을 완료한 후 다시 조회 |
| `POST /api/voice/speech` | `{"text":"안녕하세요"}`를 받아 내 클론으로 최대 50자 합성 후 MP3 반환 |
| `POST /api/voice/speech/stream` | 같은 요청으로 합성하면서 PCM 응답 전송 |
| `DELETE /api/voice` | ElevenLabs에서 내 클론을 삭제한 후 Kick의 계정 연결 제거 |

Lightsail의 `kick-backend/.env`에서 `KICK_TTS_FIXED_SETTINGS=true`를 설정하면 MP3와 PCM 합성에
Multilingual v2, 발화 속도 0.92, 억양 안정성 0.75, 목소리 유사도 0.90, 스타일 강조 0.05가
고정 적용됩니다. 로컬 기본값은 `false`이며 PCM 요청마다 음성 설정을 바꿀 수 있습니다.

### Android PCM 스트리밍

1. 발신 앱이 Bearer 토큰과 JSON `{"text":"안녕하세요"}`로 `POST /api/voice/speech/stream`을
   호출합니다. 최대 50자까지 합성하며 Kick이 Bearer 토큰의 계정으로 등록된 `READY` 음성 ID와
   서버의 ElevenLabs 키를 사용합니다. 앱에서는 Kick Bearer 토큰만 설정합니다. 성공 응답은 `audio/pcm`이며
   WAV 헤더 없는 16kHz·16-bit signed little-endian·mono입니다. [ElevenLabs HTTP 스트리밍](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
2. 발신 앱은 LiveKit `localParticipant.streamBytes`로 문장당 스트림 하나를 열고, `topic`을
   `kick-speech-pcm`, `mimeType`을 `audio/pcm`, `destinationIdentities`를 상대 계정 ID
   하나로 설정합니다. HTTP 응답의 입력 스트림을 읽으며 청크마다 `writer.write(chunk).getOrThrow()`를
   호출하고 정상 EOF에 `writer.close()`를 호출합니다. HTTP 읽기 실패 시
   `writer.close(reason = "TTS stream failed")`로 닫고, 통화 종료 시 HTTP 요청도 취소합니다.
   [LiveKit Byte Stream](https://docs.livekit.io/transport/data/byte-streams/)
3. 수신 앱은 입장 전에 `registerByteStreamHandler("kick-speech-pcm")`를 등록하고 상대 계정과
   MIME을 확인합니다. 수신 청크를 통화용 `AudioTrack`의 `MODE_STREAM`, `ENCODING_PCM_16BIT`,
   `CHANNEL_OUT_MONO`, 샘플레이트 16000, `USAGE_VOICE_COMMUNICATION` 설정으로 순서대로
   재생합니다. 청크 경계에서 16-bit 샘플이 잘릴 수 있으므로 홀수 끝 바이트는 다음 청크에 붙입니다.
   [Android AudioTrack](https://developer.android.com/reference/android/media/AudioTrack)

응답 시작 전에는 잘못된 텍스트에 400, 잘못된 계정 토큰에 401, 등록된 음성을 사용할 수 없으면 409,
ElevenLabs 요청 실패에 502, 키 설정 누락에 503을 반환합니다. PCM 전송 중 실패하면 HTTP 스트림이
끊깁니다. 수신 앱은 재생 중인 스트림의 오류를 처리합니다.

클론은 계정당 하나입니다. 생성 결과가 불명확하면 중복 생성 방지를 위해 `CREATING` 상태를 유지합니다.
계속 남아 있다면 운영자가 ElevenLabs의 `Kick kick-test-1` 또는 `Kick kick-test-2` 음성을 확인하고
필요하면 먼저 삭제한 뒤, 진행 중인 요청이 없을 때 해당 계정의 `CREATING` 행을 정리합니다.

```sh
curl --fail -H "Authorization: Bearer $KICK_ACCOUNT_TOKEN" \
  -F 'consent=true' -F 'audio=@sample.mp3;type=audio/mpeg' http://127.0.0.1:3010/api/voice
curl --fail -H "Authorization: Bearer $KICK_ACCOUNT_TOKEN" -H 'Content-Type: application/json' \
  --data '{"text":"안녕하세요"}' --output kick-speech.mp3 http://127.0.0.1:3010/api/voice/speech
```

[API 키 준비](https://elevenlabs.io/docs/help-center/technical/how-do-i-authorize-myself-using-an-api-key) ·
[Instant Voice Cloning](https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/instant-voice-cloning) ·
[녹음 권장 사항](https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning)

Jenkins Pipeline Job은 GitLab의 배포 대상 브랜치에서 `kick/backend/Jenkinsfile`을 읽습니다.
Jenkins가 약 5분마다 지정 브랜치의 `kick/backend/` 변경을 확인해 CI를 실행합니다.
같은 커밋을 다시 검증하거나 배포할 때는 수동으로 실행할 수 있습니다.
빌드는 린트, 포맷 검사, 컴파일을 실행하고 별도 Compose 프로젝트에서 앱과 PostgreSQL을 띄워 검증합니다.
`DEPLOY_KICK=true`로 실행하면 검증한 커밋 이미지가 같은 서버의 `kick-backend` 프로젝트에 배포됩니다.
배포용 DB 비밀번호는 Jenkins 홈의 `kick-backend/.env`에 첫 배포 때 생성하고 이후 재사용합니다.
`3010`은 서버의 루프백에서 접근합니다. Lightsail의 IP 인증서를 사용하는 HTTPS 서버 블록에서
`deploy/nginx-kick.conf`를 include하면 안드로이드 앱이 `https://3.37.162.168/kick/api/…`에 접속할 수
있습니다. Nginx 설정 검사는 `nginx -t`, 외부 상태 확인은 `GET https://3.37.162.168/kick/health`입니다.
외부 `/kick/api/voice`에서 등록 상태 조회와 음성 등록을 지원합니다. 음성 삭제는 백엔드에 직접 연결해
관리합니다. `KICK_SIGNUP_CODE`로 팀 테스트용 가입을 열고, `FCM_SERVICE_ACCOUNT_BASE64`를 설정하면
수신자의 등록 기기로 백그라운드 수신 알림을 전송합니다.

## Jenkins 연결

| 항목 | 설정 |
| --- | --- |
| Job | `kick-backend` (Pipeline) |
| Definition | Pipeline script from SCM / Git |
| Repository URL | `https://lab.ssafy.com/s15-final/S15P31D109.git` |
| Credentials | `gitlab-ssafy` |
| Branch Specifier | `*/chore/kick-backend-bootstrap` |
| Script Path | `kick/backend/Jenkinsfile` |

Lightsail의 Jenkins `built-in` 노드는 Docker를 실행할 수 있습니다. 별도 노드가 필요할 때는
**Manage Jenkins → Nodes → New Node → Permanent Agent**에서 이름·작업 경로·라벨을 등록하고
SSH 연결을 설정합니다. 이 Job의 배포 단계가 실행되는 노드는 Kick 스택이 위치한 Lightsail의
Docker에 접근할 수 있어야 합니다. [Jenkins 에이전트 설정](https://www.jenkins.io/doc/book/using/using-agents/)

CLI용 API 토큰은 Jenkins에 로그인한 후 우측 상단 사용자 메뉴의 **Security → API Token →
Add new Token**에서 발급합니다. CLI에는 저장소 밖에 둔 `사용자명:토큰` 파일을
`-auth @파일경로`로 전달합니다. Job 생성과 빌드 권한은 토큰을 발급한 계정의 권한을 따릅니다.
[Jenkins CLI 인증](https://www.jenkins.io/doc/book/managing/cli/)
