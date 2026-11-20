# Dva AWS 배포 아키텍처 — 초안 (v0.1)

> 2026-10-23 갱신: 실제 모놀리식 서버는 Lightsail `dva-monolith`
> (서울, Ubuntu 24.04, 2 vCPU / 8GB / 160GB, `192.0.2.10`)로 확정했다.
> 이미지 전달은 ECR 대신 Jenkins에서 파일 생성 → SSH 전송 → docker load 방식으로 선택했다.
> 로컬 패키징 → 실제 서버 전송·기동 → 내부 Health Check → 수동 롤백·재배포를 검증했다.
> Jenkins 수동 선택 전송·배포 검증을 완료했다. 컨테이너 Nginx는 `127.0.0.1:8082`를 유지하고,
> 호스트 Nginx가 고정 IP의 공인 HTTPS 인증서를 사용해 PBX 웹훅을 전달한다.
> 웹훅 인증·DB 저장을 검증했으며 실제 PBX 통화, 업무 데이터·AI 연결은 남아 있다.
> [HTTPS 운영](../https/README.md), [PBX 규격](../webhooks/PBX-CALL-ENDED.md)을 참고한다.
> 현재 실행 절차는 [이미지 파일 배포 가이드](../deploy/README.md)를 따른다.
> 아래 EC2·ECR·SSM 내용은 기존 검토안이며 실제 구축 완료 상태를 의미하지 않는다.

> 상태: 설계 초안 / AWS EC2 미발급. 실제 계정·리전·도메인·IP-PBX 연결 사양 확인 후 확정한다.

## 1. 범위와 전제

- 프로젝트 필수 기능: 전화 음성 스트림 수신 및 AI 상담, 디버 플랫폼으로 주문 REST API 연동, 관리자 웹(프롬프트/주문/통화·스크립트 관리).
- 현 로컬 서비스: `nginx`(HTTP 리버스 프록시), `backend`(NestJS/Node 24), `ai`(FastAPI/Python), `db`(PostgreSQL 17); Docker Compose 사용.
- 현재 CI: GitLab `develop` → Jenkins → Backend 컴파일 및 Backend/AI Docker 이미지 빌드. 자동 배포(CD)는 미구현.
- 가정: 프로젝트 초기에는 비용과 운영 난도를 고려하여 EC2 **1대**에 Docker Compose로 웹/API/AI/DB를 배치한다. 단일 장애점(SPOF)이 있으며 고가용성 구성이 아니다.

## 2. 제안 배포 토폴로지

```mermaid
flowchart TB
    Admin[관리자 브라우저] -->|HTTPS 443| Nginx
    PBX[디버 IP-PBX] -.->|RTP 등: 프로토콜/포트 미확정| Voice[음성 수신 어댑터: 구현·배치 미확정]
    subgraph AWS[AWS VPC · Public Subnet · 단일 EC2 (초기안)]
      Nginx[Nginx · 웹 진입점]
      FE[React 관리자 웹 · 준비되면 추가]
      BE[NestJS Backend]
      AI[FastAPI AI Agent]
      DB[(PostgreSQL 17 · EBS 영속 저장)]
      Nginx --> FE
      Nginx -->|/api| BE
      BE -->|내부 HTTP| AI
      BE -->|내부 DB 연결| DB
      Voice -.-> AI
    end
    AI -->|주문 데이터 전달: 실제 연계 주체 확정 필요| BE
    BE -->|HTTPS REST| DVER[디버 주문 플랫폼]
    Jenkins[Jenkins CI · 현재 Windows 개발 PC] -->|향후 이미지 Push| ECR[(Amazon ECR)]
    ECR -->|향후 Pull 및 배포| AWS
```

- 기존 Compose 네트워크 `web_net`(Nginx/Backend), `ai_net`(Backend/AI), `db_net`(Backend/DB, internal)은 유지한다. 관리자 프론트엔드가 추가되면 웹 서빙 방식을 별도로 확정한다.
- API Gateway, ALB, NLB, ECS/EKS는 **현 단계 필수 아님**. 다중 서버·운영 요구·통화 트래픽 특성이 확인되면 재평가한다.
- 일반 Nginx HTTP `location`은 RTP/UDP 스트림 수신 기능을 대신하지 않는다. UDP RTP라면 별도 리스너/포트와 보안 그룹 규칙이 필요하다.

## 3. 초기 AWS 리소스 제안

