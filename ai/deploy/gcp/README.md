# GCP 리랭커 운영

2026-11-02 사용자 요청으로 구축 후 자동 중지 시간을 **30분(1800초)/STOP**으로 변경했다.
이후 VM을 켤 때마다 적용되며 모델 준비 시간도 포함한다. 아래 최초 구축의 15분/900초 표기는 당시 이력이다.

2026-10-27 사용자 승인: GCP L4, 총예산 $250, 최초 구축은 완료까지 허용, 이후 VM을 켤 때마다15분 자동 중지. 전화 한 통의15분 제한이 아니다.

## 배포 자원

| 항목 | 값 |
|---|---|
| 프로젝트 | dvr-rerank |
| VM | dvr-reranker-l4 |
| 영역 | asia-northeast3-a (서울) |
| 머신 | g2-standard-4 / L4 1개 / vCPU4 / RAM16GB |
| 부팅 디스크 | pd-balanced 60GB |
| 고정 외부 IP | 35.216.116.177 (Standard tier) |
| HTTPS 루트 | https://35.216.116.177.sslip.io |
| API | POST /rerank, GET /health |
| 관리 접속 | Google IAP SSH, 전용 VPC에서35.235.240.0/20만22허용 |
| 외부 공개 | 80/443.8001은 VM의127.0.0.1에만 바인딩 |
| GPU 모델 | Qwen/Qwen3-Reranker-0.6B, revision e61197ed45024b0ed8a2d74b80b4d909f1255473 |
| 계산 | torch2.7.1+cu128, transformers4.52.4, FP16, 원문A, 최대1024토큰 |

API 키는 VM의 root 전용 `/etc/dvr-reranker/runtime.conf`에서 생성한다. 저장소·로그·채팅에 복사하지 않는다. 초기 구축의4시간 안전 중지는 구축 후900초/STOP으로 변경했다. 최종 확인 상태는 TERMINATED다. 자동 중지는 플랫폼 특성상 시작이 최대30초 지연될 수 있고 종료 처리에도 시간이 든다. 30초 제한 시험에서 중지 완료까지 약67초였으며, 재시작 후 모델 준비는 약56초로 관측했다. 이 값은 한 번의 관측이며 즉시 기동을 보장하지 않는다.

2026-10-31 관리 FAQ 등록용 `POST /validate-documents`를 실제 VM에 배포했다. 이미지8a5ce26a8218, 고정 Qwen 모델/리비전 유지. 인증 없는 요청401, 긴 원문422, 짧은 원문 정상 검증과 기존 리랭킹9요청을 확인했다. 예열5회 평균0.0997초, 동시3건 평균0.1832초/최대0.2565초다. 작은 점검 표본이며 전체 검색/통화 지연 측정은 아니다. 결과는 `data/private/gcp/reranker-check-20261031.json`이다. 등록은 질문 예비256토큰+여유32토큰을 확보하고 실제 요청도 전체1024토큰을 재검사한다. FAQ 최초 이전·회귀평가 전까지 관리 플래그는 비활성이다.

갱신 전 이미지는 `dvr-reranker:before-faq-validation`, 소스는 `/opt/dvr-reranker/source-before-faq-validation.tar.gz`에 보존했다. 첫 SCP는 기동 직후 연결 종료로 실패했고 SSH 정상 확인 후 재전송했다. 비밀값은 변경하지 않았다.

## 매일 켜고 끄기

Cloud Console에서 VM의 **시작/중지** 버튼을 눌러도 된다. 중지하면 모델의 GPU 메모리는 비워지지만 디스크의 이미지·모델·인증서는 유지된다. 다시 시작하면 Docker 서비스가 자동으로 모델을 올린다. /health가200이 된 뒤 시험한다. 삭제 버튼은 누르지 않는다.

PowerShell의 CLI로도 제어할 수 있다.

```powershell
gcloud.cmd compute instances start dvr-reranker-l4 --project=dvr-rerank --zone=asia-northeast3-a
gcloud.cmd compute instances stop dvr-reranker-l4 --project=dvr-rerank --zone=asia-northeast3-a
```

등록된30분 제한은 시작할 때마다 적용된다. 준비 시간도 포함하며 진행 중인 전화가 있어도 자동 중지는 기다려주지 않는다. 기존 전화 서버는 이때 검색 오류로 안내하고 접수 상태를 유지하도록 구현돼 있다. 자동으로 요청이 VM을 깨우는 구조는 아니다.

## 이 PC에서 연결

`data/private/gcp/state.json`에는 공개 접속 정보, `api-key.dpapi`에는 이 Windows 사용자만 복호화할 수 있는 키가 있다. 둘 다 Git에서 제외된다. 키가 없으면 Google 인증 SSH로 서버에서 읽어 암호화해서 보관한다. .env는 수정하지 않는다. 자식 프로세스에 RAG_RERANKER_URL/API_KEY를 주입하고 종료 후 원래 환경을 복구한다.

PowerShell의 스크립트 실행이 제한된 PC에서는 다음 명령으로 **이 실행에 한해** 저장소 스크립트를 실행한다. 시스템 전체 실행 정책을 변경하지 않는다. ai/에서 실행한다.

```powershell
# GPU만 점검: OpenAI/PBX/DB 호출 없음
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/gcp/with-gpu.ps1 -Module scripts.check_remote_reranker

# 실제 RAG 검색: 질문 임베딩 API 비용과 기존 DB 읽기 발생, 답변/전화 생성 없음
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/gcp/with-gpu.ps1 -Module scripts.search_manual "택배를 착불로 보낼 수 있나요?"

# 기존 웹 실험 화면: 화면에서 사용자가 연결 시작을 눌러야 Live 세션 생성
powershell.exe -NoProfile -ExecutionPolicy Bypass -File deploy/gcp/with-gpu.ps1 -Module scripts.run_live_lab
```

