# 고정 IP HTTPS 운영

대상: Lightsail `13.209.59.180`. 도메인 구매·Route 53·별도 로드밸런서 없이 기존 서버를 사용한다.
Let’s Encrypt IP 인증서는 무료이며 유효기간은 약 160시간이다.
발급 사양: https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html

```text
PBX → 공인 IP:443 (호스트 Nginx, TLS 종료)
    → 127.0.0.1:8082 (컨테이너 Nginx)
    → backend:3000 → 내부 PostgreSQL
```

외부 HTTPS에는 `/api/webhooks/pbx/call-ended`의 POST와 `/https-health`만 연결한다.
Backend·AI·DB 포트는 외부로 공개하지 않는다. HTTP 80은 인증서 검증 경로만 제공하며
웹훅이나 토큰을 받거나 HTTPS로 리다이렉트하지 않는다. SSH 설정은 변경하지 않는다.
Lightsail IPv4 방화벽은 TCP 80·443 접근이 가능해야 한다. 실제 인증서 발급과 외부 접속으로
두 포트가 사용 가능함을 확인했고, AWS 방화벽 규칙은 이번 작업에서 변경하지 않았다.

## 최초 설치 / 재현

`infra/https` 폴더를 서버 `~/dva-deploy/https`에 전송한 뒤 실행한다.
스크립트는 Ubuntu에 Nginx·Python venv를 설치하고 `/opt/dva-certbot`에 Certbot 5.4 이상을 설치한다.
검증 당시 버전은 5.8.0이다. 기존 컨테이너 배포와 독립적으로 관리한다.

```bash
sudo bash ~/dva-deploy/https/setup-ip-https.sh bootstrap
sudo bash ~/dva-deploy/https/setup-ip-https.sh staging
sudo bash ~/dva-deploy/https/setup-ip-https.sh issue
```

staging 인증서는 별도 디렉터리에 보관하고 실제 HTTPS에는 사용하지 않는다.
실제 인증서의 IP SAN, 로컬 신뢰 검증, 갱신 모의 실행 및 hook을 검증한 뒤 타이머를 활성화한다.
타이머가 초기 발급·모의 갱신과 동시에 Certbot 잠금을 잡지 않도록 활성화 순서를 분리했다.

인증서 계정 이메일은 현재 등록하지 않았다. 이메일을 등록하려면 계정 소유자가 SSH에서
`sudo /opt/dva-certbot/bin/certbot update_account --email 본인이메일`로 변경한다.
인증서 자동 갱신과 시스템 로그 확인은 이메일 알림에 의존하지 않는다.

## 주요 파일

| 서버 경로 | 용도 |
|---|---|
| `/etc/nginx/sites-available/dva-ip` | 실행 중인 호스트 Nginx 설정 |
| `/etc/letsencrypt/live/dva-ip/` | 실 인증서·개인 키. Git/배포 산출물에 복사 금지 |
| `/etc/letsencrypt-staging/` | 테스트 인증서, 실제 서비스에는 미사용 |
| `/opt/dva-ip-https/reload-nginx.sh` | root 소유 갱신 후 Nginx 설정 검사·reload hook |
| `/etc/systemd/system/dva-certbot-renew.*` | 매시간 갱신 검사 타이머·서비스 |
| `/home/ubuntu/dva-deploy/shared/.env` | 운영 DB 설정·웹훅 공유 토큰, 권한 600 |

배포 Compose는 `127.0.0.1:8082`를 유지한다. Jenkins 재배포가 호스트 HTTPS 설정이나
인증서를 교체하지 않는다. 향후 호스트 경로·포트를 바꾸면 양쪽 Nginx 설정을 함께 확인한다.

## 갱신과 점검

```bash
systemctl list-timers dva-certbot-renew.timer
sudo journalctl -u dva-certbot-renew.service -n 30 --no-pager
sudo /opt/dva-certbot/bin/certbot certificates
curl --fail https://13.209.59.180/https-health
```

갱신 타이머는 매시간 최대 5분 지연 후 실행한다. Certbot이 갱신 필요성을 판단하고,
실제 갱신 후에는 설정 검사를 통과한 Nginx를 reload한다. 서비스는 남은 유효기간이 48시간보다
짧으면 실패 상태를 남긴다. 외부 알림/모니터링은 별도 구성 전이므로 서비스 실패 로그도 확인한다.

수동 모의 갱신은 예약 실행과 겹치지 않게 다음처럼 실행한다. 이미 갱신 서비스가 실행 중이면
끝난 후 진행한다. 실행 중 Certbot을 강제로 종료하거나 잠금 파일을 삭제하지 않는다.

```bash
sudo systemctl stop dva-certbot-renew.timer
sudo /opt/dva-certbot/bin/certbot renew --dry-run --run-deploy-hooks --no-random-sleep-on-renew
sudo systemctl start dva-certbot-renew.timer
```

Nginx 설정 변경은 `/usr/sbin/nginx -t` 성공 후 reload한다. host 기본 사이트는
`/etc/nginx/default-site.disabled`에 보존했다. 앱 롤백은 기존 `deploy.sh --rollback`을
사용하며, 새 DB schema와 호스트 HTTPS는 롤백 때 삭제하지 않는다.

## 2026-10-23 실제 검증

- Let's Encrypt staging 검증, 공인 IP 인증서 발급 성공
- 인증서 유효기간: 2026-10-23 09:25:11 ~ 2026-10-30 01:25:10 KST
- IP SAN `13.209.59.180` 확인
- 외부 PC의 `https://13.209.59.180/https-health` HTTP 200, 신뢰 검증 통과
- 갱신 dry-run 및 root 소유 reload hook 성공, 매시간 timer 활성화
- 웹훅 공개 경로의 실제 인증·DB 저장 검증: [PBX 규격](../webhooks/PBX-CALL-ENDED.md)
- DB 변경 전 서버에 custom-format dump를 만들고 pg_restore의 archive index 검사를 통과했다.
  실제 DB 복원 시험을 수행한 것은 아니며 정기 백업 구성도 별도 작업이다.

## 정식 도메인으로 전환할 때

구매한 도메인을 같은 IP에 연결하고 도메인용 인증서·Nginx server_name을 추가한다.
새 주소의 수신 테스트 후 디버 PBX에 웹훅 URL 변경을 요청한다. IP 주소를 병행 유지하면
전환 중 누락을 줄일 수 있다. 기존 수신 API·DB는 재구현하지 않는다.