| 구성 | 초기안 | 비고 |
|---|---|---|
| VPC/서브넷 | 기존 VPC 또는 프로젝트용 VPC 내 퍼블릭 서브넷 | 단일 EC2 MVP용; 실제 네트워크 정책 확인 |
| EC2 | Linux x86_64/arm64 중 컨테이너 호환 아키텍처 선택 | 크기는 AI 실시간 처리 방식·메모리·CPU 요구 확인 후 결정 |
| IP/도메인 | 고정 IP가 필요하면 Elastic IP, 관리자 웹용 도메인 | EC2 공인 IP 및 DNS 필요 여부 확정 |
| Nginx | 80/443 진입점, HTTPS 종료 및 API 라우팅 | 로컬 `127.0.0.1:8081` 바인딩을 운영 환경에서 재설계 |
| Docker Compose | `nginx`, `backend`, `ai`, `db` 운영 | Frontend 준비되면 추가 |
| 저장소 | 암호화 EBS(gp3 등) 기반 DB 영속 스토리지 | DB 컨테이너 재생성과 데이터 삭제 구분 |
| 이미지 저장소 | Amazon ECR Private Repository: backend/ai (향후 frontend) | `latest` 단독보다 커밋 SHA 태그 권장 |
| 서버 접근 | AWS Systems Manager Session Manager 우선 검토 | IAM/SSM Agent/네트워크 조건 충족 시 SSH 개방 없이 접근 |
| 로그/백업 | 로그 수집·보존 정책, PostgreSQL 백업 및 복구 시험 | EBS 스냅샷만으로 애플리케이션 일관성 보장된다고 가정하지 않음 |

## 4. EC2 보안 그룹 Inbound 초안

| 프로토콜/포트 | 허용 출처 | 정책 |
|---|---|---|
| TCP 443 | 관리자 접근 정책에 맞는 승인 IP/CIDR 또는 필요한 공개 사용자 | HTTPS 서비스 진입점; 관리자 전용이면 IP 제한 고려 |
| TCP 80 | 인증서 발급/갱신·HTTPS 리다이렉트 필요 시 | 공개 여부 운영 방식에 따라 결정 |
| TCP 22 | 원칙적으로 미개방(SSM 사용) | SSH 필요 시 관리자 고정 IP만 허용 |
| TCP 3000 | 없음 | NestJS는 Docker 내부 포트만 |
| TCP 8000 | 없음 | FastAPI 내부 통신용; 음성 수신 포트는 별도 사양 검토 |
| TCP 5432 | 없음 | PostgreSQL 외부 공개 금지 |
| TCP 8080 | 없음 | Jenkins 관리 포트를 Dva EC2에 공개하지 않음 |
| UDP RTP 포트 | **미정** | 디버 IP-PBX 송신 IP, 포트 범위, RTP/SRTP, 방향 확인 후 최소 범위 허용 |

**주의:** 현재 Compose의 `127.0.0.1:8081:80`은 로컬 개발 전용이다. 운영 환경에서 접근 통제를 검토한 뒤 80/443 포트 매핑 및 HTTPS를 별도 구성한다. `backend`, `ai`, `db`에 호스트 `ports`를 추가하지 않는다.

## 5. CI/CD 목표 흐름 (아직 구현 전)

1. 팀원 코드 → GitLab `develop` → Jenkins CI(컴파일·테스트·Docker 빌드).
2. 승인된 배포 대상 커밋을 식별해 `dva-backend:<commit-sha>`, `dva-ai:<commit-sha>` 이미지 생성.
3. 최소 권한을 가진 빌드 자격 증명으로 ECR에 이미지 Push.
4. EC2 인스턴스 IAM 역할을 이용해 ECR 이미지 Pull.
5. 배포 전 설정/DB 백업 확인 → `docker compose pull` / `docker compose up -d` → Health Check → 필요 시 롤백.
6. 현재 Jenkins/Windows Agent는 개발 PC에서 동작하므로 PC 종료 시 파이프라인이 중단됨. 지속 운영 가능한 CI 서버 위치는 별도 결정.

## 6. 배포 전 필수 확인 항목

- [ ] EC2 발급 여부, AWS 계정/리전, IAM 권한 및 사용 가능한 예산
- [ ] Linux OS/CPU 아키텍처 및 AI 처리에 필요한 자원 규모
- [ ] 관리자 웹 도메인, 사용자 접근 범위, HTTPS 인증서 발급 방식
- [ ] 디버 IP-PBX의 RTP/SRTP 여부, 송신 IP, UDP 포트 범위, 오디오 코덱, 지터/세션 처리 및 실제 수신 구현 주체
- [ ] 디버 주문 플랫폼 REST API 엔드포인트·인증·허용 IP 등 연계 조건
- [ ] 통화 녹음/스크립트/개인정보 저장 위치, 암호화, 보존 기간, 접근 권한
- [ ] DB 백업 주기·복구 목표·실제 복원 테스트
- [ ] 환경변수 및 비밀키 관리(`.env`는 Git에 Push 금지)
- [ ] 공개 상태 확인 URL과 내부 readiness URL을 구분; 외부에 DB/AI 상세 상태 노출하지 않기

## 7. 지금까지의 검증된 상태와 다음 순서

**검증됨:** 로컬 Docker Compose 기동, Nginx → NestJS → DB/AI readiness 응답, Docker 네트워크 3개 분리, Jenkins CI에서 Backend/AI 이미지 빌드 성공.

**다음 작업:** (1) 팀/기업과 미확정 항목 확인 → (2) AWS 리소스 발급 → (3) EC2 최소 권한 및 방화벽 → (4) HTTPS와 운영 Compose → (5) ECR/CD → (6) RTP 연동 → (7) 장애·복구 테스트.
