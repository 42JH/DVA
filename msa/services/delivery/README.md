# Delivery 서비스

배송 서비스의 NestJS 실행·Swagger·배포 기반이다. 업무 API, DB 접속, 메시지 브로커는 아직 연결하지 않는다. 기존 delivery DB changeset은 변경하지 않는다.

## 실행

Node.js 24에서 `npm ci` 후 `npm run start:dev`를 실행한다. PowerShell에서 npm.ps1이 차단되면 `npm.cmd`를 사용한다.

- 기본 포트: `3003` (`PORT`로 변경 가능)
- Health: http://localhost:3003/delivery/health
- Swagger: http://localhost:3003/delivery/docs
- OpenAPI: http://localhost:3003/delivery/docs-json

Health의 `status: ok`는 HTTP 프로세스 상태이며 DB나 외부 서비스 연결을 의미하지 않는다.

## 빌드와 배포

저장소 루트에서 `docker build -t dva-delivery:local msa/services/delivery`를 실행한다. Docker 빌드에서 ESLint, 단위·E2E 테스트, TypeScript 빌드를 수행한다. 운영 이미지는 개발 의존성을 제외하고 node 사용자로 실행한다. Order와 같은 lockfile 및 보안 패치 overrides를 사용한다.

`k8s.yaml`은 dva 네임스페이스에 delivery Deployment·Service·Ingress를 구성한다. 포트는 3003, 경로는 `/delivery`이며 기존 Traefik websecure/letsencrypt를 사용한다.

병합 후 확인할 운영 주소:

- https://k15d109.p.ssafy.io/delivery/health
- https://k15d109.p.ssafy.io/delivery/docs
- https://k15d109.p.ssafy.io/delivery/docs-json

공통 Jenkins 파이프라인이 서비스 폴더를 자동 검색하므로 전용 stage나 수동 옵션을 추가하지 않는다. develop-backend 병합 후 새 delivery를 빌드·패키징·배포한다. 정상 배포된 customer·order와 변경 없는 DB는 생략한다. 배포 이력이 없거나 이전 배포가 실패한 서비스는 재선택될 수 있다.

`maxUnavailable=0`, `maxSurge=1`, readiness 검사와 종료 유예로 새 Pod 준비 전 기존 Pod를 유지한다. rollout 또는 응답 검사 실패 시 기존 배포 리소스를 복구한다. 최초 배포는 이전 버전이 없어 복구할 수 없으며, 단일 노드 장애까지 무중단을 보장하지 않는다.

## 검증

```bash
# 저장소 루트, 운영 kubeconfig를 사용하지 않는 로컬 Docker 환경
python msa/deploy/tests/integration_app_rollout.py --service delivery --image dva-delivery:local
```

검증 기록과 운영 배포 결과는 구분한다. MR 전에는 Docker 빌드, 선택 배포 회귀, 이미지 패키징, 격리 k3s 교체·복구를 검증한다. 운영 자동 배포 및 외부 HTTPS는 병합 후 `DVA_APP_ROLLOUT_COMPLETE=delivery`와 함께 확인한다.

## MR 전 검증 기록 (2026-10-26)

- Docker Linux Node.js 24: ESLint, 단위 1개, E2E 3개, TypeScript 빌드 통과.
- 설치 시 전체·운영 의존성 audit 취약점 0건.
- Linux Python 3.13 배포 회귀 검사 48개 통과. 신규 Delivery만 선택하고 정상 Customer·Order 및 변경 없는 DB를 생략하는 경로 포함.
- 실제 이미지 package-app.sh 패키징과 6개 파일 체크섬 통과.
- 격리 k3s v1.35.5+k3s1에서 Deployment·Service·Ingress 서버 dry-run 통과.
- 같은 격리 클러스터에서 최초 배포·정상 교체·readiness 실패 후 이전 버전 복구 통과. HTTP 413건 중 실패 0건. 실패를 의도한 배포의 progress deadline 오류는 복구 시나리오의 일부다.
- 운영 Jenkins 실행과 외부 HTTPS는 아직 실행하지 않았다. 병합 후 확인한다.
