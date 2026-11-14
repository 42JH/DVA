# vomi

- 패키지 / Application ID: `com.ssafy.vomi`
- JDK 21, Gradle 9.5.0, AGP 9.2.1, Kotlin 2.3.21
- compileSdk / targetSdk 37, minSdk 26, JVM target 17
- Jetpack Compose, Navigation 3, Hilt (KSP)

## 시작하기

Android Studio에서 이 폴더를 열고 Gradle Sync를 실행합니다.
Gradle JDK는 21, Android SDK Platform은 37을 사용합니다.
`local.properties`에는 각 개발 환경의 `sdk.dir`을 설정합니다. 이 파일은 Git에서 제외됩니다.

```powershell
.\gradlew.bat assembleDebug
.\gradlew.bat :app:lintDebug
```

## 모듈

- `app`: Application, Activity, 기능 진입점 연결
- `build-logic`: Android / Compose / Feature / Hilt / Room / JVM convention plugins
- `core:common`, `core:model`, `core:domain`: Android에 의존하지 않는 Kotlin/JVM 모듈
- `core:data`: Repository 인터페이스와 구현, network / database / datastore 연결
- `core:network`, `core:database`, `core:datastore`, `core:datastore-proto`: 데이터 소스 설정
- `core:designsystem`, `core:ui`: 기본 테마와 공통 UI
- `core:navigation`: Navigation 3 상태와 Navigator
- `core:notifications`: 알림 모듈 골격 (Firebase 미연결)
- `feature:home:api`: 직렬화 가능한 HomeNavKey
- `feature:home:impl`: 친구 목록, HomeViewModel / HomeUiState와 EntryProvider 등록 함수

Feature API는 화면 진입 규약을 공개하고, 구현 화면은 impl 내부에 둡니다.
app에서 각 기능의 API / impl을 연결합니다. 기능 모듈끼리는 다른 기능의 impl을 참조하지 않습니다.
Motif처럼 Repository 인터페이스와 구현은 `core:data/repository`에 둡니다. 의존 방향은 `feature impl → data → network / datastore`이며, 공통 데이터 모델은 `core:model`에 둡니다. `core:domain`은 필요한 UseCase를 추가할 때 사용합니다.
app은 Hilt 구현 수집을 위해 data를 참조합니다.

로그인과 친구 목록은 실제 서버 API에 연결합니다.
DB 테이블, Proto 메시지, Firebase 설정과 실제 통화 연결은 아직 포함하지 않습니다.
빈 소스 디렉터리는 Git에 저장되지 않으며, 기능 추가 시 소스 파일과 함께 생성하면 됩니다.

## 디자인 시스템

Compose Material 3에 직접 의존하지 않고 Motif에서 이식한 Foundation 기반 컴포넌트를 사용합니다.
`VomiTheme`은 자체 색상, Pretendard / Paytone One 타이포그래피, 기본 본문 스타일과 글자색을 제공합니다.
`Text`, `Surface`, `Button`, `Icon`, `IconButton`, `Scaffold`, Divider, Tab / TabRow,
LoadingWheel, BottomSheet 및 GlassSurface를 `core:designsystem`에서 재사용할 수 있습니다.

`VomiBackground`를 화면 컨테이너로 사용하면 검정에서 푸른 회색과 갈색으로 이어지는 통화 배경이 적용됩니다.
배경은 화면 전체에 그려지고, 자체 `Scaffold`는 safeDrawing 인셋을 콘텐츠에 전달합니다.
현재 시작 화면은 공통 배경을 사용하는 테스트 계정 선택 화면입니다. 인증 후 친구 목록으로 이동하며, 친구 선택 시 서버에 통화를 요청하고 발신 대기 화면으로 이동합니다.
`DesignSystemPreview`에서 이식한 기본 컴포넌트를 미리 볼 수 있습니다.

