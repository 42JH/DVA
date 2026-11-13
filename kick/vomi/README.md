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
- `core:data`: domain에 정의할 인터페이스의 구현, network / database / datastore 연결
- `core:network`, `core:database`, `core:datastore`, `core:datastore-proto`: 데이터 소스 설정
- `core:designsystem`, `core:ui`: 기본 테마와 공통 UI
- `core:navigation`: Navigation 3 상태와 Navigator
- `core:notifications`: 알림 모듈 골격 (Firebase 미연결)
- `feature:home:api`: 직렬화 가능한 HomeNavKey
- `feature:home:impl`: 친구 목록, HomeViewModel / HomeUiState와 EntryProvider 등록 함수

Feature API는 화면 진입 규약을 공개하고, 구현 화면은 impl 내부에 둡니다.
app에서 각 기능의 API / impl을 연결합니다. 기능 모듈끼리는 다른 기능의 impl을 참조하지 않습니다.
의존 방향은 `feature impl → domain ← data`, `domain → model`입니다.
app은 Hilt 구현 수집을 위해 data를 참조합니다.

친구 목록은 샘플 데이터로 표시하며, Repository, API 서비스,
DB 테이블, Proto 메시지, Firebase 설정 등 실제 기능은 포함하지 않습니다.
빈 소스 디렉터리는 Git에 저장되지 않으며, 기능 추가 시 소스 파일과 함께 생성하면 됩니다.

## 디자인 시스템

Compose Material 3에 직접 의존하지 않고 Motif에서 이식한 Foundation 기반 컴포넌트를 사용합니다.
`VomiTheme`은 자체 색상, Pretendard / Paytone One 타이포그래피, 기본 본문 스타일과 글자색을 제공합니다.
`Text`, `Surface`, `Button`, `Icon`, `IconButton`, `Scaffold`, Divider, Tab / TabRow,
LoadingWheel, BottomSheet 및 GlassSurface를 `core:designsystem`에서 재사용할 수 있습니다.

`VomiBackground`를 화면 컨테이너로 사용하면 검정에서 푸른 회색과 갈색으로 이어지는 통화 배경이 적용됩니다.
배경은 화면 전체에 그려지고, 자체 `Scaffold`는 safeDrawing 인셋을 콘텐츠에 전달합니다.
현재 시작 화면에는 공통 배경 위에 친구 목록을 표시합니다. 친구 선택 시 스크리닝 화면 미리보기로 이동합니다.
`DesignSystemPreview`에서 이식한 기본 컴포넌트를 미리 볼 수 있습니다.

Android Studio Preview에 필요한 ui-tooling은 debugImplementation으로만 연결합니다.
해당 디버그 도구가 Material 3를 간접 포함하지만, 앱 UI는 이를 사용하지 않으며
releaseRuntimeClasspath에는 Material 3 컴포넌트 라이브러리가 포함되지 않습니다.

## 친구 목록

`core:model`의 `Friend`는 ID, 이름, 프로필 이미지 URL을 담는 공통 데이터 모델입니다.
HomeViewModel이 StateFlow<HomeUiState>를 제공하고, HomeScreen은 lifecycle에 맞춰 상태를 수집합니다.
HomeUiState는 Loading / Success / Error로 구분하며 빈 목록, 오류 및 큰 글자 미리보기도 제공합니다.
샘플 친구 8명을 표시하며 프로필 이미지가 없거나 로드에 실패하면 기본 이미지를 사용합니다.
추후 HomeEntryProvider의 onFriendClick 콜백에 친구 ID를 받아 통화 화면으로 연결할 수 있습니다.
클릭 콜백은 스크리닝 화면으로 연결되며, 로그인 / 검색 / 친구 추가는 포함하지 않습니다.

## 스크리닝 화면 (화면·상태 구현 단계)

- `feature:call:api`의 CallNavKey와 `feature:call:impl`의 CallViewModel / CallUiState로 구성합니다.
- 친구의 ID와 이름을 전달해 화면을 열며, 종료 또는 뒤로 가기로 친구 목록에 돌아갑니다.
- 마이크 ON 상태에서는 텍스트 편집·전송·추천 선택을 UI와 ViewModel 모두에서 차단합니다. 기존 초안은 유지합니다.
- 추천·맞장구 칩은 한 행으로 가로 스크롤되며, 칩 안의 문장은 최대 두 줄로 표시합니다. 모든 칩과 영역의 높이는 두 줄을 기준으로 고정합니다. 선택하면 초안에 반영되고, 사용자가 전송해야 대화에 추가됩니다.
- 직접 입력하는 답변에는 20글자 제한을 두지 않습니다. 추천 문구는 최대 20글자를 고려한 샘플입니다.
- 맞장구는 고정 문구이며, 마이크 상태와 관계없이 선택 즉시 대화에 추가합니다.
- 이름 왼쪽 버튼은 샘플 요약을 보여주는 바텀시트를 엽니다. 요약 화면에서도 미리보기 타이머는 유지됩니다.
- CallNavKey의 `isIncoming = true`로 수신 UI에 진입할 수 있고, 수락·거절 상태와 Preview를 제공합니다.
- 실제 RTC / 마이크 캡처 / STT / TTS / 온디바이스 AI / 요약 생성 / FCM·시스템 알림 수신은 미연결 상태입니다.
  입력과 맞장구는 로컬 화면 상태에만 반영되며 음성 재생·상대방 전송은 하지 않습니다.
- 실제 오디오·알림을 사용하지 않으므로 이 단계에서는 마이크·알림 권한이나 foreground service를 추가하지 않습니다.

```powershell
.\gradlew.bat :app:assembleDebug :feature:call:impl:testDebugUnitTest :feature:call:impl:lintDebug
```

스크리닝 화면은 이름 옆에 작은 통화 시간을 표시합니다. 추천/맞장구 전환은 칩 대신 아이콘과 선택 표시로 구분하고, 문장 칩 목록은 한 행·가로 스크롤로 배치하고, 칩 안의 문장은 최대 두 줄까지 표시합니다. 버튼은 보이는 원을 36dp로 줄이되 터치 영역은 48dp로 유지합니다.

키보드 인셋은 앱 NavDisplay의 imePadding에서만 적용합니다. Scaffold에는 시스템 바·디스플레이 컷아웃 여백만 전달하며, 이미 적용한 여백을 consumeWindowInsets로 소비합니다. Activity는 adjustResize를 사용합니다.
추천과 맞장구는 두 줄 문장을 수용하는 같은 높이의 한 행 칩 영역을 공유하므로 모드를 전환해도 입력창 위치가 바뀌지 않습니다. reduced viewport Preview는 키보드로 줄어든 화면 높이를 확인하기 위한 예시이며 실제 IME 애니메이션 검증을 대체하지 않습니다.
참고: https://developer.android.com/develop/ui/compose/system/insets-ui

칩의 한글 문장은 표시할 때만 음절 사이에 줄바꿈 가능 지점(U+200B)을 추가해 남은 가로 폭을 채우며 이어집니다. 원문과 접근성 텍스트에는 적용하지 않으므로 초안·전송·향후 TTS에는 원래 문장을 사용합니다. 이모지·결합 문자·구두점은 분리하지 않습니다.
참고: https://www.unicode.org/reports/tr14/#LB8
