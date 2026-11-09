# 통화 불만 판정·미완료 주문 후속 작업

기준: develop-backend `319de6fb`, 작업 브랜치 `feature/complaint-draft-follow-up`.
사용자가 MR !383 반영과 해당 코드 수정을 승인했다. 기존 테스트 정리·홈·최적화는 유지한다.

## 확정 범위와 순서

1. MR !383의 불만 판정 기능을 반영하되 최신 실행 목록에 새 테스트만 연결한다. 발화 미수집의 false 오판과 fill 재진입의 동시 처리 상한 초과를 고친다. 기존 분석·읽기 경로와 실제 guard를 회귀 검증한 뒤 커밋한다.
2. 배송 초안에 orders와 같은 시퀀스의 예약번호를 추가한다. 관리자 재개는 원본 예약번호를 이어 쓰고, AI의 여러 완성 배송은 기존처럼 한 주문으로 묶어 대표 초안 예약번호를 쓴다. 나머지 예약번호는 사용하지 않는다. 기존 미완료에도 새 번호를 부여하고 legacyOrderSeq는 원본 참조로 보존한다. 이는 사용자가 두 질문에 명시적으로 확정한 기준이다.
3. 관리자 주문 목록에 INCOMPLETE를 COLLECTING 행으로 통합한다. 전체 total_count·statusCounts.all에도 포함하고 statusGroup=COLLECTING은 초안을 조회한다. 생성 시각·검색·기간·기업·페이지 조건을 적용하며 draftSeq로 리소스를 구분한다. 실제 주문 상세·결제·보관·동시성·멱등성은 유지한다.
4. 번호·취소·통화 306번 분석 상태·미완료 이어가기의 현재 동작을 실제 읽기 전용 데이터와 코드로 확인해 보고한다. 해당 네 항목의 추가 정책 변경은 원인 보고 후 별도 지시를 따른다.

## 1단계 검증

- 수정 전 새 회귀 두 사례를 Docker checks에서 실행해 실제로 2개가 실패함을 확인했다.
- 수정 후 `BACKEND_TEST_PROFILE=analysis node backend/scripts/check.cjs` 종료 코드 0. 단위 214·결제 데모 21·격리 DB/API 161·운영 이미지/Nginx/HTTPS 13 = 409개 통과, 실패·취소·skip 0. 컴파일·ESLint·Prettier 포함, 외부 OpenAI와 실제 S3는 호출하지 않았다.
- 신규 DB 회귀는 발화가 없는 분석을 집지 않고, 같은 통화에 발화 이벤트가 늦게 도착하면 판정하는 경로를 검증한다. 정상 판정·재시도·녹음 대기·다중 워커 경합은 기존 MR 테스트로 확인했다.
- 원래 MR의 057 migration·환경 변수·compose 전달·AI 판정 규칙을 유지한다. 운영 키 등록·migration 적용·배포·MR 병합은 실행하지 않았다.

## 2단계 검증

- 058으로 기존 초안에도 같은 orders 시퀀스의 예약번호를 부여한다. 원본 참조·주문 행·생성/보관 시각을 보존하고 재개 시 번호 소유권을 원자적으로 옮긴다.
- 최초 전체 검증은 orders의 ALWAYS IDENTITY 열에 명시 값을 넣는 경로가 실패했다. 기존 identity 제약을 바꾸지 않고 내부 INSERT에 OVERRIDING SYSTEM VALUE를 적용한 뒤 전체를 다시 실행했다.
- `BACKEND_TEST_PROFILE=full node backend/scripts/check.cjs` 종료 코드 0. 단위 214·결제 21·격리 DB/API 647·운영 이미지 13 = 895개 통과, 실패·취소·skip 0, 총 244,952ms.
- 실제 DB로 058의 기존 데이터 backfill·예약 유일성·legacy 참조·주문 미생성, 생성 재전송 번호 보존, 관리자 이어가기의 동일 번호 접수, 여러 READY 배송의 대표 번호 한 건 전환, 기존 권한·결제·동시성·롤백을 검증했다.
