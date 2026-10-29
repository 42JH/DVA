# BE 로그와 모니터링

관련 이슈: [S15P31D109-112](https://ssafy.atlassian.net/browse/S15P31D109-112)

## 범위와 구성

BE의 요청·접수 결과 로그, PostgreSQL의 SQLSTATE·심각도, 컨테이너 Nginx의 응답 상태를 수집한다.
AI 로그·음성 연결·RAG·AI 도구 오류, FE 브라우저 오류, 서버 전체 중단을 외부에서 감지하는 구성은 제외한다.
기존 `/health/ready`는 AI를 포함하는 배포 점검 계약을 유지한다. 관측 지표는 AI 연결과 독립적이다.
DB 스키마와 기존 감사 기록(audit_logs)은 변경하지 않는다.

```text
BE / DB / Nginx stdout ─ Docker 읽기 중계기 ─ Alloy ─ Loki ─┐
BE 내부 지표 ──────────────────────── Prometheus ──────── Grafana
서버 CPU·메모리·디스크 I/O / Nginx 프로브 ─ Alloy ───────────┘
                                                     └ Mattermost 비공개 채널
```

앱 배포와 별도 Compose 프로젝트 `dva-observability`로 운영한다. 일반 BE 배포로 관측 환경을 재시작하지 않는다.
Grafana만 `127.0.0.1:3001`에 바인딩하고 호스트 HTTPS `/grafana/`로 접근한다.
Loki·Prometheus·Alloy·Docker 읽기 API는 포트를 공개하지 않는다.
Prometheus는 기존 `dva-prod_web_net`에서 `/internal/metrics`를 읽고, 외부 Nginx 경로에서는 지표를 차단한다.
8 GiB 서버를 기준으로 전체 메모리 상한 약 1.72 GiB, CPU 상한 합계 1.9를 설정했다.
이는 실제 사용량 보장이 아니므로 적용 후 RSS·응답 지연을 확인한다.

## 로그 기준

- BE는 한 줄 JSON, 시간은 ISO 8601 UTC로 기록하고 Grafana에서 한국 시간으로 표시한다.
- 공통: `timestamp`, `service`, `environment`, `level`, `event`.
- 요청: 검증된 UUID `requestId`, 등록된 경로 템플릿, 메서드, 응답 코드, 처리 시간.
- 접수: `orderSeq`, 처리 결과, 고정된 실패 사유. 요청 ID로 외부 호출 로그와 연결한다.
- 요청·응답 본문, 쿼리 문자열, 헤더, 쿠키, 전화번호, 이름, 주소, 대화, 프롬프트,
  녹취 URL, Error.message/stack, SQL·매개변수, 비밀키는 BE 로그에 포함하지 않는다.
- 알 수 없는 프레임워크 로그는 원문 대신 `application_message`로 기록한다.
  시작 실패 시에는 값 대신 잘못된 환경변수 이름만 제공한다.
- DB 중앙 로그는 오류 문장 대신 SQLSTATE·심각도만 남긴다. SQL/DETAIL/매개변수 출력을 줄이는 PG 설정도 적용한다.
  PostgreSQL 자체 오류 문장에는 값이 포함될 수 있으므로 **로컬 Docker DB 로그까지 완전 마스킹된 것으로 취급하지 않는다.**
  호스트 원본 로그 접근은 운영 담당자로 제한하고 원본을 채널에 복사하지 않는다.
- Nginx는 주소·IP·referer·user-agent·요청 URL을 제외한 access log만 중앙 수집한다.
  호스트 Nginx 원본 error log는 중앙 수집 대상이 아니다.
- Loki 라벨은 `service`, `environment` 두 개만 사용한다. 요청·주문·통화 ID는 라벨로 만들지 않는다.

### 테스터 상세 로그

현재는 테스터 번호·본문·임의 헤더로 로그를 해제하는 기능을 제공하지 않는다.
PBX에서 확인된 통화 정보는 종료 후 도착하고, AI 서비스 인증도 MVP에서 생략되어 있다.
따라서 통화 중 요청이 실제 테스터의 것임을 보장하는 시작 정보 연결이 확보되기 전까지 기본 제외 기준을 유지한다.
테스터 허용 목록과 신뢰 가능한 통화 연결은 후속 적용 항목이다. 키·토큰·비밀번호는 예외 대상이 아니다.

## 장애 알림

Grafana가 조회한 수치가 0보다 크면 해당 규칙이 작동한다. 서비스·장애 종류별로 묶어서
최초 30초 그룹 대기 후 보내고, 같은 장애가 지속되면 24시간마다 반복한다. 복구 메시지는 보내지 않는다.
평가 주기는 30초이므로 감지 시각은 임계 시간과 정확히 일치하지 않을 수 있다.

| 장애 | 조건 |
| --- | --- |
| BE 중단/응답 실패 | `/health` HTTP 프로브 실패가 1분 지속 |
| DB 연결 실패 | BE 수집은 정상이고 DB 연결 실패가 1분 지속 |
| Nginx 중단/응답 실패 | Nginx HTTP 프로브 실패가 1분 지속 |
| 디버 인증 거절 | `AUTH_FAILED` 상태인 주문 존재 |
| 접수 결과 불명 | `REVIEW_REQUIRED` 상태인 주문 존재 |
| 접수 지연 | `SUBMITTING`이며 최종 변경 시각에서 1분 경과 |
| 접수 API 서버 오류 | 주문 생성·수기 생성·최종 접수 API의 최근 5분 5xx |

일반 입력 오류·4xx·고객 취소·CPU/메모리/디스크 사용량은 Mattermost 알림 대상이 아니다.
`AUTH_FAILED`·`REVIEW_REQUIRED`는 HTTP 201일 때도 감지한다. 주문 지표는 DB를 읽기만 하며
관측기가 주문을 취소하거나 접수 상태를 변경하거나 디버 요청을 재전송하지 않는다.
상태별 주문 수는 과거 주문도 포함하므로 첫 적용 때 기존 미해결 주문으로 알림이 발생할 수 있다.
이 알림은 해당 상태의 주문이 남아 있는 동안 지속된다. 해결 절차가 없는 과거 테스트 주문은
Grafana에서 해당 규칙을 일시 음소거하고 업무 처리 정책을 확인한다. 감시를 위해 DB 상태를 임의 변경하지 않는다.
5xx는 최근 5분 창이 지나면 해제되고 카운터는 BE 재시작 때 초기화된다.

DB 장애와 지표 쿼리 실패를 구분한다. 지표 수집 실패 시 주문 수를 0건으로 내보내지 않는다.
BE 프로세스 응답과 DB 지표 수집은 별도로 점검한다. 프로브 자체 자료가 없는 경우를 서비스 중단으로 단정하지 않는다.
수집 실패·No Data는 대시보드에서 확인하며 별도 장애 채널 알림을 추가하지 않는다.
Prometheus/Grafana 자체 장애나 서버 전체 중단 때는 알림을 보장하지 않는다.

## 서버 최초 적용

1. 최신 BE 릴리스를 배포해 `/internal/metrics`, 안전한 Nginx 로그, Docker 로그 회전을 적용한다.
   Compose logging/PG command 변경은 기존 컨테이너 재생성이 필요하며 DB도 한 번 재시작될 수 있다.
   마이그레이션 SQL 추가는 없다.
2. 이 디렉터리를 예를 들어 `/opt/dva-observability`에 복사한다. 일반 BE 릴리스 패키지에는 포함하지 않는다.
3. `settings.example`을 `/srv/dva-observability/settings`에 복사하고 서버에서 직접 설정한다.
   디렉터리는 root만 쓰도록, 설정 파일은 root 소유 `0600`으로 관리한다.
   관리자 비밀번호는 24자 이상 새 난수로 지정한다. 비밀값을 Git·명령 인수·메신저에 남기지 않는다.
4. Mattermost에서 본인만 참여한 **비공개** 채널을 만들고 해당 채널에 잠근 Incoming Webhook을 생성한다.
   URL을 `MATTERMOST_WEBHOOK_URL`에 지정한다. 생략하면 모든 알림 규칙이 PAUSED로 시작한다.
   웹훅 생성 권한이 없으면 서버 관리자에게 채널용 웹훅 발급을 요청한다.
5. Docker/Compose, bash, flock, install, curl이 있는 Linux에서 실행한다. 수집용 노드 런타임은 컨테이너를 사용한다.

```bash
sudo bash /opt/dva-observability/deploy.sh /srv/dva-observability/settings
```

저장소는 `/srv/dva-observability/data`, 비밀 provisioning은 `/srv/dva-observability/runtime`에 생성한다.
최초 적용 전 최소 25 GiB 여유 공간을 확인한다. 앱 DB 볼륨이나 앱 배포 기록은 수정하지 않는다.
기동 시 설정에 노출되는 관리자 비밀번호는 최초 계정 생성용이며, 이후 변경은 Grafana 사용자 관리에서 처리한다.
파일의 비밀번호만 바꾸면 기존 계정 비밀번호가 변경되는 것은 아니다.

6. [호스트 HTTPS 설정](../https/https.conf)의 `/grafana/` location을 실제 설정에 반영한 뒤
   `sudo nginx -t` 성공 후 `sudo systemctl reload nginx`를 실행한다.
7. `https://13.209.59.180/grafana/`에서 운영 담당자는 Admin, 개발·인프라 담당자는 각자 Viewer 계정으로 등록한다.
   DVA 앱 관리자 계정과 별개다. 공개 가입·익명 접근은 비활성화되어 있다.
   Viewer는 제공한 대시보드 필터로 로그를 조회하며, 대시보드 작성자가 필요할 때만 Editor를 부여한다.
8. 외부에서 `/internal/metrics`, `/api/internal/metrics`, Loki/Prometheus 포트에 접근할 수 없는지 확인한다.
9. 대시보드에 BE/DB/Nginx 상태, 서버 지표, 새 요청 로그가 실제로 나타나는지 확인한다.
   비공개 채널 수신 시험은 실제 메시지를 보내므로 적용 담당자가 별도로 실행한다.

앱 배포는 기존 파이프라인을 유지한다. 이 스택은 일반 BE 변경마다 재배포하지 않는다.
설정·대시보드·알림은 Git 파일이 기준이고, 설정 변경 후 위 명령으로 다시 적용한다.
파일에서 제공한 대시보드/규칙은 UI에서 수정하지 않는다. 다른 채널로 변경할 때는 웹훅 설정만 바꿔 재적용한다.

## 보관과 장애 시 동작

- Loki Compactor retention: 168시간. 삭제 지연 2시간과 정리 주기 때문에 경계 시각에 즉시 모든 파일이 지워지지는 않는다.
- Prometheus: 7일 또는 2 GiB 기준으로 오래된 블록부터 삭제한다. WAL·활성 블록 때문에 순간 사용량은 상한을 초과할 수 있다.
- 앱 Docker 로그: 컨테이너별 `10m × 5`, 관측 도구: `10m × 3`. 압축 전 기준이며 7일 원본 보관을 보장하지 않는다.
- Loki 유입 제한: 초당 0.02 MiB, burst 1 MiB. 정상 개발 트래픽을 전제로 하는 보수적 초기값이다.
  수집 급증 시 거부·재시도 후 일부 유실될 수 있다. 요청 원문을 추가해 유입 제한을 우회하지 않는다.
- **Loki 7일 retention은 디스크 용량의 하드 제한이 아니다.** WAL·인덱스·기존 자료까지 포함해
  `df -h /srv/dva-observability`와 `sudo du -sh /srv/dva-observability/data/*`를 확인한다.
  여유 공간이 부족하면 우선 관측 Compose의 `alloy`·`loki`를 중지하고 공간/보관 정책을 조정한다.
  앱 DB나 녹취 파일을 정리 대상으로 삼지 않는다. 전용 파일시스템 용량 제한은 서버 적용 시 추가할 수 있다.
- BE는 Loki/Grafana를 직접 호출하지 않는다. 로그 출력과 Docker 버퍼는 제한되고 관측 장애로 주문 처리를 중단하지 않는다.
- Alloy 재시작 후 남아 있는 원본 로그를 수집할 수 있다. 회전으로 삭제된 원본과 중계 중 유실된 로그는 복원되지 않는다.
  완전한 무유실/정확히 한 번 수집을 보장하지 않는다. 업무 DB 및 감사 기록의 저장 보장은 이 정책과 별개다.
- 데이터 보관은 Grafana 계정·설정의 수명과 다르다. Grafana DB와 Alloy 위치 기록은 재시작 간 유지한다.
  롤백은 이전 관측 설정으로 재기동하며 데이터 디렉터리를 삭제하지 않는다.

## 장애 확인 순서

1. 비공개 채널에서 서비스·장애 종류·발생 시각을 확인한다.
2. Grafana `DVA BE 운영 상태`에서 같은 시간대 상태·주문 지표·로그를 확인한다. 정상과 수집 안 됨을 구분한다.
3. BE 요청 ID를 필터에 입력해 HTTP 결과와 `dver_submission`, `order_submission_result`를 연결한다.
   REVIEW_REQUIRED나 저장 실패는 외부 접수 성공 가능성이 있으므로 자동 재접수하지 않는다.
4. DB 장애라면 DB 컨테이너 상태와 연결 설정을 확인한다. SQLSTATE `08...`는 연결 계열, `23...`는 제약 계열이다.
   원본 DB 오류를 조회해야 한다면 제한된 운영 계정으로 확인하고 값이 포함될 수 있음을 고려한다.
5. 로그만 안 보이면 Alloy/Loki 상태, 앱 Compose project 이름, Docker 읽기 중계기, 저장 공간을 확인한다.
   수집을 위해 Docker 소켓을 Alloy/Grafana에 직접 연결하거나 쓰기 API를 열지 않는다.

Docker 읽기 중계기는 서버 소켓에 접근하므로 내부망에서만 사용한다. 조회 API를 제한하고
원본 inspect의 환경변수·명령·마운트·헬스체크를 제거한 최소 응답만 제공한다.
지정한 앱 프로젝트의 backend/db/nginx만 조회하고 AI/Jenkins 등은 조회하지 않는다.

## 검증

```bash
node backend/scripts/check.cjs
node infra/observability/test.mjs
```

두 번째 명령은 매 실행마다 임시 네트워크·가짜 BE·가짜 Mattermost 수신처를 만든다.
실제 Loki/Alloy/Prometheus/Grafana를 기동해 수집, 필드 제거, 지표, 알림 평가·JSON 전송을 확인하고
자신이 생성한 컨테이너/네트워크만 제거한다. 운영 서버·실제 디버·외부 채널에는 호출하지 않는다.
Docker-in-Docker에서도 동작하도록 로컬 설정은 Docker cp로 전달한다.
실제 24시간 대기 시험은 하지 않고 적용된 notification policy의 24h 값과 단기 중복 미발송을 확인한다.

## 참고

- [Alloy Docker 수집](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.docker/)
- [Loki 보관 정책](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- [Grafana 파일 provisioning](https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/file-provisioning/)
- [Grafana 웹훅 custom payload](https://grafana.com/docs/grafana/latest/alerting/configure-notifications/manage-contact-points/integrations/webhook-notifier/)
- [Mattermost Incoming Webhooks](https://docs.mattermost.com/integrations-guide/incoming-webhooks)