Android Studio Preview에 필요한 ui-tooling은 debugImplementation으로만 연결합니다.
해당 디버그 도구가 Material 3를 간접 포함하지만, 앱 UI는 이를 사용하지 않으며
releaseRuntimeClasspath에는 Material 3 컴포넌트 라이브러리가 포함되지 않습니다.

## 친구 목록

`core:model`의 `Friend`는 ID, 이름, 프로필 이미지 URL을 담는 공통 데이터 모델입니다.
HomeViewModel이 StateFlow<HomeUiState>를 제공하고, HomeScreen은 lifecycle에 맞춰 상태를 수집합니다.
HomeUiState는 Loading / Success / Error로 구분하며 빈 목록, 오류 및 큰 글자 미리보기도 제공합니다.
홈 진입 시 FriendRepository가 현재 계정의 인증 토큰으로 GET api/friends를 조회합니다.
FriendClient의 응답은 core:data/mapper에서 core:model의 Friend로 변환합니다. Repository는 IO dispatcher에서 Flow를 실행하고 HomeViewModel은 asResult()로 상태를 갱신합니다.
친구 ID는 문자열 그대로 발신 요청에 전달하고, 통화 화면은 서버에서 발급한 callId로 식별합니다. 프로필 이미지가 없는 현재 API 응답에는 기본 아바타를 표시합니다.
요청 실패 시 재시도 버튼으로 다시 조회하며, 서버가 빈 배열을 반환하면 빈 목록 화면을 표시합니다.
샘플 친구 8명은 Compose Preview에서만 사용합니다. 클릭은 실제 발신 요청으로 이어지며 검색·친구 추가 화면은 포함하지 않습니다.

## 스크리닝 화면 (발신·수신 신호 연결)

- CallNavKey는 callId만 전달합니다. CallViewModel은 CallRepository의 서버 상태를 관찰하고 친구 목록에서 상대 이름을 찾습니다. 이름 조회가 실패하면 상대 ID를 표시합니다.
- REQUESTED 상태는 현재 계정이 발신자인지에 따라 발신 대기 / 수신 화면으로 표시합니다. 받기·거절·취소·종료는 서버 요청을 완료한 뒤 조회와 SSE로 상태를 확인합니다.
- ACCEPTED는 수락 완료 상태이며 LiveKit 연결 완료와 구분합니다. 현재 단계에서는 실제 미디어 연결이 없으므로 마이크·입력·전송은 비활성화하고 타이머를 시작하지 않습니다.
- 런타임은 sampleCallState를 사용하지 않습니다. 대화·AI 추천·요약은 비워 두며 고정 맞장구만 CallDefaults에서 유지합니다. 기존 샘플 대화는 Preview와 로컬 입력 규칙 테스트에만 사용합니다.
- 초안 편집·마이크 ON 시 입력 차단·추천 탭/드래그의 기존 규칙은 CallConversation에 분리했습니다. 실제 미디어가 Active 상태가 되면 이 규칙을 사용합니다.
- 실제 RTC / 마이크 캡처 / STT / TTS / 온디바이스 AI / 요약 생성 / FCM·시스템 알림 수신은 이후 단계입니다. 아직 마이크·알림 권한이나 foreground service를 추가하지 않습니다.

```powershell
.\gradlew.bat :app:assembleDebug :feature:call:impl:testDebugUnitTest :feature:call:impl:lintDebug
```

스크리닝 화면은 이름 옆에 작은 통화 시간을 표시합니다. 맞장구와 AI 추천은 탭 없이 두 목록을 동시에 표시합니다. 위쪽 맞장구는 은은한 노란빛, 아래쪽 추천은 회백색으로 구분하며, 칩 안의 문장은 최대 두 줄까지 표시합니다. 버튼은 보이는 원을 36dp로 줄이되 터치 영역은 48dp로 유지합니다.

