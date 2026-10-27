# 관리자 API HTTPS 연결

기존 README의 개별 경로 공개 정책을 확장하여 `/api/` 요청을 호스트 Nginx에서
`127.0.0.1:8082`의 내부 Nginx로 전달한다. 내부 Nginx는 경로를 보존하여
NestJS로 전달하고, 관리자 인증·권한·CSRF 검사는 기존 전역 AuthGuard가 처리한다.
새 업무 API마다 호스트 Nginx 경로를 추가할 필요는 없다.

직원 CSV 업로드는 파일 최대 1MiB와 multipart 헤더를 수용하도록 `/api/`의
`client_max_body_size 2m`을 사용한다. 앱은 파일 크기 1MiB·1,000행을 별도로 제한한다.
기존 서버의 `/api/` 블록에도 이 제한을 반영해야 하며 앱 배포만으로 호스트 설정이 바뀌지 않는다.
자세한 계약은 [기업 구성원 API](../../docs/api/members.md)를 참고한다.

- `/api/health/ready`와 하위 경로는 외부에서 404다.
- 기존 PBX 웹훅의 POST 제한, Swagger 메서드 제한, Jenkins 경로는 유지한다.
- API 프록시는 요청을 자동 재시도하지 않고 요청 URL 접근 로그를 남기지 않는다.
- DB migration과 최초 관리자 생성은 라우팅 변경과 별개다.

## 서버 적용

대상 파일은 `/etc/nginx/sites-available/dva-ip`다. 서버에는 AI 웹훅·PBX mirror·
별도 도메인 설정이 추가되어 있으므로 저장소의 `https.conf`로 전체를 덮어쓰지 않는다.
서버 파일을 백업하고 IP HTTPS server 블록에 readiness 차단과 `/api/` 전달 블록만 추가한다.
후보 설정을 검사한 뒤 실제 설정에서도 `sudo nginx -t`가 성공한 경우에만
`sudo systemctl reload nginx`를 실행한다. 검사 실패 시 백업을 복원한다.
다른 팀의 설정 변경과 겹치면 현재 서버 파일을 다시 읽어 차이를 확인한다.

Jenkins의 컨테이너 배포는 이 호스트 설정을 자동으로 적용하지 않는다.
새 배포 흐름은 앱 교체 전에 migration과 스키마 검증을 실행하지만 자동 DB 백업은 생략하므로,
이번처럼 실제 DB 구조를 변경하기 전에는 별도 백업을 확보한다.

## 검증

```bash
bash infra/https/check-api-routing.sh https://13.209.59.180
```

이 검사는 GET 요청만 사용하며 로그인 없는 관리자 API의 401, readiness의 404와
기존 Swagger·웹훅 메서드 제한·Jenkins 경로를 확인한다. 비밀번호·세션을 출력하지 않는다.
로그인과 업무 쓰기는 DB·관리자 준비 후 별도로 검증한다.
