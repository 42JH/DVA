# Consultation 서비스

상담 서비스의 NestJS 실행·Swagger·배포 기반이다. 업무 API, DB 접속, 메시지 브로커는 아직 연결하지 않는다. DB changeset은 변경하지 않는다.

## 실행

Node.js 24에서 `npm ci` 후 `npm run start:dev`를 실행한다. PowerShell에서 npm.ps1이 차단되면 `npm.cmd`를 사용한다.

- 기본 포트: `3004` (`PORT`로 변경 가능)
- Health: http://localhost:3004/consultation/health
- Swagger: http://localhost:3004/consultation/docs
- OpenAPI: http://localhost:3004/consultation/docs-json

Health는 HTTP 프로세스 상태이며 DB 및 외부 시스템의 정상 상태를 의미하지 않는다.

## 빌드와 자동 배포

저장소 루트에서 `docker build -t dva-consultation:local msa/services/consultation`를 실행한다. Docker 빌드에서 ESLint·단위·E2E·TypeScript 검사를 실행하고, 운영 이미지는 개발 의존성 없이 node 사용자로 구동한다.

공통 Jenkins 파이프라인이 서비스 폴더를 자동 선택한다. develop-backend 병합 후 테스트·이미지 빌드·패키징·k3s 배포를 수행한다. 정상 배포된 다른 서비스와 변경 없는 DB는 생략한다. 배포 이력이 없거나 실패한 서비스는 재선택될 수 있다.

k8s.yaml은 dva 네임스페이스에 Deployment·Service·Ingress를 구성한다. Traefik websecure/letsencrypt와 /consultation 경로를 사용한다. 병합 후 운영 확인 주소:

- https://k15d109.p.ssafy.io/consultation/health
- https://k15d109.p.ssafy.io/consultation/docs
- https://k15d109.p.ssafy.io/consultation/docs-json

새 Pod 준비 전 기존 Pod를 유지한다(maxUnavailable=0, maxSurge=1). readiness·종료 유예와 기존 공통 실패 복구를 사용한다. 최초 배포에는 이전 버전이 없으며, 단일 노드 장애까지 무중단을 보장하지 않는다. 두 서비스 배포는 하나의 트랜잭션이 아니므로 뒤 서비스가 실패해도 먼저 성공한 서비스는 유지하고 재실행 시 미배포 서비스만 선택한다.

## 검증

```bash
# 저장소 루트, 운영 kubeconfig를 사용하지 않는 로컬 Docker
python msa/deploy/tests/integration_app_rollout.py --service consultation --image dva-consultation:local
```

- Linux Node.js 24 Docker 빌드: ESLint·단위 1개·E2E 3개·TypeScript 통과.
- 설치 시 전체·운영 의존성 audit 취약점 0건.
- Linux Python 3.13 배포 회귀 49개 통과. 두 신규 서비스 선택·기존 세 서비스/DB 생략·부분 성공 재시도 포함.
- 실제 이미지 패키징과 6개 파일 체크섬, k3s 전체 매니페스트 서버 dry-run 통과.
- 운영 Webhook 배포와 외부 HTTPS는 MR 병합 후 확인한다.
- 격리 k3s v1.35.5+k3s1 최초 배포·정상 교체·readiness 실패 후 이전 버전 복구 통과. HTTP 418 건 중 실패 0건. 의도적인 progress deadline 오류 후 복구 성공을 확인했다.
