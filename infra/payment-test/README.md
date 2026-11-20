# 택배 테스트 결제 시연 (S15P31D109-140)

이 문서는 최초 샘플 시연 서비스용이다. 실제 주문 DB·자동 안내·토스 승인·디버 접수 연결은 [정식 백엔드 결제 계약](../../docs/api/order-payment-integration.md)을 따른다. 아래 `request.mjs` 명령은 계속 샘플만 생성하며 업무 주문을 만들지 않는다.

전용 Mattermost 채널의 택배 안내 메시지 → HTTPS 결제 페이지 → 토스 결제위젯 → 서버 승인 확인을 연결한다. 초기 데이터는 가상 발송인·수령인, 배송 1건, 1,000원이다. 개발자용 샌드박스 링크를 보내지 않는다.

업무 주문을 아직 생성할 수 없는 시연을 위해 Node 24 서비스와 파일 저장소를 별도로 둔다. Nest API, 업무 DB, 마이그레이션, 디버·AI 코드는 변경하지 않는다. 메시지 생성(`message.mjs`), 샘플 데이터·처리(`service.mjs`), 발송·토스 통신(`clients.mjs`)을 분리했다. 실제 주문 상태 변경·환불과 카카오 알림톡 발송은 후속 연동 범위다.

## 키와 설정

`/srv/dva-payment-test/settings`는 서버 전용 파일(600), 상위 폴더는 700이다. 기존에 등록한 **결제 채널 웹훅을 유지**한다. 장애 알림용 `/srv/dva-observability/settings`를 복사하거나 수정하지 않는다. 실제 값은 Git·채팅·명령행 인수에 넣지 않는다.

| 설정 | 용도 |
| --- | --- |
| `MATTERMOST_WEBHOOK_URL` | 기존 결제 전용 채널 웹훅 |
| `PAYMENT_TEST_ENABLED=true` | 시연 서비스 명시적 활성화 |
| `PAYMENT_TEST_PUBLIC_URL` | 공개 결제 페이지 주소, 예시 `https://192.0.2.10/payment-test` |
| `TOSS_TEST_CLIENT_KEY`, `TOSS_TEST_SECRET_KEY` | 동일한 문서용 **결제위젯** 테스트 키 쌍 (`test_gck_`, `test_gsk_`) |
| `PAYMENT_TEST_OPERATOR_TOKEN` | 서버에서 생성한 무작위 내부 실행 토큰 |

공식 샘플의 문서용 키를 사용하려면, 서버의 검토된 저장소 루트에서 다음 명령을 실행한다. **기존 settings에 웹훅이 있어야 한다.** 이미 설정한 값은 유지하며 빠진 항목만 추가한다. 설정을 출력하지 않는다. 샘플 Git 커밋을 고정했고, 파일 형식이 바뀌거나 다운로드가 실패하면 설정을 덮어쓰지 않는다.
기존 settings에 공개 주소가 없으면 현재 환경의 `PAYMENT_TEST_PUBLIC_URL`을 컨테이너에 주입한다.

```bash
sudo --preserve-env=PAYMENT_TEST_PUBLIC_URL docker run --rm --user 0 \
  --env PAYMENT_TEST_PUBLIC_URL \
  --mount "type=bind,src=$(pwd)/infra/payment-test,dst=/setup,readonly" \
  --mount type=bind,src=/srv/dva-payment-test,dst=/settings \
  node:24-bookworm-slim node /setup/configure.mjs
```

직접 설정할 때는 `settings.example`의 항목을 참고하되 기존 파일을 통째로 교체하지 않는다. 라이브 키와 API 개별 연동용 `test_ck_`/`test_sk_`는 거부한다. 클라이언트 키만 브라우저에 제공한다. 문서용 공용 키의 결제 내역은 우리 계정 개발자센터에서 관리할 수 없으므로 이 시연의 승인 결과 화면·저장 상태로 확인한다. 운영 전환에는 별도 가맹점 키와 주문 결제 설계가 필요하다.