키보드 인셋은 앱 NavDisplay의 imePadding에서만 적용합니다. Scaffold에는 시스템 바·디스플레이 컷아웃 여백만 전달하며, 이미 적용한 여백을 consumeWindowInsets로 소비합니다. Activity는 adjustResize를 사용합니다.
맞장구와 추천은 각각 고정 높이의 한 행 칩 영역을 사용하고, 목록 앞 아이콘은 제거했으며 맞장구 글자색은 흰색으로 표시합니다. 그룹 이름은 접근성 정보로 제공합니다. 사용하지 않는 탭 상태와 전환 동작은 제거했습니다. reduced viewport Preview는 키보드로 줄어든 화면 높이를 확인하기 위한 예시이며 실제 IME 애니메이션 검증을 대체하지 않습니다.
참고: https://developer.android.com/develop/ui/compose/system/insets-ui

칩의 한글 문장은 표시할 때만 음절 사이에 줄바꿈 가능 지점(U+200B)을 추가해 남은 가로 폭을 채우며 이어집니다. 원문과 접근성 텍스트에는 적용하지 않으므로 초안·전송·향후 TTS에는 원래 문장을 사용합니다. 이모지·결합 문자·구두점은 분리하지 않습니다.
참고: https://www.unicode.org/reports/tr14/#LB8

추천 문구의 세로 드래그가 시작되면 탭 전송을 취소합니다. 가로 드래그는 기존 LazyRow 스크롤로 처리합니다. 입력창 바깥에 놓거나 드래그를 취소하면 초안·대화를 변경하지 않습니다. 드롭 시 입력창에 포커스를 주며, 마이크 ON 상태의 차단 규칙은 유지합니다. 접근성 사용자에게는 '입력창에서 수정' 동작을 제공합니다. 실제 음성·네트워크 전송은 여전히 미연결입니다.
참고: https://developer.android.com/develop/ui/compose/touch-input/pointer-input/understand-gestures

## 테스트 계정 선택

같은 debug 빌드를 두 기기에 실행한 뒤 첫 화면의 `사용자 1`, `사용자 2` 버튼으로
각각 다른 계정을 선택합니다. 빌드별 계정 선택용 `kickTestAccount` 속성은 사용하지 않습니다.

`android-test.properties.example`을 `android-test.properties`로 복사한 뒤 로컬 파일에
`KICK_TEST_ACCOUNT_1_TOKEN`, `KICK_TEST_ACCOUNT_2_TOKEN`을 설정합니다.
같은 이름의 환경변수가 있으면 로컬 파일보다 우선합니다. 파일은 Git에서 제외되고,
두 값은 debug BuildConfig에만 전달됩니다. release BuildConfig에는 빈 문자열을 사용합니다.

- `feature:login:api` / `impl`: LoginNavKey, LoginViewModel, LoginUiState와 계정 버튼
- `core:model`: TestAccount, UserSession, LoginError (토큰은 UI 모델에 포함하지 않음)
- `core:data/repository`: AuthRepository 계약과 AuthRepositoryImpl 구현
- `core:data/di/DataModule`: Repository와 Provider 바인딩을 한곳에서 관리
- `core:network`: 공통 Retrofit과 AccountClient / AccountService를 통해 `GET /kick/api/accounts/me` 호출
- `core:data`: 응답 계정 검증, 메모리 세션 및 AccessTokenProvider
- `app`: 인증 상태에 따라 로그인 / 홈 이동, 디버그 자격 증명 DI

Motif처럼 Repository는 `Flow<UserSession>`을 반환하고, LoginViewModel은 기존 공통 `asResult()`를 통해 `Result.Loading / Success / Error`를 받아 UiState를 갱신합니다. 인증은 Flow를 수집할 때 실행합니다.

인증이 성공해야 친구 목록에 들어갑니다. 로딩 중에는 두 버튼을 비활성화하고,
토큰 누락·인증 실패·네트워크 오류를 안내한 뒤 다시 선택할 수 있습니다.
친구 목록에는 서버에서 받은 현재 계정 이름을 표시합니다. 친구 목록에서 뒤로 가면
세션과 토큰을 지우고 계정 선택으로 돌아갑니다. 프로세스를 새로 시작하면 다시 선택합니다.

