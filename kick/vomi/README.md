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
- `feature:home:impl`: 빈 홈 화면과 EntryProvider 등록 함수

Feature API는 화면 진입 규약을 공개하고, 구현 화면은 impl 내부에 둡니다.
app에서 각 기능의 API / impl을 연결합니다. 기능 모듈끼리는 다른 기능의 impl을 참조하지 않습니다.
의존 방향은 `feature impl → domain ← data`, `domain → model`입니다.
app은 Hilt 구현 수집을 위해 data를 참조합니다.

화면의 중심에 앱 이름만 표시하는 실행 확인용 구성이며, ViewModel, Repository, API 서비스,
DB 테이블, Proto 메시지, Firebase 설정 등 실제 기능은 포함하지 않습니다.
빈 소스 디렉터리는 Git에 저장되지 않으며, 기능 추가 시 소스 파일과 함께 생성하면 됩니다.
