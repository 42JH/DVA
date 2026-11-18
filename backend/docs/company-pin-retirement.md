# 기업 PIN 테이블 제거·과거 주문 호환

새 앱은 `053-drop-company-pins.sql`을 기준으로 한다. 이 변경은 로컬 구현이며 실제 운영 DB 삭제·배포는 별도다. 기존 migration 원본은 보존한다.

## API와 데이터

- 기업 공유 배송지는 계속 활성 사원의 현재 고객 주소다. DIR-01은 관리자 세션 또는 기존 AI Bearer 인증을 허용한다. 주소 없는 사원·사번 조회에는 별도 관리자 사원 검색을 사용한다. [검색 계약](../../docs/api/company-directory.md)·[관리자 검색](../../docs/api/company-members-search.md)을 따른다.
- 기업 PIN 등록·수정·목록 API는 계속 404다. 새 주문·새 상세의 COMPANY originPin은 400이다. 기업 배송지 선택은 주소 사본을 전송한다.
- 과거 주문의 COMPANY originPin 번호와 주소 사본, 결제·배송·감사는 유지한다. 주문 조회·최종 접수는 없어진 테이블을 조회하지 않는다. 결제 자격·기존 주문 권한·버전·처리 중 보호는 계속 검증한다.
- 기존 상세의 같은 COMPANY 참조·같은 출발지 주소를 유지하는 PATCH는 허용한다. 주소를 바꾸면 `originPin: null` 또는 유효한 PERSONAL로 전환한다. COMPANY 번호 변경·다른 상세에 복사·신규 선택은 400이다.
- PERSONAL의 소유권·활성 고객·통화 범위·수정·중복·버전·보존 정책은 유지한다. 고객 응답의 `companyPins: []`와 기업 사용 구분 COMPANY도 유지한다.
- 기업·부서 삭제나 부서명 변경은 더 이상 기업 PIN을 수정하거나 새 COMPANY_PIN 감사를 만들지 않는다. 이미 저장된 COMPANY_PIN 감사는 조회·보존한다.

## 삭제 전 현황 확인

운영 환경에서 담당자가 백업·보관 범위를 정할 때 아래 읽기 전용 집계를 사용할 수 있다. 결과의 실제 행·주소·전화번호·토큰을 문서나 로그에 복사하지 않는다. 이 문서 작성 중 운영 DB에 실행하지 않았다.

```sql
BEGIN READ ONLY;
SELECT count(*) AS total,
       count(*) FILTER (WHERE deleted_at IS NULL) AS current_rows,
       count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted_rows
FROM company_pins;
SELECT o.status, count(*) AS referenced_parcels
FROM order_parcels p JOIN orders o USING(order_seq)
WHERE p.origin_pin_scope='COMPANY'
GROUP BY o.status ORDER BY o.status;
COMMIT;
```

삭제되는 기업 PIN 원본 전체가 주문에 복사돼 있다고 가정하지 않는다. 보존 대상·보관 기간에 대한 기존 정책을 확인하고 필요한 원본은 접근이 제한된 백업으로 보관한 후 삭제한다. 새 고객 주소로 자동 합치거나 과거 주문 참조를 null로 일괄 변경하지 않는다.

## 배포·복구

1. FE는 새 관리자 API로 전환하고 AI는 기존 기업 검색에 업무 토큰·100자 처리를 준비한다. AI·FE 소스와 실제 배포는 각 담당자가 진행한다.
2. 테이블을 참조하는 기존 앱·워커를 중지한다. 앱과 보존 워커의 전환을 함께 진행하며, 코드 정리 버전을 장기간 단독 운영한 뒤 나중에 DROP하는 방식은 사용하지 않는다. 삭제 전에는 남아 있는 기업 PIN FK가 물리 보존 정리에 영향을 줄 수 있다.
3. 기존 runner `infra/database/migrate.sh`로 백업·체크섬 확인 후 053을 적용하고 `infra/database/verify.sql`을 실행한다. 새 앱과 삭제 migration을 같은 전환으로 적용한다.
4. 새 앱 실행 후 관리자 검색·AI 검색, 개인 PIN, 과거 COMPANY 주문 조회·수정·최종 접수, 기업·부서 삭제, 보존 워커를 확인한다.
5. 테이블이 사라진 DB에는 053 호환 변경이 없는 구버전 이미지를 실행하지 않는다. 배포 도구는 이 경우 배포·명시적 롤백·자동 복귀를 차단한다. 호환 버전으로 복구하거나 점검 시간에 백업을 별도 복원해 비교한 후 복구한다. 전환 후 새 데이터를 검토하지 않고 운영 DB 전체를 덮어쓰지 않는다.

DROP은 기업 PIN 행·전용 인덱스·제약·트리거·소유 시퀀스를 제거한다. 공유 `guard_pin_update()`·`pin_identity()` 등 개인 PIN 기반은 남긴다. CASCADE로 외부 의존을 강제로 지우지 않으므로 예상하지 못한 의존이 있으면 migration이 실패하고 기존 runner 트랜잭션을 롤백한다.

검증 대상은 신규 DB 전체 적용, 052 데이터가 있는 DB의 053 업그레이드, 실패 롤백·runner 재실행·백업 복원, 개인 PIN과 주문/감사 사본의 보존이다. 최종 public 스키마는 테이블 29개·FK 25개·업무 트리거 10개이며 PBX 수신 테이블은 별도 스키마다.
