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
- `core:rtc`: LiveKit 방·마이크·텍스트/PCM 전송·수신 재생
- `core:speech`: RTC PCM 입력을 받는 온디바이스 STT
- `core:ai`: Gemini Nano 모델 준비·답변 생성 어댑터
- `core:navigation`: Navigation 3 상태와 Navigator
- `core:notifications`: 알림 모듈 골격 (Firebase 미연결)
- `feature:home:api`: 직렬화 가능한 HomeNavKey
- `feature:home:impl`: 친구 목록, HomeViewModel / HomeUiState와 EntryProvider 등록 함수

Feature API는 화면 진입 규약을 공개하고, 구현 화면은 impl 내부에 둡니다.
app에서 각 기능의 API / impl을 연결합니다. 기능 모듈끼리는 다른 기능의 impl을 참조하지 않습니다.
Motif처럼 Repository 인터페이스와 구현은 `core:data/repository`에 둡니다. 의존 방향은 `feature impl → data → network / datastore`이며, 공통 데이터 모델은 `core:model`에 둡니다. `core:domain`은 필요한 UseCase를 추가할 때 사용합니다.
app은 Hilt 구현 수집을 위해 data를 참조합니다.

로그인과 친구 목록은 실제 서버 API에 연결합니다.
인증 세션은 Proto DataStore에 저장합니다. 전경 음성 통화는 core:rtc의 LiveKit 구현으로 연결합니다. DB 테이블과 Firebase 설정은 아직 포함하지 않습니다.
빈 소스 디렉터리는 Git에 저장되지 않으며, 기능 추가 시 소스 파일과 함께 생성하면 됩니다.

## 디자인 시스템

Compose Material 3에 직접 의존하지 않고 Motif에서 이식한 Foundation 기반 컴포넌트를 사용합니다.
`VomiTheme`은 자체 색상, Pretendard / Paytone One 타이포그래피, 기본 본문 스타일과 글자색을 제공합니다.
`Text`, `Surface`, `Button`, `Icon`, `IconButton`, `Scaffold`, Divider, Tab / TabRow,
LoadingWheel, BottomSheet 및 GlassSurface를 `core:designsystem`에서 재사용할 수 있습니다.

`VomiBackground`를 화면 컨테이너로 사용하면 검정에서 푸른 회색과 갈색으로 이어지는 통화 배경이 적용됩니다.
배경은 화면 전체에 그려지고, 자체 `Scaffold`는 safeDrawing 인셋을 콘텐츠에 전달합니다.
앱 시작 시 저장된 인증 세션을 읽는 동안 로딩 화면을 표시합니다. 두 토큰과 사용자 ID가 있으면 자동 로그인하고, 세션이 없으면 테스트 계정 선택 화면을 표시합니다. 인증 후 친구 목록으로 이동하며, 친구 선택 시 서버에 통화를 요청합니다.
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

- CallNavKey는 callId만 전달합니다. CallViewModel은 CallRepository.callState를 관찰하고 친구 목록에서 상대 이름을 찾습니다. 이름 조회가 실패하면 상대 ID를 표시합니다.
- REQUESTED 상태는 현재 계정이 발신자인지에 따라 발신 대기 / 수신 화면으로 표시합니다. 받기·거절·취소·종료는 서버 요청을 완료한 뒤 조회와 SSE로 상태를 확인합니다.
- ACCEPTED는 서버 수락 상태이며 실제 미디어 연결과 구분합니다. LiveKit 방 연결과 상대 참여가 확인되면 Active가 되고 타이머를 시작합니다. 마이크는 기본 OFF이며 권한 허용 후 SDK의 실제 상태로 제어합니다.
- 런타임은 sampleCallState를 사용하지 않습니다. 대화는 실제 STT, 추천은 Gemini Nano 결과로 채우며 요약은 아직 비워 둡니다. 고정 맞장구는 CallDefaults에서 유지합니다. 기존 샘플 대화는 Preview와 로컬 입력 규칙 테스트에만 사용합니다.
- 초안 편집·마이크 ON 시 입력 차단·추천 탭/드래그의 기존 규칙은 CallConversation에 분리했습니다. 실제 미디어가 Active 상태가 되면 이 규칙을 사용합니다.
- 전경 RTC·마이크 제어와 통화 중 온디바이스 STT 자막을 연결했습니다. Gemini Nano 답변 추천도 연결했으며, 서버 TTS 스트리밍도 연결했습니다. 요약·FCM·Foreground Service는 이후 단계입니다.

```powershell
.\gradlew.bat :app:assembleDebug :feature:call:impl:testDebugUnitTest :feature:call:impl:lintDebug
```

