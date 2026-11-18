# 온디바이스 통화 PoC

한국어로 상대방 역할을 말하면 Android의 기기 내 음성 인식으로 자막을 만들고, 선택한 모델이 답변 후보 3개를 추천합니다. Gemini Nano와 Gemma 4 E2B에 같은 시스템 프롬프트와 최근 대화 최대 800자를 전달합니다. 후보는 생성 중 글자가 이어서 표시되고, 한 후보가 완성되는 즉시 선택할 수 있습니다.

## Windows에서 빌드

JDK 17 이상과 Android SDK의 API 36, Build Tools 35.0.0, Platform Tools가 필요합니다. Android SDK 명령줄 도구의 `sdkmanager`로 설치할 수 있습니다. `ANDROID_HOME`을 SDK 폴더로 지정한 뒤 이 디렉터리에서 실행하세요.

```powershell
.\gradlew.bat assembleDebug
adb install -r .\build\outputs\apk\debug\NanoCallPoc-debug.apk
```

Android SDK와 모델 가중치는 각 환경에서 준비합니다. `adb`가 PATH에 없다면 Android SDK의 `platform-tools/adb`를 사용하세요. 이전 디버그 APK와 서명이 다르면 Android가 덮어쓰기를 거부하므로 기존 설정과 모델이 있는 기기에서는 설치 전에 서명을 확인하세요.

## 휴대폰에서 실행

**설정 → 시스템 프롬프트**에서 **친구**, **부모님**, **격식**을 고를 수 있습니다. 문구를 편집하고 **저장**을 누르면 선택과 각 프리셋의 편집 내용이 기기에 저장됩니다.

**답변 길이**는 **짧게**, **상황에 맞게**, **자세히** 중 고릅니다. **짧게**는 공백 포함 25자 이내를 목표로 한 문장을 요청합니다. **내 정보**에 입력한 말투와 표현 예시는 모델이 참고합니다. 저장한 이름과 전화번호는 최신 발화에 해당 정보와 관련된 표현이 있을 때만 모델에 전달합니다.

1. 상단 **설정**에서 답변 모델을 선택합니다. **Gemini Nano**를 선택한 경우 **기기 지원 확인**을 누릅니다. **다운로드 가능**이면 모델을 내려받습니다. **Gemma 4 E2B (GPU)**를 선택한 경우 약 2.6GB의 Android 모델을 휴대폰에 내려받고 **Gemma 모델 파일 선택**으로 엽니다. 앱이 파일을 복사하고 GPU 모델을 로드하므로 그만큼의 추가 저장 공간이 필요합니다. 다음 실행부터는 **Gemma 로드**를 누르면 됩니다. [Android용 Gemma 모델](https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/blob/main/gemma-4-E2B-it.litertlm)
2. **마이크 시작**을 누르고 마이크 권한을 허용합니다. 한국어 음성 팩 안내가 뜨면 **한국어 음성 팩 준비**를 누르고 다운로드한 뒤 다시 시작합니다. 기기 내 마이크 인식은 Android 12 이상에서 지원되는 음성 서비스가 필요합니다.
3. “금요일 오후 두 시에 회의 가능하세요?”라고 말하고 잠깐 쉬세요. 자막이 확정되면 마이크를 켜 둔 상태에서 답변을 생성합니다. “오후 세 시로 바꿔도 될까요?”라고 이어서 말하면 최신 대화로 추천을 갱신합니다. 후보를 누르면 **나**의 발화로 기록됩니다.
4. 텍스트로 시험할 때는 화면 아래에 상대방 메시지를 입력하고 **보내기**를 누릅니다. **설정**에서는 시스템 프롬프트와 대화를 편집하거나 **예시 대화 넣기 → 답변 3개 생성**을 실행할 수 있습니다. ML Kit는 화면 맨 앞의 앱에서 생성 요청을 처리하므로 측정 중에는 PoC 앱을 열어 둡니다.