## 배포

이 서비스는 Jenkins의 기존 BE 자동 배포 대상과 별개다. Jenkins에서는 테스트·이미지 검증만 수행한다. MR 반영 후 서버에서 명시적으로 설치한다.

```bash
sudo bash infra/payment-test/deploy.sh /srv/dva-payment-test/settings
curl --fail http://127.0.0.1:3002/health
```

Compose는 `127.0.0.1:3002`에만 게시한다. 컨테이너는 UID 1000, 읽기 전용 루트, 128MiB 메모리로 실행한다. 데이터는 `/srv/dva-payment-test/data`에 보관하며 `flock`으로 같은 파일을 두 프로세스가 사용하지 못하게 한다. 배포 시 메시지 발송·결제 승인·업무 DB 변경은 발생하지 않는다.

호스트 Nginx의 **실제 HTTPS 서버 블록**에 `nginx.conf`의 location만 추가한다. 현재 설정에 AI 팀의 통화 관련 경로와 다른 server 블록이 있으므로 파일 전체를 저장소 예제로 교체하지 않는다. 기존 `/internal` 차단을 유지한다. 백업 후 변경하고 아래를 확인한다.

```bash
sudo nginx -t
sudo systemctl reload nginx
curl --fail https://192.0.2.10/api/health
```

HTTP 포트는 기존 HTTPS 리다이렉트를 유지한다. 결제 경로는 접근 로그를 끄며 요청 본문은 8KiB로 제한한다. 이 경로에 쿼리나 본문을 수집하는 디버그 로깅을 추가하지 않는다. 외부에서 `/internal/payment-test/requests`와 `/api/internal/payment-test/requests`가 기존 차단대로 404인지도 확인한다.

## 메시지 1회 발송과 결제 확인

```bash
sudo env PAYMENT_TEST_SETTINGS=/srv/dva-payment-test/settings \
  docker compose -f infra/payment-test/compose.yaml exec -T payment-test node request.mjs
```

실행할 때마다 새로운 샘플 요청을 만들고 결제 채널에 메시지를 한 번 보낸다. 인삿말·감사 인사, 주문번호·발송인·수령인·건수·한국 시간 수거일시·금액·결제하기 링크를 포함한다. 합의대로 **메시지에는 이모지와 테스트 안내 문구를 넣지 않는다. 결제 페이지에는 테스트 표시와 실제 청구 없음 안내를 둔다.**

명령 출력의 `notificationStatus: SENT`를 확인하고 채널의 결제하기 링크를 연다. 토스 테스트 결제수단으로 인증한 뒤 DVA 화면에서 완료를 확인한다. 브라우저 리다이렉트만으로 성공을 표시하지 않고, 서버가 토스 승인 응답의 주문번호·금액·결제 키·통화·완료 상태를 모두 확인한다.

`UNKNOWN`이면 발송 결과를 확정할 수 없다. 채널을 먼저 확인하고 무작정 같은 명령을 반복하지 않는다. 기존 요청에 대한 발송 재시도는 막는다. `REVIEW_REQUIRED` 결제는 페이지의 **결제 결과 다시 확인**으로 조회하며, 승인 API를 다시 호출하지 않는다. 결과가 계속 불명확하면 운영자가 확인한다.

## 보관과 복구