스크리닝 화면은 이름 옆에 작은 통화 시간을 표시합니다. 맞장구는 입력창 위의 은은한 노란색 칩 행에 남기고, AI 추천은 상대방의 마지막 말 아래에 회백색 카드 세 개로 표시합니다. 문장은 최대 두 줄까지 표시합니다. 버튼은 보이는 원을 36dp로 줄이되 터치 영역은 48dp로 유지합니다.

키보드 인셋은 앱 NavDisplay의 imePadding에서만 적용합니다. Scaffold에는 시스템 바·디스플레이 컷아웃 여백만 전달하며, 이미 적용한 여백을 consumeWindowInsets로 소비합니다. Activity는 adjustResize를 사용합니다.
맞장구는 고정 높이의 가로 스크롤 행을 사용하며 글자색은 흰색입니다. 추천 카드는 대화 목록 안에서 세로로 표시하고 작성 중·완성 상태를 구분합니다. 목록 앞 아이콘은 사용하지 않습니다. 사용하지 않는 탭 상태와 전환 동작은 제거했습니다. reduced viewport Preview는 키보드로 줄어든 화면 높이를 확인하기 위한 예시이며 실제 IME 애니메이션 검증을 대체하지 않습니다.
참고: https://developer.android.com/develop/ui/compose/system/insets-ui

칩의 한글 문장은 표시할 때만 음절 사이에 줄바꿈 가능 지점(U+200B)을 추가해 남은 가로 폭을 채우며 이어집니다. 원문과 접근성 텍스트에는 적용하지 않으므로 초안·전송·TTS에는 원래 문장을 사용합니다. 이모지·결합 문자·구두점은 분리하지 않습니다.
참고: https://www.unicode.org/reports/tr14/#LB8

추천 문구의 세로 드래그가 시작되면 탭 전송을 취소합니다. 맞장구 행은 가로 스크롤을 유지합니다. 대화 안의 추천 카드에서 위로 밀면 대화를 스크롤하고, 아래로 끌면 편집을 시작합니다. 입력창 바깥에 놓거나 드래그를 취소하면 초안·대화를 변경하지 않습니다. 드롭 시 입력창에 포커스를 주며, 마이크 ON 상태의 차단 규칙은 유지합니다. 접근성 사용자에게는 '입력창에서 수정' 동작을 제공합니다. 탭 전송은 서버 TTS와 LiveKit 스트리밍을 거치며, 로컬 화면에만 전송 성공을 추가하던 처리는 제거했습니다.
참고: https://developer.android.com/develop/ui/compose/touch-input/pointer-input/understand-gestures

## 테스트 계정 선택

같은 debug 빌드를 두 기기에 실행한 뒤 첫 화면의 `사용자 1`, `사용자 2` 버튼으로
각각 다른 계정을 선택합니다. 빌드별 계정 선택용 `kickTestAccount` 속성은 사용하지 않습니다.

`android-test.properties.example`을 `android-test.properties`로 복사한 뒤 로컬 파일에
`KICK_TEST_ACCOUNT_1_TOKEN`, `KICK_TEST_ACCOUNT_2_TOKEN`을 설정합니다.
같은 이름의 환경변수가 있으면 로컬 파일보다 우선합니다. 파일은 Git에서 제외되고,
두 값은 debug BuildConfig에만 전달됩니다. release BuildConfig에는 빈 문자열을 사용합니다.

- `feature:login:api` / `impl`: LoginNavKey, LoginViewModel, LoginUiState와 계정 버튼
- `core:model`: AuthState, AuthLoginResult, UserProfile, LoginError. TestAccount는 테스트 로그인 입력에만 사용하며 인증 세션·프로필에는 저장하지 않음
- `core:data/repository`: AuthRepository 계약과 AuthRepositoryImpl 구현
- `core:data/auth`: AuthDataSource 계약, AuthCredentials 로그인 결과와 MockAuthDataSource 구현
- `core:data/di/DataModule`: Repository와 Provider 바인딩을 한곳에서 관리
- `core:network`: 공통 Retrofit과 AccountClient / AccountService를 통해 `GET /kick/api/accounts/me` 호출
- `core:data`: 응답 계정 검증, 인증/사용자/통화 Repository, AccessTokenProvider
- `core:datastore`: AuthSessionDataSource와 Serializer, `core:datastore-proto`: 인증 세션 스키마
- `app`: 인증 상태에 따라 로그인 / 홈 이동, 디버그 자격 증명 DI

AuthRepository.login(credential)은 Flow<AuthLoginResult>를 반환하고, LoginViewModel은 asResult()로 Loading / Success / Error를 처리합니다. AuthRepository는 AuthDataSource 인터페이스에 의존하며, 현재 AuthModule이 MockAuthDataSource를 연결합니다. Mock 구현만 계정 선택값과 고정 토큰을 해석하고 서버 계정을 검증합니다. 인증에 성공하면 세션을 저장하고, 앱은 DataStore에서 파생한 AuthState로 화면을 결정합니다.

