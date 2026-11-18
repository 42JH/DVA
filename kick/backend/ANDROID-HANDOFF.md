# Kick Android 연동

API 베이스 URL은 `https://3.37.162.168/kick/`입니다. Retrofit 등에서는 경로를 `api/friends`처럼 선행 슬래시 없이 지정합니다. 서버 상태는 [Kick health](https://3.37.162.168/kick/health)에서 확인합니다.

## 계정, 친구, 목소리

두 폰으로 통화부터 확인할 때는 A에 `kick-test-1`, B에 `kick-test-2`를 사용합니다. 서버에 설정된 토큰은 백엔드 담당자의 Git 제외 파일 `.env.android-test`에 있습니다. 각 폰에는 해당 계정의 토큰만 디버그 설정으로 전달합니다. 두 테스트 계정은 서로 친구이고 등록된 목소리가 있습니다.

신규 계정은 서버 담당자에게 받은 가입 코드로 등록합니다. Lightsail 팀 테스트용 코드는 백엔드 담당자의 Git 제외 파일 `.env.android-signup`에 있습니다. 가입 응답의 토큰을 기기의 안전한 저장소에 보관하고 앱을 다시 열 때 사용합니다. 현재 가입 방식에서는 토큰을 잃으면 재로그인으로 복구할 수 없습니다.

| 요청 | 요청·응답 |
| --- | --- |
| `POST /api/accounts` | `{"displayName":"내 이름","inviteCode":"<가입 코드>"}` → 201 `{"id":"<Kick ID>","displayName":"내 이름","token":"<Bearer 토큰>"}`. 이름은 최대 40자. 가입 코드가 틀리면 403, 서버에 코드가 없으면 503 |
| `GET /api/accounts/me` | 200 `{"id":"<Kick ID>","displayName":"내 이름"}`. 친구 추가용 ID를 복사할 수 있게 표시 |
| `GET /api/friends` | 200 `[{"id":"<상대 Kick ID>","displayName":"친구 이름"}]` |
| `PUT /api/friends/{friendId}` | 본문 없이 상대 Kick ID를 넣으면 200 `{"id":"<상대 Kick ID>","displayName":"친구 이름"}`. 내 목록에 추가. 양쪽에서 먼저 걸 수 있게 하려면 각자 상대를 추가 |
| `GET /api/voice` | 200 `{"status":"READY"}` 또는 `NOT_REGISTERED`, `CREATING`, `VERIFICATION_REQUIRED` |
| `POST /api/voice` | multipart `audio`에 본인이 동의한 MP3 또는 WAV 1개(최대 10 MiB), `consent`에 문자열 `true`. 201로 상태 반환. `VERIFICATION_REQUIRED`면 ElevenLabs 본인 확인 후 상태 재조회 |

가입을 제외한 요청에 `Authorization: Bearer <Kick 토큰>`을 보냅니다. ElevenLabs API 키와 목소리 ID는 Kick 서버에서 계정에 연결해 사용합니다. 음성 등록과 합성은 해당 ElevenLabs 프로젝트의 구독 및 사용 한도를 따릅니다.

## 발신 → 수락 → 입장

1. 양쪽 앱은 포그라운드에서 `GET /api/calls/events`를 구독합니다. `event: call`의 JSON은 `{"accountId":"<내 ID>","call":null}` 또는 아래 통화 객체를 포함합니다. 첫 이벤트가 현재 상태입니다. 연결이 끊기면 재연결하거나 `GET /api/calls/active`를 조회합니다.
2. A가 친구 목록에서 B를 선택하고 `POST /api/calls`에 `{"calleeId":"<B의 Kick ID>","requestId":"<새 UUID>"}`를 보냅니다. 응답은 201이며 `id`, `callerId`, `calleeId`, `status: "REQUESTED"`, `requestedAt`을 반환합니다. 같은 발신을 재시도할 때는 같은 `requestId`를 씁니다.
3. B는 `REQUESTED`이고 `calleeId`가 자신의 ID일 때 수신 화면을 띄웁니다. 수락은 `PATCH /api/calls/{id}`에 `{"action":"accept"}`, 거절은 `{"action":"reject"}`입니다. 발신자는 수락 전 `cancel`, 수락 후에는 양쪽 모두 `end`를 보낼 수 있습니다.
4. 양쪽은 `ACCEPTED`를 확인한 뒤 각자의 Kick 토큰으로 `POST /api/calls/{id}/join`을 호출합니다. 응답은 `{"url":"wss://…","token":"<LiveKit 입장 토큰>"}`입니다. 각 응답으로 `room.connect(url, token)`을 호출합니다. 입장 토큰은 최초 접속에 2분 동안 유효합니다. LiveKit 참가자 ID는 Kick 계정 ID입니다.
5. 발신 요청은 60초 후 만료됩니다. `GET /api/calls/{id}`로 `REJECTED`, `CANCELED`, `ENDED`, `EXPIRED`를 확인하면 알림을 닫고, 접속 중이면 방에서 나갑니다. SSE의 `call: null`은 활성 통화가 없다는 뜻입니다.

## 통화 중 마이크, 텍스트, TTS

- **마이크**는 양쪽에서 `RECORD_AUDIO` 권한을 받은 뒤 `localParticipant.setMicrophoneEnabled(true)`로 게시합니다. 두 사람이 동시에 게시하고 구독합니다. 음소거는 `setMicrophoneEnabled(false)`로 처리합니다. [LiveKit Android 마이크](https://docs.livekit.io/reference/client-sdk-android/livekit-android-sdk/io.livekit.android.room.participant/-local-participant/set-microphone-enabled.html)
- **텍스트**는 양쪽 앱이 입장 전에 `registerTextStreamHandler("kick-chat-text")`를 등록합니다. 입력을 보내면 `sendText(text, StreamTextOptions(topic = "kick-chat-text", destinationIdentities = listOf(Participant.Identity(peerId))))`로 상대에게 전달합니다. 수신 앱은 상대 ID를 확인하고 받은 문장을 표시합니다. [LiveKit 텍스트 스트림](https://docs.livekit.io/transport/data/text-streams/)
- **TTS**는 같은 입력으로 `POST /api/voice/speech/stream`에 `{"text":"<최대 50자>"}`를 보냅니다. 서버는 발신자의 등록 목소리로 합성합니다. 발신 앱은 HTTP 응답을 읽으면서 문장당 한 번 `streamBytes`를 열어 상대에게 청크를 전달합니다. `topic = "kick-speech-pcm"`, `mimeType = "audio/pcm"`, `destinationIdentities = listOf(Participant.Identity(peerId))`를 사용합니다. 마이크 음소거 상태에서도 두 데이터 스트림을 보냅니다. 텍스트 표시를 합성 완료까지 기다리게 하지 않습니다. [LiveKit 바이트 스트림](https://docs.livekit.io/transport/data/byte-streams/)
- **TTS 수신**은 입장 전에 `registerByteStreamHandler("kick-speech-pcm")`를 등록합니다. 상대 ID와 MIME을 확인하고, WAV 헤더 없는 **16 kHz, PCM 16-bit signed little-endian, mono**를 통화용 `AudioTrack`의 `MODE_STREAM`, `CHANNEL_OUT_MONO`, `ENCODING_PCM_16BIT`, `USAGE_VOICE_COMMUNICATION`으로 재생합니다. 청크 끝에 홀수 바이트가 남으면 다음 청크와 합쳐 씁니다. EOF에 writer를 닫고 통화 종료 시 스트림과 재생을 정리합니다. [Android AudioTrack](https://developer.android.com/reference/android/media/AudioTrack)

## 백그라운드 수신 알림

Firebase 프로젝트 준비 후 백엔드와 앱을 같은 프로젝트에 연결합니다.

1. Firebase Console에서 프로젝트를 만들고 앱의 실제 `applicationId`로 Android 앱을 등록합니다. Android 팀은 `google-services.json`과 Firebase Messaging SDK를 적용합니다. 백엔드 담당자는 FCM HTTP v1 권한이 있는 서비스 계정 JSON을 Base64로 인코딩해 서버의 `FCM_SERVICE_ACCOUNT_BASE64`에 넣습니다. [Android Firebase 설정](https://firebase.google.com/docs/android/setup) · [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api)
2. 로그인 직후와 `onNewToken`에서 기기 토큰을 `PUT /api/devices/push`에 `{"token":"<FCM 기기 토큰>"}`으로 보냅니다. 성공은 204입니다. 로그아웃 전에 같은 본문으로 `DELETE /api/devices/push`를 호출합니다. Android 13 이상은 알림 권한을 받고 앱을 처음 열 때 수신 채널을 생성합니다. [FCM Android 설정](https://firebase.google.com/docs/cloud-messaging/android/get-started)
3. 수신자 기기로 FCM 데이터 `type: "incoming_call"`, `callId`, `callerId`, `callerName`, `calleeId`, `expiresAt`이 옵니다. `FirebaseMessagingService`에서 현재 계정과 유효 시간을 확인하고 `CallStyle` 알림에 받기·거절 액션을 붙입니다. 포그라운드 SSE와 FCM이 모두 오면 `callId`로 중복을 제거합니다. 액션 실행 시 서버 상태를 확인하고 같은 `PATCH`를 호출합니다. 받기는 통화 화면을 연 뒤 마이크를 시작합니다. 설정에서 앱을 강제 종료한 기기는 앱을 다시 열어야 FCM을 받을 수 있습니다. [Android 통화 알림](https://developer.android.com/develop/ui/compose/notifications/call-style) · [Firebase 수신 조건](https://firebase.google.com/docs/cloud-messaging/flutter/receive-messages)

## 두 폰으로 확인

두 폰에서 서로 다른 계정으로 접속하고 이어폰을 끼거나 떨어진 곳에서 테스트합니다.

| 테스트 | 통과 기준 |
| --- | --- |
| A가 B에게 발신하고 B가 수락 | B에 수신 화면이 뜨고 양쪽이 같은 통화방에 입장 |
| 두 사람이 동시에 마이크로 말하기 | 두 폰 모두 상대 소리가 들리고 한쪽이 말하는 동안에도 다른 쪽 소리가 들림 |
| A가 `지금 잘 들려?`를 보내기 | B에 문장이 표시되고 A의 등록 목소리로 같은 문장이 재생 |
| A 마이크를 끄고 A가 `마이크 껐어.`를 보내기 | A의 마이크 소리는 B에 전달되지 않으며 문장과 A의 TTS는 B에 전달. B의 마이크 소리는 계속 A에 들림 |
| B에서도 같은 테스트 | 반대 방향의 텍스트·TTS와 음소거가 동작 |
| B를 홈 화면으로 보낸 후 A가 발신 | B에 받기·거절 알림 표시. 각각 눌러 수락·거절 결과 확인. 화면 잠금 상태에서도 반복 |
| 신규 계정 테스트 | 가입 후 친구 추가가 목록에 반영. 동의한 파일로 목소리를 등록하고 상태가 `READY`면 통화 중 새 목소리로 재생 |

SDK 클라이언트로 Lightsail 발신·수락과 LiveKit Cloud 방 입장을 검증할 수 있습니다. Android 실기기의 마이크, 재생, 알림 UI는 위 절차로 확인합니다.
