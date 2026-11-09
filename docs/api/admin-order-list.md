# 관리자 주문 목록 화면 API

디자인/목업 03_주문내역 기준: [화면](https://www.figma.com/design/KF2OWGsro61o3hYGPZQyp9/디버?node-id=1000-1969).

`GET /api/admin/orders` · 활성 관리자 쿠키 세션 전용. 기존 AI/관리자 공용 `GET /api/orders`는 유지한다.

| query | 설명 |
| --- | --- |
| q | 보내는 분·받는 분의 이름·전화번호·도로명/지번/상세 주소 부분 검색. NFC·대소문자 무시, %·_는 일반 문자. 숫자·공백·전화번호 구분자만 있는 검색은 전화번호 구분자를 제거해 비교. 최대 200자 |
| from / to | 주문 생성 시각. from 포함·to 미포함, 시간대가 있는 ISO8601. from은 to보다 빨라야 함 |
| statusGroup | 전체 생략. COLLECTING=접수 중, notPaid=결제 대기, PAID=결제 완료, CANCELLED=주문 취소. PAID 탭은 PAID·SUBMITTING·ACCEPTED·SUBMISSION_FAILED 포함 |
| limit / offset | 기본 20/0, limit 1~100. 주문 단위 페이지 |

응답은 `{data:[주문],hasNext,total_count}`다. total_count는 모든 조건 적용 후 페이지 제한 전 주문 수이며 빈 페이지에서도 유지한다. 생성 시각·주문 번호 내림차순이다.

| 화면 | 필드 |
| --- | --- |
| 행 식별·상세 열기 | orderSeq → 기존 GET /api/orders/{id} |
| 상태 | status는 실제 주문 상태. COLLECTING/접수 중, notPaid/결제 대기, PAID·SUBMITTING·ACCEPTED·SUBMISSION_FAILED/결제 완료, CANCELLED/주문 취소로 표시. 접수 성공은 ACCEPTED만 해당 |
| 접수 시각 | createdAt(ISO8601), 브라우저에서 한국 시각으로 표시 |
| 수거 희망일시 | pickupRequestedAt(ISO8601 또는 null) |
| 보내는 분 | parcels[].origin.name·phoneNumber·roadAddress·jibunAddress·detailAddress |
| 받는 분 | parcels[].destination의 같은 필드 |
| 품목 | parcels[].documentCount·smallBoxCount·mediumBoxCount·bigBoxCount·otherItemDescription |

주문당 한 줄이며 모든 배송상세를 parcels 배열로 순번대로 반환한다. orderParcelSeq는 상세 식별자, 상세 status는 ACTIVE/CANCELLED다. 취소 상세도 이력으로 포함하므로 프론트에서 구분한다. 상세 없는 주문은 parcels=[], 미수집 주소 필드는 null, 수량은 저장값(기본 0), 기타 설명은 저장값(기본 빈 문자열)이다. 현재 고객·PIN 테이블 대신 주문에 저장한 주소를 사용한다.

주문 저장 전의 진행 중 통화는 표시하지 않는다. 결제 정보·좌표·PIN·요청키·배송 이력·CSV 전용 필드는 포함하지 않는다. CSV 내보내기는 기존 상세 조회와 별도로 연결한다.

잘못된 검색·기간·상태·페이지는 400, 세션 없음·만료·비활성은 401, 권한 오류는 403이다. Cache-Control은 no-store다. 이 조회에는 DB migration이 필요 없다.