인증이 성공해야 친구 목록에 들어갑니다. 로딩 중에는 두 버튼을 비활성화하고,
토큰 누락·인증 실패·네트워크 오류를 안내한 뒤 다시 선택할 수 있습니다.
친구 목록에는 서버에서 받은 현재 계정 이름을 표시합니다. 친구 목록에서 뒤로 가면
저장된 세션과 토큰을 지우고 계정 선택으로 돌아갑니다. 앱을 다시 실행하면 저장된 세션을 복원하며, 로그아웃·앱 데이터 삭제 후에는 다시 선택합니다.

계정 선택·인증·세션·친구 목록과 통화 신호가 연결되어 있습니다. 현재 LiveKit 구현은 전경 통화 범위이며 실제 두 기기 송수신은 아직 검증하지 않았습니다. 이전 미디어 통합 실험 코드는 별도 `feature/android-live-call` 브랜치에 보관되어 있습니다.

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
친구 목록과 통화 신호 API는 화면에 연결했습니다. LiveKit join과 전경 음성 연결·마이크 제어를 연결했습니다. 음성 프로필·합성·푸시 등 나머지 화면 연동은 이후 단계입니다. 기존 테스트 로그인 동작은 유지합니다.

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
  앱의 MainActivityViewModel이 인증·전경 상태에 맞춰 구독을 시작·취소하고, CallRepository가 재연결과 활성 통화 재조회를 관리합니다. FCM 중복 제거는 이후 단계입니다.
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

CallRepository는 기존 DataModule에서 singleton으로 바인딩하며 공유 callState를 제공합니다. API 호출·응답 변환과 상태 반영, 생성 중복 방지, 실패 후 재조회, SSE 재연결을 내부에서 관리합니다. AuthRepository, ApplicationScope, 자체 로그인 감시나 전경 상태 의존성은 없습니다.
MainActivity는 인증 복원 로딩·시작 화면·Activity lifecycle 연결을 담당합니다. MainActivityViewModel은 AuthState와 전달받은 전경 상태를 기준으로 SignedIn + STARTED일 때 SSE를 수집합니다. VomiAppState는 전달받은 인증·통화 상태와 내비게이션을 묶어 앱 UI를 관리하며, VomiApp은 AppState와 로그아웃 콜백을 전달받습니다. 인증 종료 시 구독과 사용자 프로필·로컬 통화 상태를 정리합니다. CallSessionStore는 Repository 내부의 internal 구현으로 통화 상태와 늦은 응답 병합 규칙만 관리합니다. 앱과 기능 ViewModel은 Store를 직접 참조하거나 API 결과를 수동 반영하지 않습니다. MainActivityViewModel은 observeCalls().asResult()로 최종 오류를 받아 HTTP 401에서 로그아웃하며, 화면은 Repository가 제공하는 callState를 관찰합니다.

1. 친구 선택 → HomeViewModel이 UUID requestId를 생성해 createCall Flow를 asResult로 수집합니다. Repository가 생성 가능 여부 확인과 isCreating 초기화를 담당하고, HomeViewModel은 같은 친구의 실패 재시도에 같은 UUID를 씁니다.
2. 서버 통화 ID로 단일 통화 화면을 엽니다. SSE REQUESTED 수신자는 받기·거절 UI를 표시합니다. 반복 이벤트는 동일 callId 화면을 중복으로 열지 않습니다.
3. 수신자는 accept/reject, 발신자는 수락 전 cancel, 수락 후 양쪽은 end를 요청합니다. 요청 중 버튼과 뒤로 가기 중복 조작을 막으며, 실패 시 로컬 성공으로 처리하지 않고 재시도할 수 있습니다.
4. 요청 성공 후 통화를 다시 조회합니다. ACCEPTED 이후 REQUESTED 응답이나 종료 이후 늦은 HTTP 응답이 와도 상태를 되돌리지 않습니다.
5. REJECTED/CANCELED/ENDED/EXPIRED 또는 call:null을 받으면 화면을 닫습니다. 앱 복귀·일시적 단절 후에는 활성 통화를 조회하고 SSE를 재구독하며, retryWhen으로 재시도하며 간격은 1~30초이고 정상 SSE 수신 시 재시도 횟수를 초기화합니다. onCompletion은 구독 종료 시 연결 상태를 정리합니다. HTTP 401/403은 자동 재시도를 멈추고, 수동 재시도 요청은 앱이 수집을 다시 시작하도록 전달합니다.

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

## 인증 세션 저장과 자동 로그인