[ML Kit Prompt API](https://developers.google.com/ml-kit/genai/prompt/android/get-started) · [지원 기기와 실행 조건](https://developers.google.com/ml-kit/genai) · [Android SDK 명령줄 도구](https://developer.android.com/tools/sdkmanager)

## 코드 위치

- [MainActivity.kt](src/main/java/com/kick/nanopoc/MainActivity.kt)에서 대화 상태, 모델 선택, 생성 요청과 스트리밍, 시간 측정을 처리합니다.
- [LocalSpeech.kt](src/main/java/com/kick/nanopoc/LocalSpeech.kt)에서 한국어 기기 내 음성 인식을 처리하고, [KoreanSpeechText.kt](src/main/java/com/kick/nanopoc/KoreanSpeechText.kt)에서 질문 단서가 뚜렷한 확정 자막의 물음표를 보완합니다.
- [MobileGemma.kt](src/main/java/com/kick/nanopoc/MobileGemma.kt)에서 Gemma 모델 파일을 가져오고 LiteRT-LM GPU 엔진을 실행합니다. Nano는 MainActivity에서 ML Kit Prompt API를 호출합니다.
- [ChatScreen.kt](src/main/java/com/kick/nanopoc/ChatScreen.kt)에서 자막, 채팅, 생성 중인 후보를 표시합니다. [PromptPreset.kt](src/main/java/com/kick/nanopoc/PromptPreset.kt), [ReplyProfile.kt](src/main/java/com/kick/nanopoc/ReplyProfile.kt), [SpokenReply.kt](src/main/java/com/kick/nanopoc/SpokenReply.kt)에 말투, 개인화, 음성용 문장 정리가 있습니다.

## 이어서 검증할 항목

1. **v0.13 실기기 측정.** 이전 버전에서 Nano의 추천 세 개가 한 번 약 3.1초에 생성됐습니다. v0.13에서는 첫 글자, 첫 후보를 선택할 수 있는 시점, 전체 생성 시간을 표시합니다. 음성 입력에서는 인식기가 말이 끝났다고 알린 시점부터 자막 확정 및 첫 후보 선택까지도 잽니다. 실제로 말이 끝난 뒤 인식기가 이를 감지하기까지 걸린 시간은 이 수치에 들어가지 않습니다. v0.13은 빌드까지 확인했으며 Nano·Gemma의 동일 조건 실측은 남아 있습니다.
2. **속도와 답변 품질을 같은 입력으로 비교.** 모델 로드 후 같은 휴대폰, 같은 프리셋·답변 길이로, 대화를 초기화하고 모델별로 각 입력을 3회 이상 반복합니다. 먼저 텍스트로 모델 응답을 비교하고, 같은 내용을 마이크로 넣어 자막도 확인합니다.

   | 입력 | 확인할 점 |
   | --- | --- |
   | 무슨 돈가스 먹었어. | 종류를 묻는 말로 이해하는지, 대화에 없는 메뉴를 지어내지 않는지 |
   | 금요일 오후 두 시에 회의 가능하세요? → 오후 세 시로 바꿔도 될까요? | 금요일과 오후 세 시를 함께 유지하는지, 내 일정이 비어 있다고 가정하지 않는지 |
   | 오늘 완전 망했어. | 친구 프리셋에서 자연스러운 반말을 쓰는지, 후보 세 개가 같은 뜻을 반복하지 않는지 |

3. **빠른 응답과 TTS.** 다음 기능으로 편집 가능한 고정 답변, 후보 1개와 3개의 속도 비교, 선택한 문장의 한국어 기기 내 TTS 재생을 검토합니다. 현재 Android PoC의 입력은 마이크나 텍스트이고, 후보를 고르면 채팅에 기록됩니다. TTS 재생, 상대 전화로의 음성 전송, 실제 통화 연결은 후속 작업입니다.
