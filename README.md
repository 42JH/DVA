# Dva

### 음성 스트림 기반 AI 택배 주문 접수 및 관리 서비스

**Dva**는 고객이 전화로 AI 상담원과 자연스럽게 대화하며 택배를 접수하고, 관리자가 상담 및 주문 내역을 효율적으로 관리할 수 있도록 지원하는 서비스입니다.

**SSAFY 15기 기업연계 프로젝트 | 디버(Dver)**

---

## 1. Project Overview

### Background

기존 택배 서비스는 주로 모바일 앱이나 웹사이트를 통해 제공되지만, 디지털 환경에 익숙하지 않은 사용자에게는 복잡한 화면 조작과 배송 정보 입력 과정이 불편함으로 작용할 수 있습니다.

또한 가정 및 오피스 환경에서도 별도의 앱 설치나 회원가입 과정 없이 빠르고 간편하게 택배를 접수할 수 있는 서비스에 대한 수요가 존재합니다.

Dva는 이러한 문제를 해결하기 위해 **전화라는 익숙한 수단을 통해 음성 대화만으로 택배 주문을 접수할 수 있는 환경**을 구축하는 것을 목표로 합니다.

### Objectives

- **AI 기반 자동 주문 접수:** 실시간 음성 스트림을 분석하여 고객의 의도를 파악하고 배송 정보를 수집
- **택배 주문 시스템 연동:** 수집된 주문 정보를 디버 플랫폼의 REST API와 연동하여 주문 생성
- **상담 관리 시스템 구축:** 상담 내역, 주문 정보 및 AI 에이전트 설정을 관리할 수 있는 웹 플랫폼 제공
- **서비스 접근성 향상:** 앱 설치나 복잡한 화면 조작 없이 전화로 택배를 접수할 수 있는 환경 제공

---

## 2. Key Features

### AI Voice Agent

실시간 음성 데이터를 기반으로 고객과 대화하며 택배 주문에 필요한 정보를 수집하는 AI 상담 에이전트입니다.

- 실시간 음성 스트림 수신 및 처리
- AI 기반 고객 의도 파악 및 주문 정보 추출
- 출발지, 도착지, 물품 등 배송 정보 수집
- 누락된 정보에 대한 추가 질문 및 다중 턴 대화
- 수집된 주문 정보의 백엔드 API 연동
- 복잡한 요청 및 오류 발생 시 상담원 연결

### Admin Dashboard

AI 상담 및 택배 접수 현황을 관리하기 위한 웹 기반 관리자 시스템입니다.

- AI 에이전트 System Prompt 조회 및 수정
- 택배 주문 접수 내역 조회 및 관리
- 통화 기록 및 녹취·스크립트 관리
- 미완료 주문 확인 및 접수 정보 수동 보정
- 일별 주문 현황 및 평균 접수 소요시간 등 통계 대시보드

> 다중 턴 대화, 상담원 연결, 통계 대시보드 등은 명세서의 추가 구현 기능이며, 세부 구현 범위는 개발 과정에서 확정합니다.

---

## 3. System Architecture

Dva는 **모노레포 기반으로 소스 코드를 관리**하고, NestJS 백엔드는 **모놀리식 아키텍처**로 구성합니다.

시스템은 크게 관리자 웹, 백엔드, AI 에이전트, 데이터베이스로 구성됩니다.

```text
고객 전화
    │
    ▼
디버 전화 서버 (IP-PBX)
    │
    │ 실시간 음성 스트림 (RTP)
    ▼
AI Voice Agent (Python)
    │
    │ 주문 정보 및 업무 API 요청
    ▼
Backend (NestJS)
    ├── PostgreSQL
    └── 디버 플랫폼 REST API

관리자 웹 (React)
    │
    ▼
Backend (NestJS)
```

전화 서버에서 AI 에이전트로 RTP 음성 스트림을 전달하는 기능은 디버 측에서 제공하며, 구체적인 연동 규격은 협의를 통해 확정합니다.

---

## 4. Tech Stack

| Category | Technology |
|---|---|
| Frontend | React, TypeScript |
| Backend | NestJS, TypeScript |
| AI Agent | Python, FastAPI |
| Database | PostgreSQL |
| Infrastructure | AWS, Docker, Docker Compose |
| CI/CD | Jenkins (이미지 빌드·SSH 파일 전송·수동 선택 배포 검증 완료) |
| Version Control | GitLab |

기술 스택은 프로젝트 개발 과정에서 변경되거나 확장될 수 있습니다.

---

## 5. Project Structure

```text
dva/
├── frontend/          # 관리자 웹
├── backend/           # 비즈니스 로직 및 REST API
├── ai-agent/          # 음성 기반 AI 에이전트
├── infra/             # 인프라 관련 설정
├── docs/              # 프로젝트 관련 문서
├── compose.yaml       # Docker Compose 구성
└── README.md
```

각 영역은 담당 역할에 따라 개발하며, 공통 인프라 설정과 배포 구성은 프로젝트 단위로 관리합니다.

---

## 6. Development Status

현재 초기 개발 환경을 구축하고 있으며, 주요 서비스 기능은 개발 예정입니다.

| 항목 | 상태 |
|---|---|
| 프로젝트 초기 구조 구성 | 완료 |
| Docker Compose 통합 환경 구축 | 완료 |
| Backend · AI Agent · DB 연결 검증 | 완료 |
| 핵심 서비스 기능 구현 | 진행 예정 |
| AWS 인프라 배포 | Lightsail 기본 서비스 배포·내부 연결 검증 완료 |
| Jenkins CI/CD 구성 | 이미지 빌드·수동 선택 Lightsail 배포 검증 완료 |
| PBX 통화 종료 웹훅 | IP HTTPS·인증·DB 저장 검증 완료, 디버 실제 통화 연동 협의 대기 |

---

## 7. Documentation

현재 선택한 Lightsail 배포 방식은 이미지 파일 전송이다.
[파일 생성·SSH 전송·배포·롤백 가이드](infra/deploy/README.md)를 참고한다.

- [고정 IP HTTPS·인증서 자동 갱신](infra/https/README.md)
- [PBX 통화 종료 웹훅 규격·토큰 전달·검증](infra/webhooks/PBX-CALL-ENDED.md)
- [모놀리식 백엔드 개발 환경·공통 API 처리·자동 검증](backend/README.md)

상세 설계 및 개발 관련 문서는 `docs/` 디렉터리에서 관리합니다.

- 시스템 아키텍처 및 설계 문서
- API 및 데이터베이스 설계
- AI 에이전트 설계 및 검증
- 개발 환경 및 Docker 구성
- CI/CD 파이프라인 및 배포 가이드

---

**SSAFY 15기 · D109 | 디버 기업연계 프로젝트**