- auth_session.pb에는 access_token, refresh_token, 문자열 user_id만 저장합니다. TestAccount enum과 이름·프로필은 저장하지 않습니다.
- 현재 MockAuthDataSource는 선택한 계정 ID를 credential로 받아 실제 access token으로 계정을 검증하고, 임시 mock-refresh-token과 사용자 ID를 AuthCredentials로 반환합니다. Repository가 이 결과를 저장하며 Mock 토큰은 재발급 API에 전송하지 않습니다.
- 두 토큰이 모두 비어 있지 않고 userId가 있어야 AuthState.SignedIn입니다. AuthState.Initializing 동안은 로그인 화면을 먼저 띄우지 않습니다.
- AuthRepository.authState는 AuthSessionDataSource.session에서 파생하며, SignedIn을 전달하기 전에 SessionAccessTokenProvider를 갱신합니다. 이후 Interceptor가 저장된 access token을 API에 첨부합니다.
- 이름 등 프로필은 별도 UserRepository가 GET api/accounts/me로 조회해 메모리에 보관합니다. 로그인 상태와 프로필을 분리하며 로그아웃 시 프로필 캐시도 비웁니다.
- 앱에서 초기 사용자 조회나 SSE 요청이 HTTP 401로 거절되면 세션을 지우고 로그인으로 돌아갑니다. 현재 서버에는 실제 refresh API가 없어 mock 토큰으로 재발급을 시도하지 않습니다.
- 나중에 구글 로그인은 Google credential을 전달하는 UI와 백엔드 인증용 AuthDataSource 구현을 연결합니다. 로그인 인터페이스의 credential은 TestAccount 타입에 의존하지 않으며, 실제 access/refresh token과 userId를 반환하면 기존 Repository의 saveSession 흐름을 사용합니다.

로그인 네트워크 예외는 재포장하지 않고 그대로 전달합니다. LoginViewModel이 asResult()의 Error에서 인증 실패·네트워크 오류·서버 오류를 구분하며, 토큰 누락·계정 불일치는 Mock 구현의 검증 오류로 전달합니다.

이 인증 구조 변경에서는 테스트와 실서버 요청을 실행하지 않았습니다. 앱 컴파일 확인과 변경 코드·참조 검토만 수행했습니다. 기존 테스트 코드는 새 인터페이스에 맞춰 갱신했으며 실행 결과를 주장하지 않습니다.

## LiveKit 전경 음성 통화

- core:rtc는 RtcClient 인터페이스와 LiveKitRtcClient 구현만 노출하고, SDK Room과 트랙 타입은 내부에 둡니다. LiveKit Android 2.30.0을 사용하며 JitPack은 audioswitch 의존성 그룹으로 제한합니다.
- CallRepository.observeMedia()는 앱에서 수집할 때만 동작합니다. 수락된 callId가 바뀌면 기존 연결을 정리하고 POST api/calls/{id}/join의 URL·토큰으로 방에 입장합니다. 토큰은 UI 모델·로그·저장소에 넣지 않습니다.
- 서버 신호 connection과 CallMediaState는 별개입니다. SSE 자동 재연결은 기존 음성 방을 다시 만들지 않으며, SDK의 재연결 이벤트는 미디어 상태에 반영합니다. 수동 재시도는 참여 정보를 다시 받아 연결합니다.
- 마이크 권한은 UI에서 요청합니다. 기본 마이크 OFF 상태로 상대 음성을 수신하며, 마이크 ON을 선택하고 권한을 허용하면 음성을 송출합니다. SDK 변경과 공유 상태 확인 후 전환 완료를 표시하며 요청 중 중복 조작을 잠급니다.
- 통화 중 음성 전사는 아래 자막 흐름으로 연결했습니다. 답변 추천은 아래 Nano 흐름으로 연결했습니다. 개인화 음성 합성은 서버 TTS를 사용하며, 통화 요약은 이후 범위입니다. 마이크 OFF에서는 초안 작성·추천·맞장구·직접 입력 전송이 가능하고, 전송 중 중복 조작은 잠급니다. Preview의 로컬 입력 예시는 별도 fixture입니다.
- 통화 종료 요청은 로컬 Room을 먼저 닫고 서버 종료를 요청합니다. 원격 종료·로그아웃·관찰 취소도 Room과 오디오 자원을 해제합니다. 서버 종료 실패는 화면에 표시하고 재시도할 수 있습니다.
- 이번 구현은 전경 통화입니다. 백그라운드 진입 시 미디어를 정리하고 전경 복귀 시 수락된 통화에 다시 연결하며 마이크는 OFF로 시작합니다. 화면 회전은 동일 ViewModel과 연결을 유지합니다. 백그라운드 통화 유지·수신 알림·FCM·Foreground Service는 이후 단계입니다.
- 실제 연결 확인 시 두 앱을 모두 전경에 두고 사용자1·사용자2로 로그인한 뒤 발신 → 수락 → 연결 확인 → 각 기기에서 마이크 ON 및 권한 허용 → 상대 음성 수신 → 마이크 OFF → 종료 순서로 확인합니다. 이번 작업에서 이 기기 확인·서버 요청·테스트는 실행하지 않았고 앱 빌드와 정적 검토만 수행했습니다.