Windows PowerShell5.1은 한국어 native stdout 인코딩이 다를 수 있어 PowerShell7을 권장한다. Python 자식 stdout은 UTF-8로 고정했다. 다른 PC에는 원시 키 파일을 공유하지 말고 인증된 운영자 경로로 발급/주입한다. 로컬 암호화 파일을 다른 PC에 복사해도 같은 사용자 DPAPI 키가 없으면 복호화할 수 없다.

실제 운영 AI 서버에는 HTTPS 루트와 API 키를 **배포 비밀값**으로 설정해야 한다. GPU 서버의 GCP 로그인만으로 다른 호스트의 Jenkins credential이나 실행 중인 AI 프로세스 환경을 바꾸지는 않는다. 이 문서의 구축 확인은 로컬 실제 RAG→GCP 경로이며 PBX 실제 통화 검증과 구분한다.

## 비용 관리

전용 프로젝트 예산 `dvr-rerank-credit-250usd`를 생성했다. 원화 결제 계정이므로 Google 공식 카탈로그 환산율1USD=1358.7500003278KRW 기준으로339,687KRW를 설정했다. 2026-10-27부터의 누적 예산이며 매달250달러로 초기화하는 설정이 아니다.

크레딧을 차감하기 **전** 사용 비용을 보고50/80/90/100%에서 기본 결제 관리자 알림을 보낸다. 크레딧으로 청구액이0이어도 사용 비용을 확인할 수 있다. 이 예산은 dvr-rerank 프로젝트 범위이며 다른 프로젝트 비용/다른 계정의 크레딧 잔액은 관리하지 않는다.

예산 알림은 지출을 차단하지 않는다. Compute Engine은 현재 공식 spend cap 지원 서비스 목록에 없으며 비용 집계와 통지에도 지연이 있다. $250에서의 정확한 하드 차단을 보장하지 않는다. Google 청구 환산율이 바뀌면 달러 환산도 재확인한다. VM을 중지해도 디스크와 고정 IP 등의 비용은 남으므로 장기간 사용하지 않으면 별도 정리가 필요하다.

## 설치/갱신 구조

- `provision.ps1`: 예산·전용 네트워크·고정IP·VM 생성. 기존 VM이 있으면 덮어쓰지 않고 중단한다.
- `bootstrap.sh`: 최초 GPU 드라이버·Docker·NVIDIA container toolkit·키 생성. 완료 파일이 있으면 다음 부팅에서 재설치하지 않는다.
- `bundle.py`: 코드12개만 묶는다. 키·문서·실험·가중치는 전송하지 않는다.
- `install.sh`: 고정 Docker 이미지 빌드→고정 모델 다운로드→systemd서비스.
- `proxy.sh`: Caddy의 공인 인증서/HTTPS. 인증서와 모델 캐시는 디스크에 보존한다.
- `remote.ps1`: Windows gcloud.cmd 중첩 따옴표를 피하는 고정 스크립트 전송. base64는 비밀 암호화가 아니라 명령 전달 형식이다.
- `control.ps1`: 시작할 때30분/STOP을 확인하고, 이미 실행 중이면 타이머를 연장하지 않는다.

전화용 Dockerfile은 GPU 파일을 제외한다. GPU 이미지는 `gpu/Dockerfile`로 별도 만들며 공식 베이스 이미지를 digest로 고정했다. 실제 VM에서는26KB 미만의 배포 소스만 사용했고 모델은 Hugging Face 공개 저장소에서 직접 받았다.

## 구축 점검 기록

- 인증 없는 실제 HTTPS 요청401, 고정 모델/버전, 후보5개 ID·원문 보존 검사 통과.
- 실제 외부 GPU9요청: 첫 요청0.106초, 예열 단건5개 평균0.0686초/표본p95=0.0697초, 동시3건 평균0.1253초/최대0.1838초. 네트워크 왕복 포함. 같은 질문의 작은 점검이며 전체 성능 보증이 아니다.
- 실제 로컬 RAG3질문: 요금·택배사·착불 모두 기대 FAQ가1위. 전체 검색1.329/0.471/0.366초. 임베딩0.972/0.206/0.174초, 원격리랭킹0.203/0.094/0.136초. 초기 한 건에서3.42초도 관측돼 초기 연결 비용을 매번 고정 지연으로 일반화하지 않는다.
- /health 공인 인증서 검증 통과, L4에서 torch CUDA=True, 모델 로드 후 GPU메모리약1480MiB 확인.
- GPU만 호출한 점검은 OpenAI/PBX 호출 없음. 실제 RAG 연결은 기존 승인 범위에서 공개 질문4회 임베딩과 DB 읽기만 수행했고 DB/원본/95문항 점수는 변경하지 않았다.
- 결과 원본은 `data/private/gcp/reranker-check.json`, `rag-connection-check.json`에 보존한다. 키는 결과에 포함하지 않는다.

실제 PBX 전화·Live 답변 내용·독립95문항 재평가는 이번 배포 점검에 포함하지 않았다. 기존 로컬 Qdrant1.13.4/client1.19.1 경고는 보존했으며 버전 변경/데이터 재등록은 하지 않았다.

## 공식 근거

- https://docs.cloud.google.com/compute/docs/instances/limit-vm-runtime
- https://docs.cloud.google.com/compute/docs/gpus/install-drivers-gpu
- https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
- https://docs.cloud.google.com/iap/docs/using-tcp-forwarding
- https://docs.cloud.google.com/billing/docs/how-to/budgets-spend-caps
- https://caddyserver.com/docs/automatic-https