계정 선택·인증·세션·친구 목록과 통화 신호가 연결되어 있습니다. LiveKit 미디어 연결은 이후 단계입니다. 이전 미디어 통합 실험 코드는 별도 `feature/android-live-call` 브랜치에 보관되어 있습니다.

```powershell
.\gradlew.bat :app:assembleDebug :feature:login:impl:testDebugUnitTest :core:data:testDebugUnitTest :app:lintDebug
```

`AuthRepositoryLiveTest`는 `VOMI_RUN_AUTH_LIVE_TESTS=1`과 두 토큰 환경변수가 있을 때만
실제 서버의 `/api/accounts/me`를 읽기 전용으로 조회합니다. 기본 실행에서는 이 테스트를 건너뜁니다.

## 공통 네트워크 구조

Motif처럼 `core:network/di/NetworkModule`에서 Json, OkHttpClient, Retrofit과 Service를
싱글턴으로 제공합니다. `NetworkConfig`에 베이스 URL과 타임아웃을 모으며,
`service/account`에는 AccountService / AccountClient, `model/account`에는 AccountResponse를 둡니다.
DTO는 Kick의 실제 JSON 응답 형식을 사용합니다.

호출은 `ViewModel → Repository → Client → Service → 서버` 순서입니다.
서비스의 상대 경로 `api/accounts/me`에는 선행 슬래시를 넣지 않아 `/kick/`을 유지합니다.
일반 요청의 연결·읽기·쓰기·전체 호출 타임아웃은 30초입니다.
SSE와 TTS는 별도의 StreamingNetwork 설정으로 전체 호출·읽기 타임아웃을 해제합니다.

`core:data/auth/SessionAccessTokenProvider`는 Repository와 독립적으로 토큰을 공급합니다.
Repository는 인증 성공 후 Provider를 갱신하고, 로그아웃 시 지웁니다.
이 분리로 `Repository → Retrofit → Interceptor → Repository` 순환 의존성을 피합니다.
Provider 바인딩은 기존 `DataModule`에서 함께 관리합니다.

AccessTokenInterceptor는 Kick API의 스킴·호스트·포트·경로에 해당하는 요청에만
현재 토큰을 추가합니다. 로그인 계정 검증처럼 요청이 명시적으로 Authorization을
지정했다면 그 값을 유지합니다. 따라서 사용자 1이 저장된 상태에서도 사용자 2의
토큰을 올바르게 검증할 수 있습니다.

로그는 debug에서 요청·응답의 기본 정보만 출력하고 release에서는 끕니다.
Authorization 헤더는 마스킹하며 요청·응답 본문은 기본 로그에 출력하지 않습니다.

```powershell
.\gradlew.bat :core:network:testDebugUnitTest :core:data:testDebugUnitTest :app:assembleDebug :app:lintDebug
```

NetworkClientTest는 네트워크로 나가기 전의 테스트 응답을 사용해 실제 Retrofit 변환과
OkHttp Interceptor 체인, 인증 헤더와 로그 마스킹을 검증합니다.
AuthRepositoryLiveTest는 명시적으로 활성화했을 때 공통 설정으로 실제 서버를 조회하여
각 계정의 명시적 토큰, 로그인 후 자동 헤더, 로그아웃 후 인증 해제를 확인합니다.

## Kick API 지원 범위

[Android 연동 명세](docs/kick-android-api.md)를 기준으로 다음 HTTP API를 구현했습니다.
친구 목록과 통화 신호 API는 화면에 연결했습니다. LiveKit join·음성·푸시 등 나머지 화면 연동은 이후 단계입니다. 기존 테스트 로그인 동작은 유지합니다.

