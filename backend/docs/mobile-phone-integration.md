# 전화번호 입력 계약 — 고객 식별과 배송 연락처

최신 전달 사항은 [프론트 통합 명세](frontend-delete-admin-roles.md)와 [AI 전화번호 명세](recipient-phone-ai.md)를 따릅니다.

- 고객 등록·고객 확인·직원 번호는 기존대로 하이픈·공백 없는 ASCII 숫자 11자리 문자열입니다. 검색은 기존 부분 검색 계약을 유지합니다.
- 배송 origin.phoneNumber는 010·011·016·017·018·019로 시작하는 휴대전화 11자리만 받습니다.
- 배송 destination.phoneNumber와 PIN addressData.phoneNumber는 휴대전화 외 02 9~10자리, 031·032·033·041·042·043·044·051·052·053·054·055·061·062·063·064 10~11자리, 070 11자리도 허용합니다.
- 모든 연락처는 문자열이며 서버가 잘라내거나 0을 덧붙이지 않습니다. 하이픈·공백·국가번호·내선·줄바꿈·전각 숫자는 400입니다.
- 수집 중 생략·허용된 null, 기존 번호 조회, PBX 원문 국제 표기 수신은 유지합니다. 최종 접수에는 양쪽 연락처가 필수입니다.
- 최종 저장값 검증 실패는 422 VALIDATION_FAILED, field=parcels.{index}.{origin|destination}.phoneNumber, reason은 origin=mobilePhone/destination=phoneNumber입니다.
- 전화번호용 DB 변경은 없으며 기존 저장 데이터는 보존합니다. 관리자 역할 전환의 migration 066은 별개입니다.