- 결제 링크는 추측하기 어려운 256비트 값이며 24시간 동안 새 승인을 시작할 수 있다. 링크를 아는 사람은 해당 가상 요청을 볼 수 있으므로 링크 자체도 공유 범위를 제한한다. 실제 개인정보를 샘플에 입력하지 않는다.
- 파일에는 샘플 정보, 상태, 결제 확인용 키·요청 키, 승인 시각만 저장한다. 전체 토스 응답·카드 정보·시크릿 키·웹훅은 저장하지 않는다.
- 승인 전 `CONFIRMING`을 디스크에 기록한다. 재기동 시 `REVIEW_REQUIRED`로 전환하고 토스 GET 조회만 허용한다. 승인 응답 후 로컬 저장에 실패한 경우도 동일하게 처리한다.
- 메시지 전송 중 재기동하면 결과를 `UNKNOWN`으로 둔다. 서비스 재기동이 재발송을 일으키지 않는다.
- 저장 파일은 최대 500건이며 자동 삭제하지 않는다. 용량 제한에 도달하면 진행 중·결과 미확인 결제를 먼저 정리하고 운영자가 보관 후 새 시연 저장소로 교체한다. 서비스 실행 중 파일을 수정·삭제하지 않는다.
- 시연 종료 시 같은 Compose 명령으로 `stop`하고 Nginx location을 제거한다. 데이터·설정은 별도로 보관 여부를 결정한다. 컨테이너를 지워도 호스트 데이터는 남는다.

## 검증

Jenkins 에이전트와 Docker 데몬은 서로 다른 파일시스템을 사용한다. 검사 스크립트는 파일을 `docker cp`로 임시 컨테이너에 전달하므로 에이전트 경로를 데몬에 bind mount하지 않는다. Bash·설정 초기화·Nginx 검사를 각각 수행하고, 설정 초기화 재실행은 같은 컨테이너의 저장 결과를 사용해 검증한다. 임시 컨테이너와 이미지는 종료 시 정리한다.

2026-10-30 추가 검증: 실제 Jenkins 에이전트의 별도 임시 디렉터리에서 기존 bind 경로 오류를 재현한 뒤, 수정한 Docker 검사 전체의 통과를 확인했다. 정식 Jenkins 파이프라인의 재실행·배포 결과는 수정 MR 반영 후 확인한다.

```bash
# 신규 결제 테스트는 기존 backend check에도 포함된다.
cd backend
npm run test:payment
cd ..
node infra/payment-test/check.mjs

# 별도 터미널에서 모형 외부 API 실행, 이후 실제 서비스 HTTP 검증
postman simulation run postman/simulations/payment-test/payment-test.sim.yaml --port 4598 --output ndjson --no-history
node postman/simulations/payment-test/verify.mjs
```

설치된 Playwright와 Chrome이 있으면 `PAYMENT_TEST_PLAYWRIGHT_MODULE`, `PAYMENT_TEST_CHROME_PATH`를 해당 경로로 지정하고 `node backend/payment-test/test/browser.mjs`를 실행한다. 위 Postman 시뮬레이션이 먼저 실행되어 있어야 한다. 브라우저의 토스 SDK는 모형으로 대체하며 실제 토스 결제창 인증을 검증하는 테스트는 아니다.

2026-10-30 확인: HTTP 통합 테스트 21개, Postman의 정상·불명확·거절 흐름, Chrome의 결제·취소·재조회·375px 화면, Docker·Compose·Nginx·프로세스 잠금 검증 통과. 문서용 클라이언트 키로 실제 토스 SDK·결제수단 위젯 로딩도 확인했다. 위젯의 동적 iframe 크기 설정에 필요한 스타일 속성만 CSP에서 허용하며 인라인 스크립트는 차단한다. 실제 서버 배포, 실제 Mattermost 수신 및 문서용 키로 토스 테스트 인증·승인 완료는 배포 후 확인한다.

## 외부 계약 근거

- [토스 결제위젯 V2 연동](https://docs.tosspayments.com/guides/v2/payment-widget/integration)
- [토스 승인·조회 API 및 Payment 객체](https://docs.tosspayments.com/reference)
- [토스 공식 샘플과 문서용 키 안내](https://github.com/tosspayments/tosspayments-sample/tree/8d0df11d14dadfe355050bdc9ba38618f6a9c028/express-javascript)
- [Mattermost Incoming Webhooks](https://docs.mattermost.com/integrations-guide/incoming-webhooks)
- [내부 HTTP 계약](../../backend/payment-test/CONTRACT.md)