| Client | 지원 요청 |
| --- | --- |
| AccountClient | POST api/accounts, GET api/accounts/me |
| FriendClient | GET api/friends, PUT api/friends/{friendId} |
| VoiceClient | GET api/voice, multipart POST api/voice, streaming POST api/voice/speech/stream |
| CallClient | POST api/calls, GET api/calls/active, GET api/calls/{id}, PATCH api/calls/{id}, POST api/calls/{id}/join |
| CallEventsClient | GET api/calls/events → Flow<CallStateResponse> |
| DeviceClient | PUT / DELETE api/devices/push (둘 다 JSON token 본문) |
| HealthClient | GET health |

- 회원가입과 health는 Retrofit 요청 태그로 현재 세션 토큰 첨부를 생략합니다.
  회원가입 응답 토큰을 저장하거나 로그인 상태를 바꾸는 처리는 이후 Repository 연결 시 구현합니다.
- 통화 생성은 CreateCallRequest의 requestId를 그대로 보냅니다. 같은 발신을 재시도할 때 호출자가 같은 UUID를 유지해야 합니다.
- 통화 변경 action은 accept / reject / cancel / end로 직렬화합니다.
  명세에 변경 응답 본문이 정의되지 않아 성공은 Unit으로 처리하며, 상태는 조회 또는 이벤트로 확인합니다.
- 음성 등록은 동의가 true인 1 byte~10 MiB의 MP3/WAV 파일만 요청합니다.
  TTS는 입력을 자르거나 수정하지 않고 보내며 서버 명세의 최대 50자 제한을 따릅니다.
- TTS의 ResponseBody는 WAV 헤더 없는 16 kHz, 16-bit signed little-endian, mono PCM입니다.
  호출자가 IO dispatcher에서 읽고 사용 완료·취소 시 반드시 닫아야 합니다.
- 이벤트 Flow는 수집할 때 새 SSE 연결을 열고 수집 취소 시 소켓과 응답 본문을 정리합니다.
  call:null을 포함한 스냅샷을 전달하며 연결 종료와 HTTP·파싱 실패를 오류로 전달합니다.
  CallRepository가 앱 전경 상태에 맞춰 재연결과 활성 통화 재조회를 관리합니다. FCM 중복 제거는 이후 단계입니다.
- 일반 HTTP 오류는 HttpException으로 전달합니다. 서비스별 오류 JSON 형식은 명세에 없어 임의의 공통 오류 DTO를 만들지 않았습니다.

로컬 HTTP 계약 테스트(실제 가입·음성 등록·TTS·FCM 요청 없음):

~~~powershell
# 터미널 1
postman simulation run postman/simulations/kick-android.sim.yaml --port 4017 --no-history

# 터미널 2
$env:KICK_SIMULATION_URL = "http://127.0.0.1:4017/kick/"
.\gradlew.bat :core:network:testDebugUnitTest
~~~

RemainingApiContractTest는 실제 Retrofit/OkHttp를 로컬 Postman 서버에 연결해 요청 경로·JSON·multipart·204·SSE·PCM·HTTP 오류를 검증합니다.
운영 URL과 인증 Interceptor를 거친 뒤 테스트용 Interceptor가 마지막 전송 주소만 바꿉니다.
KICK_SIMULATION_URL이 없으면 이 계약 테스트만 건너뛰며, SSE 파싱·실제 소켓 취소·파일 사전 검증 테스트는 항상 실행합니다.
AuthRepositoryLiveTest는 별도 활성화 시 두 테스트 계정으로 계정·친구·음성 상태·활성 통화·SSE를 읽기 전용 검증합니다.
기본 테스트는 실제 신규 가입·음성 업로드/합성·푸시 등록/삭제·통화 변경을 실행하지 않습니다. 통화 변경을 포함하는 별도 테스트는 아래의 명시적 opt-in을 사용합니다.

