# Order 서비스

주문 서비스의 NestJS 실행·Swagger·배포 기반. 업무 API, DB 접속, 메시지 브로커는 아직 연결하지 않는다. 기존 order DB changeset은 변경하지 않는다.

## 실행

Node.js 24에서 `npm ci` 후 `npm run start:dev`를 실행한다. Windows PowerShell 실행 정책이 npm.ps1을 막으면 `npm.cmd`를 사용한다.

- 기본 포트: `3002` (`PORT`로 변경 가능)
- Health: http://localhost:3002/order/health
- Swagger: http://localhost:3002/order/docs
- OpenAPI: http://localhost:3002/order/docs-json

Health의 `status: ok`는 HTTP 프로세스 상태이며 DB나 외부 서비스 연결을 의미하지 않는다.

## 이미지와 배포

저장소 루트에서 `docker build -t dva-order:local msa/services/order`를 실행한다. 이미지 빌드에서 ESLint, 단위·E2E 테스트와 TypeScript 빌드를 수행한다. 런타임은 개발 의존성을 제외하고 node 사용자로 실행한다.

`k8s.yaml`은 dva 네임스페이스의 order Deployment·Service·Ingress를 생성한다. 서비스 포트는 3002이며 Traefik이 `/order`를 그대로 전달한다. TLS는 기존 websecure/letsencrypt 설정을 재사용한다.

병합 후 예정 주소(이 브랜치에서 운영 배포하지 않음):

- https://k15d109.p.ssafy.io/order/health
- https://k15d109.p.ssafy.io/order/docs
- https://k15d109.p.ssafy.io/order/docs-json

공통 Jenkins 파이프라인이 새 order 디렉터리를 자동 선택하여 테스트·이미지 빌드·패키징·배포한다. 정상 배포된 customer와 변경 없는 DB는 생략한다. 누락된 배포 이력이나 실패한 이전 배포는 재선택될 수 있다. 별도의 수동 배포 옵션은 없다.

새 Pod의 readiness가 통과하기 전 기존 Pod를 유지한다(`maxUnavailable=0`, `maxSurge=1`). rollout 또는 내부·외부 응답 검사 실패 시 공통 배포 코드가 이전 리소스를 복구한다. 최초 설치에는 이전 버전이 없으므로 실패 리소스를 남긴다. 단일 노드 장애까지 무중단을 보장하지 않는다.

## 검증

```bash
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
# 저장소 루트, 운영 kubeconfig를 사용하지 않는 로컬 Docker에서만 실행
python msa/deploy/tests/integration_app_rollout.py --service order --image dva-order:local
```

NestJS 11을 유지하며 multer 2.5.0과 Swagger의 js-yaml 5.5.0을 overrides로 고정했다. 의존성 갱신 시 overrides 필요 여부와 npm audit 결과를 함께 확인한다.

## MR 전 검증 기록 (2026-10-26)

- Docker의 Linux Node.js 24에서 ESLint·단위 1개·E2E 3개·TypeScript 빌드 통과.
- Linux Python 3.13 배포 회귀 검사 47개 통과. 새 order만 선택하고 정상 customer와 변경 없는 DB를 생략하는 경로 포함.
- 실제 이미지의 공통 package-app.sh 패키징 및 체크섬 검사 통과, k3s 서버 dry-run에서 Deployment·Service·Ingress 검증 통과.
- 격리 k3s v1.35.5+k3s1에서 order 최초 설치·정상 교체·readiness 실패·이전 버전 복구 성공. HTTP 요청 444건 중 실패 0건. 공통 도구의 customer 회귀도 462건 중 실패 0건.
- 초기 격리 검증의 DNS 준비 지연을 확인하여 검증 도구가 CoreDNS 생성·Ready를 기다리도록 보완했다. 운영 배포 코드는 변경하지 않았다.
- npm audit: 전체 lockfile 및 런타임 의존성의 알려진 취약점 0건.
- Windows 네이티브 배포 회귀는 WSL Bash 실행 환경 문제로 실패했다. 배포 대상과 동일한 Linux 컨테이너에서 47개를 검증했으며 테스트 기대값은 완화하지 않았다.
- 운영 서버 배포, 새 Webhook을 통한 Jenkins 실행, 실제 외부 HTTPS 접속은 MR 병합 후 확인한다. 이번 작업은 MR을 생성하지 않는다.