## 통화 중 온디바이스 STT 자막

- 별도 음성 자막 화면·홈 진입 버튼은 없습니다. 기존 스크리닝 통화 화면에서 각자의 마이크를 켜고 말하면 내 발화는 오른쪽, 상대방 발화는 왼쪽에 표시합니다. 인식 중 문장은 흐리게 갱신하고 확정 결과는 같은 항목에 반영합니다. STT로 인식한 자막은 표시·공유만 합니다. 사용자가 선택하거나 직접 입력해 전송한 텍스트에 서버 TTS를 사용합니다.
- 각 기기가 자기 LiveKit 마이크 트랙의 PCM16 프레임을 복사해 온디바이스 인식기에 공급합니다. 상대방 음성을 내 스피커에서 다시 녹음하지 않습니다. 인식 텍스트는 LiveKit의 별도 reliable 데이터 주제(vomi.call.caption.v1)로 해당 통화 상대에게 전달합니다. 따라서 상대 발화 자막을 받으려면 상대 앱에도 이 구현이 있어야 하고, 상대 기기의 한국어 인식이 가능해야 합니다. 마이크 OFF에서도 상대방 자막 수신은 유지합니다.
- core:rtc가 SDK 트랙·오디오 sink·데이터 메시지를 소유합니다. SDK 타입은 외부에 노출하지 않습니다. 오디오 콜백에서는 복사·큐 전달만 하고, 인식과 파이프 쓰기는 별도 dispatcher에서 처리합니다. 마이크가 꺼졌거나 방이 종료되면 프레임을 넘기지 않으며, 큐가 밀리면 자막을 중단하고 음성 통화는 유지합니다.
- core:speech는 develop-ai의 687fc0b6 Android PoC가 사용한 SpeechRecognizer.createOnDeviceSpeechRecognizer를 바탕으로, 직접 마이크를 여는 입력을 제거했습니다. Android 13(API 33)의 EXTRA_AUDIO_SOURCE 파이프로 16 kHz mono PCM을 공급하고 segmented/partial/final 결과를 받습니다. RTC 입력은 프레임 경계를 유지하며 mono 16 kHz로 변환합니다. 일반 세션 종료 후 재시작 간격은 250.milliseconds입니다.
- **Android 13 이상이라는 조건만으로 모든 기기에서 동작을 보장하지 않습니다.** 한국어 온디바이스 모델과 외부 PCM 입력·분할 인식을 지원하는 음성 서비스가 필요합니다. 지원 조회 실패·모델 없음·파이프를 읽지 않음·오디오 오류를 자막 오류로 표시합니다. 앱은 입력 파이프 없는 인식이나 서버 STT로 대체하지 않습니다. EXTRA_AUDIO_SOURCE 자체는 recognizer 구현에 따라 무시될 수 있으므로 통화 중 실제 동작 여부는 대상 기기의 음성 서비스에서 확인해야 합니다. 참고: [Android RecognizerIntent](https://developer.android.com/reference/android/speech/RecognizerIntent#EXTRA_AUDIO_SOURCE).
- CallTranscriptRepository가 STT 자막과 텍스트 메시지의 최근 200개 항목을 함께 메모리에 보관합니다. SpeechRepository는 음성 인식 상태와 자막 생성 작업을 담당합니다. 발화 ID·revision·확정 여부로 임시 결과를 교체하고 중복·역순 갱신을 막습니다. 송신자 식별은 payload가 아닌 LiveKit 참가자 ID와 서버 통화 상대 ID로 확인하며, 다른 callId·주제·참가자의 메시지를 무시합니다. 오디오 파일과 자막의 서버 저장·통화 이력 저장은 추가하지 않았습니다. 한 전송의 텍스트는 1,000자로 나누며, 추천 답변의 20자 설계와는 별개입니다.
- MainActivityViewModel이 인증·전경·수락된 통화의 미디어 연결을 기준으로 SpeechRepository.observeCall()을 asResult()로 수집합니다. CallViewModel은 Repository의 상태를 기존 CallUiState로 연결합니다. AppState는 기존 내비게이션만 관리합니다. 내 마이크를 끄면 입력 파이프를 닫고 마지막 결과를 최대 2초 기다리며, 확정되지 못한 가설은 양쪽에서 제거합니다. 통화 종료·끊김·백그라운드·로그아웃에서는 인식기와 sink·수신 구독을 정리합니다. 같은 통화에 복귀하면 확정 자막은 메모리에서 유지하고 인식은 실제 마이크 ON부터 재개합니다.
- 한국어 모델이 없으면 마이크 OFF 상태에서 통화 화면의 음성 팩 준비를 사용할 수 있습니다. API 34 이상은 다운로드 진행·성공·예약 콜백을 구분하고, API 33은 지원 조회로 완료·예약·요청됨을 구분합니다. 다운로드에는 시스템 서비스가 네트워크를 사용할 수 있으며, 준비 요청만으로 완료를 표시하지 않습니다.
- 두 기기에 같은 버전 앱을 설치하고 전경에서 통화한 뒤 각 기기의 마이크 ON으로 음성·내 자막·상대 자막을 확인하는 흐름입니다. 이번 작업에서는 테스트·실서버 요청·기기 실행·마이크 사용·모델 다운로드를 실행하지 않았습니다. 앱 빌드와 소스 정적 검토만 수행하며, 실제 두 기기 통화 및 기기별 PCM 입력 지원·지연·인식 품질은 미검증입니다.


## 통화 중 Gemini Nano 답변 추천

- 상대방의 최신 확정 자막과 최근 확정 대화를 바탕으로 내가 말할 한국어 답변 후보 세 개를 요청합니다. 임시 자막에서 추론을 시작하지 않으며, 새 임시 발화·내 답변·통화 종료·화면 이탈에서는 이전 후보와 생성 요청을 정리합니다. 요청 revision과 현재 대화 확인을 함께 사용해 늦은 결과가 최신 추천을 덮어쓰지 않게 합니다.
- core:ai의 ReplyRecommendationClient / GeminiNanoReplyRecommendationClient가 ML Kit Prompt API 1.0.0-beta4와 AICore 호출을 담당합니다. SDK 타입은 이 모듈 내부에만 둡니다. 통화 화면 진입 시 통화 전용 소유 키로 모델 세션을 열고, 전경에서 상태를 확인한 뒤 사용 가능한 모델에 warmup()을 수행합니다. 상태 확인·다운로드·사전 준비·생성은 직렬화하며, 통화 중 같은 클라이언트를 재사용합니다. 사전 준비에 성공한 클라이언트에는 warmup()을 반복하지 않습니다. 백그라운드에서는 SDK 작업을 취소하되 클라이언트를 유지하고, 통화 종료·ViewModel 정리 시 진행 중 작업을 정리한 뒤 닫습니다. 이전 통화의 뒤늦은 해제나 요청이 새 통화 클라이언트에 영향을 주지 않도록 소유 키를 확인합니다. 클라우드 Gemini API, API key, Gemma 가중치 또는 서버 추천 endpoint는 추가하지 않았습니다.
- core:data의 ReplySuggestionRepository는 기존 DataModule에서 바인딩합니다. 화자를 구분한 최근 대화와 최신 상대 발화를 최대 1,200자 범위로 구성하고, 20자 안팎의 짧은 문장·맥락에 맞는 말투·서로 다른 후보를 요청합니다. 대화에 없는 개인정보·일정·감정을 지어내지 않도록 지시합니다. 모델의 정확성 자체를 보장하지 않으며 사용자가 확인해 선택해야 합니다. 생성 문장을 글자 수에 맞춰 강제로 자르지 않습니다.
- develop-ai의 android-nano PoC에서 사용한 스트리밍 JSON 응답 방식을 참고했습니다. 미완성 JSON escape와 UTF-16 쌍은 보류하면서 작성 중 문장도 안전하게 해석하고 음성에 불필요한 이모지·채팅용 표현을 정리합니다. 각 후보에 고정 ID·위치와 isComplete를 부여합니다. 작성 중 문장은 비활성 카드로 보여 주고, 닫힌 JSON 문자열로 확정된 후보만 선택할 수 있습니다. 중복 완성 후보는 걸러냅니다. 출력은 8,000자·생성 시간은 30초로 보호하고, 빈 응답·사용량 제한·사용 중·기기 미지원 오류를 구분합니다. 후보가 세 개보다 적으면 실제로 생성된 후보만 보여 줍니다.
- CallViewModel이 Repository Flow를 asResult()로 수집하고 CallUiState에 모델 준비·다운로드·생성 상태와 후보를 반영합니다. 통화 화면이 RESUMED이면 수신·발신 대기 단계부터 자동 확인·사전 준비하고, 실제 통화가 Active이며 준비가 끝난 뒤에만 답변을 생성합니다. 다운로드 완료 후에도 사전 준비를 마쳐야 사용 가능 상태로 반영합니다. 모델 다운로드는 대화 영역의 모델 준비 버튼을 눌렀을 때 요청하며 준비 전에는 다운로드 완료로 표시하지 않습니다. AICore가 이미 다운로드 중이면 상태를 다시 확인할 수 있습니다. 화면을 벗어나 관찰을 취소해도 시스템 다운로드 자체의 취소를 보장하지 않습니다.
- 맞장구만 입력창 위에 남기고 추천 후보는 해당 상대방 발화 아래의 대화 영역에 표시합니다. 후보가 없을 때의 준비·다운로드·오류 안내도 대화 영역에 표시합니다. 마이크 ON에서는 추천 조작을 잠급니다. 마이크 OFF에서는 TTS 준비 여부와 별개로 추천을 입력창에 드래그하거나 접근성의 입력창에서 수정 동작을 사용할 수 있습니다. 탭 전송은 실제 서버 TTS 요청과 LiveKit 전송을 사용합니다. 마이크 상태와 전송 중 여부로 조작 가능 여부를 결정하며 상시 false인 TTS 준비 플래그는 제거했습니다. AI가 임의로 전송하거나 가짜 전송 성공을 만들지 않습니다.
- 기기·AICore·모델 지원은 SDK checkStatus() 결과로 확인합니다. Android 버전만으로 Nano 지원을 판단하지 않습니다. 최초 모델 준비에는 네트워크와 저장 공간이 필요할 수 있지만 추천 입력·생성 결과는 기기 내에서 처리합니다. [공식 연동 문서](https://developers.google.com/ml-kit/genai/prompt/android/get-started) · [지원 기기](https://developers.google.com/ml-kit/genai/#device-support).
- 이 작업에서는 모델 실행·모델 다운로드·실서버 요청·실기기 동작·테스트를 실행하지 않았습니다. SDK 라이브러리 의존성 취득과 앱 컴파일·정적 소스 검토만 수행합니다. 대상 기기의 실제 지원 여부, 한국어 후보 품질, STT와 동시 실행 시 지연·발열·사용량 제한은 미검증입니다.


## 서버 TTS와 텍스트 통화

- 추천 칩 탭·고정 맞장구·직접 입력의 전송 버튼은 CallViewModel → CallRepository.sendTextAudio()라는 하나의 실제 전송 경로를 사용합니다. 통화가 Active이고 마이크 OFF일 때 조작할 수 있으며 마이크 전환·다른 전송·통화 종료 처리 중에는 중복 조작을 막습니다. CallConversation은 초안 편집과 전송할 원문 선택만 담당하며 화면에 가짜 전송 메시지를 추가하지 않습니다.
- 먼저 LiveKit kick-chat-text로 해당 상대 계정에게 원문을 보냅니다. 텍스트 전송이 완료되면 입력한 초안을 비우고, 같은 원문으로 POST api/voice/speech/stream을 호출합니다. 서버는 로그인 계정의 등록된 READY 음성으로 합성합니다. 기존 AccessTokenInterceptor를 사용하며 Repository가 인증 토큰이나 AuthRepository를 직접 참조하지 않습니다.
- 서버의 1회 요청 제한은 최대 50개 grapheme입니다. 긴 입력은 ICU 문자 경계와 가능한 공백·문장 경계에서 분할해 차례로 요청합니다. 원문은 메시지 한 개로 유지하며 각 응답을 하나의 LiveKit kick-speech-pcm / audio/pcm 스트림에 이어 씁니다. 입력창에 20자 제한을 추가하지 않았습니다. 현재 전송 경로는 원문 최대 10,000 UTF-16 단위, 음성 최대 180초 / 5,760,000 bytes로 보호합니다.
- TTS HTTP body는 IO에서 청크 단위로 읽고 취소 시 먼저 닫아 blocking read를 해제합니다. WAV 헤더 없는 16 kHz, PCM16 signed little-endian, mono라는 서버 계약을 사용하며 audio/pcm 응답과 빈 데이터·샘플 바이트 정렬을 확인합니다. Room 수명과 통화 상태에 묶인 전송 작업을 사용해 통화 종료·미디어 끊김·백그라운드·로그아웃에서 HTTP 읽기와 RTC writer를 정리합니다. 실패 중에는 writer를 오류 사유와 함께 닫습니다.
- core:rtc는 입장 전에 텍스트·바이트 스트림 핸들러를 등록하고 LiveKit 송신자 ID를 서버 통화 상대 ID와 대조합니다. 다른 callId 속성, 잘못된 MIME은 처리하지 않습니다. 속성이 없는 기존 명세 클라이언트는 방과 상대 ID를 기준으로 수신할 수 있습니다. 새 앱은 callId와 messageId 속성을 보내며 재전송된 텍스트는 같은 messageId로 중복 기록을 막습니다.
- 수신 PCM은 통화용 AudioTrack MODE_STREAM / USAGE_VOICE_COMMUNICATION으로 순서대로 재생합니다. 청크 경계의 홀수 끝 바이트는 다음 청크에 합칩니다. 정상 EOF에서는 마지막 버퍼 재생까지 기다리고, 실패·취소에서는 pause/flush/release 합니다. 입력 큐와 SDK payload 크기를 제한하며 재생 오류는 통화 연결을 중단시키지 않고 화면에 알립니다. TTS 수신은 로컬 마이크 ON/OFF와 독립적입니다.
- CallTranscriptRepository가 음성 자막·텍스트·전송 상태를 한곳에서 관리합니다. 텍스트 전달 후 음성 합성/전송이 실패하면 메시지에 텍스트 전달됨·음성 전송 실패를 표시합니다. 등록 음성 없음(409), 인증 실패, 네트워크·서버·형식 오류를 모델 오류로 바꾸어 ViewModel의 asResult()에서 처리합니다. UI는 Retrofit 타입에 의존하지 않습니다.
- 실패한 마지막 요청은 수동 재시도할 수 있습니다. 이미 텍스트를 전달했다면 다시 합성·음성 전송만 하며, 텍스트 전송 결과가 불명확하면 동일 messageId로 다시 보냅니다. 자동 합성 재시도는 하지 않습니다. 상대방이 이전 음성 일부를 들었을 가능성이 있으므로 수동 재시도는 음성을 처음부터 다시 보냅니다. 전송 완료 상태는 송신 API 완료를 의미하며 별도 재생 완료 확인 메시지는 추가하지 않았습니다.
- 최신 origin/develop-backend 1305e36d의 ANDROID-HANDOFF.md와 voice.controller.ts를 읽어 서버의 HTTP PCM 응답·50자 제한을 확인했습니다. 기존 Postman fixture의 계약과 과거 증거는 유지했습니다. 이번 작업에서는 Postman·테스트·실서버 호출·음성 합성·모델 다운로드·기기 실행·재생을 수행하지 않았습니다. 앱 컴파일과 정적 검토만 수행했으며 두 기기의 실제 음성 전달·라우팅·지연·스트림 중단 처리는 미검증입니다.


### 대화 내 추천과 글자 표시

- 상대방의 최신 확정 발화에 연결된 추천 그룹을 실제 대화 메시지와 구분해 배치합니다. 생성 중에는 세 자리에서 작성 상태를 보여 주고, 완성된 후보부터 하나씩 선택할 수 있습니다. 사용자 선택 전 추천 자체를 실제 발화로 기록하거나 전송하지 않습니다.
- SDK 청크 수신과 화면 표시 속도를 분리합니다. 카드마다 grapheme 단위로 24.milliseconds 간격을 두어 글자를 추가합니다. 후보의 JSON 문장이 완성되고 표시할 글자도 모두 나타난 경우에만 탭·드래그·접근성 편집을 활성화합니다. 생성 오류·중단에서는 미완성 후보를 제거하고 확정된 후보만 유지합니다.
- 실제 전송·초안 편집에서도 isComplete를 다시 확인합니다. 마이크 ON·전송 중·통화 종료 처리 중 조작 차단과 서버 TTS 경로는 유지합니다. 새 임시 발화가 들어오면 이전 추천을 정리하고 다음 확정 발화에서 새로 생성합니다. 이전 요청의 늦은 결과는 최신 추천을 덮어쓰지 않습니다.
- 추천 높이가 바뀌면 대화 목록의 하단 위치를 맞추고, 드래그 중에는 자동 이동을 멈춥니다. 아래 방향 편집 드래그와 위 방향 대화 스크롤을 분리하며, 제스처 취소·후보 교체·화면 이탈 때 드래그 미리보기를 정리합니다. 원문·TTS·접근성 텍스트에는 표시용 줄바꿈 문자를 넣지 않습니다.
- 작성 중/완성 혼합 Compose Preview를 추가했습니다. 이번 변경도 테스트·기기 실행·모델 추론 없이 앱 컴파일과 정적 검토로만 확인합니다. 실제 애니메이션 속도·스크롤·드래그·키보드 조합은 기기에서 미검증입니다.

### 추천 모델 클라이언트 수명주기

- ReplySuggestionRepository.openModelSession()의 Flow를 CallViewModel의 통화 수명에 맞춰 수집합니다. 화면 재개·마이크 전환·개별 추천 완료만으로 클라이언트를 닫지 않습니다. SDK 인스턴스는 core:ai 안에 유지하며 ViewModel에는 SDK 타입을 노출하지 않습니다.
- 사전 준비는 SDK warmup()을 사용하며 가짜 추천 생성이나 자동 다운로드를 수행하지 않습니다. 사전 준비 중 화면이 백그라운드로 이동하면 취소하고, 재개 시 미완료 준비를 다시 요청합니다. 모델 메모리 유지 여부와 실제 첫 응답 속도는 기기·AICore 상태에 따라 달라질 수 있습니다.
- 이 변경은 컴파일·정적 검토로 확인합니다. 테스트·실기기 실행·모델 호출·시간 측정은 수행하지 않았으며 실제 지연 개선은 미검증입니다.