친구 목록 연결 검증: FriendRepositoryImplTest는 문자열 ID·이름 매핑, 빈 배열, Flow 수집 시 재조회, 실패·취소 전달을 확인합니다. HomeViewModelTest는 초기 로딩·성공·빈 목록·오류 후 재시도·중복 요청 방지를 확인합니다. AuthRepositoryLiveTest의 친구 조회도 실제 FriendRepository를 거쳐 두 테스트 계정에 상대 계정이 표시되는지 확인합니다.

## 발신·수신 신호 흐름

CallRepository는 기존 DataModule에서 singleton으로 바인딩하고 core:model의 CallSession / CallStatus / CallSignalingState를 사용합니다.
SessionViewModel은 앱 lifecycle이 STARTED인 동안만 수신 연결을 활성화합니다. Repository는 인증 계정 변경 시 이전 구독과 상태를 지우고, 화면마다 SSE를 중복으로 열지 않습니다.

1. 친구 선택 → HomeViewModel이 UUID requestId를 생성해 createCall Flow를 asResult로 수집합니다. 요청 중 중복 탭을 막고, 같은 친구의 실패 재시도에는 같은 UUID를 씁니다.
2. 서버 통화 ID로 단일 통화 화면을 엽니다. SSE REQUESTED 수신자는 받기·거절 UI를 표시합니다. 반복 이벤트는 동일 callId 화면을 중복으로 열지 않습니다.
3. 수신자는 accept/reject, 발신자는 수락 전 cancel, 수락 후 양쪽은 end를 요청합니다. 요청 중 버튼과 뒤로 가기 중복 조작을 막으며, 실패 시 로컬 성공으로 처리하지 않고 재시도할 수 있습니다.
4. 요청 성공 후 통화를 다시 조회합니다. ACCEPTED 이후 REQUESTED 응답이나 종료 이후 늦은 HTTP 응답이 와도 상태를 되돌리지 않습니다.
5. REJECTED/CANCELED/ENDED/EXPIRED 또는 call:null을 받으면 화면을 닫습니다. 앱 복귀·일시적 단절 후에는 활성 통화를 조회하고 SSE를 재구독하며, 재시도 간격은 1~30초입니다. HTTP 401/403은 자동 재시도를 멈춥니다.

로컬 Postman fixture는 두 인증 계정과 지속 SSE를 지원합니다. 모의 서버 계약 테스트마다 x-mock-session을 분리해 다른 테스트의 초기화에 영향을 받지 않게 합니다.

~~~powershell
# 로컬 모의 서버: 별도 터미널
postman simulation run postman/simulations/kick-android.sim.yaml --port 4017 --no-history

# 실제 HTTP/SSE를 통한 두 Repository의 로컬 신호 검증
$env:KICK_SIMULATION_URL = "http://127.0.0.1:4017/kick/"
.\gradlew.bat :core:data:testDebugUnitTest --tests "*CallSignalingIntegrationTest"
~~~

VOMI_RUN_CALL_LIVE_TESTS=1과 두 KICK_TEST_ACCOUNT 토큰 환경변수를 별도로 설정하면 실서버 신호 테스트도 실행합니다.
이 테스트는 기존 활성 통화가 있으면 건너뛰고, 전용 테스트 계정 사이에서 발신·수락·종료 / 거절 / 취소의 세 통화를 생성해 정리합니다. LiveKit join과 음성 합성은 호출하지 않습니다.
기본 실행에서는 실서버 쓰기 테스트를 건너뜁니다.

두 기기에서는 사용자1·사용자2로 로그인한 뒤 앱을 켠 상태에서 친구를 눌러 확인합니다. 상대 수신 화면 표시, 받기 후 양쪽 수락 완료, 거절·발신 취소·종료 후 양쪽 홈 복귀를 확인합니다.
이 단계의 성공은 신호 연결까지이며 실제 음성이 들리는지와 FCM 백그라운드 알림은 검증 대상에 포함하지 않습니다.
