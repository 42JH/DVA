# 주소 보정 전면 재설계 계획 (분석·설계, 구현 전)

작성 2026-11-05 · 기준 코드 develop-ai 6c8499f · 상태: **사용자 승인 대기**

## 1. 목표(사용자 요구)

- STT 전사 주소(순수 한글, 또는 번지·도로명에 숫자 일부 변환)를 **실제 존재하는 주소**로 바꿔 Live에 전달
- 시-구-도로명-건물번호 순이 제일 좋지만 **도로부터, 건물명만, 구 또는 동부터** 말해도 인식
- **지번 → 도로명주소** 변환
- STT 정확도가 낮아도 고객 의도에 가장 가까운 주소를 찾아 돌려줌
- 카카오 주소 검색의 `analyze_type=similar`도 활용

## 2. 현재 구현과 측정값

경로: Live가 들은 그대로 `record_fields(sender_address|receiver_address)` → `AddressService.resolve` → `app/address/matcher.resolve`(행안부 주소DB SQLite 612MB, 소리 비교) → `confirmed|ambiguous|not_found` → 카카오 `address.json`으로 지번·동명·우편번호(Geo) → 필드 기록 → 도구 결과(`needs_input ADDRESS_NOT_FOUND` / `ok` + facts)로 Live에 전달.

| 항목 | 값 |
|---|---|
| 회귀 시험지 `address_v1` | 121문항: 실제 주소 106/106 정답(확정 104·애매→1순위 2), 없는 주소 15/15 거부 (`results/address_v1_stage2b.json`) |
| 지연(보정만, 카카오 제외) | warm p50 8ms · p95 100ms · max 443ms |
| 주소DB 규모 | 도로명 143,704(시군구별 174,386) · 법정동·리 18,716 · 건물 6,424,995 · 지번 8,195,538 |

**구조적 전제**: `matcher.match_region`이 토큰 앞에서 시도→시군구를 **반드시** 찾아야 도로를 본다. 시도 생략은 되지만(시군구가 정확히 들렸을 때) 시군구까지 없으면 scope가 비어 `not_found`.

## 3. 요구 대비 격차

| 요구 | 지금 | 격차 |
|---|---|---|
| 시-구-도로-번호 | 됨(소리 보정 포함) | — |
| 도로부터("테헤란로 212") | `not_found` | 지역 없이 도로를 찾는 전국 경로가 없음 |
| 건물명만("롯데월드타워") | `not_found` | 건물명 자료가 DB에 없음(부가정보 미적재) |
| 구부터("강남구 테헤란로 212") | 됨 | — |
| 동부터("역삼동 테헤란로 212", "역삼동 737") | `not_found` | 읍면동을 지역 단계로 안 봄(구 뒤에 오면 무시만 함) |
| 지번 → 도로명 | 됨(지역이 있을 때) | 지역 없는 지번은 위와 같이 실패 |
| STT 오류 내성 | 도로명·지역명 소리 거리, 한글 숫자, 길 번호 연음 | 건물번호는 정확 일치만(2026-11-05 사용자 결정, 유지) |

전국 도로명 중복이 크다: "중앙로" 92개 시군구, "신촌길" 50, "교동" 18개 시군구. 사용자의 이전 실험(`kakao_map_test/result_300_fulldb.txt`)에서 지역 생략 실패 7건이 모두 **다른 지역의 같은 도로명**이었다. 지역 없는 발화는 "찾았다/못 찾았다"가 아니라 **"어느 지역인지 되묻기"**가 정답인 경우가 많다.

## 4. 주소 자료원 비교("다른 DB 써도 됨")

| 후보 | 장점 | 단점 | 판단 |
|---|---|---|---|
| 행안부 주소DB(현재) + **부가정보 추가** | 오프라인·8ms, 소리 보정 가능, 건물명 702,163건(고유 405,856)·우편번호·행정동 보유 | 재빌드·재업로드(+용량), POI 상호명 없음 | **채택** |
| 카카오 로컬 단독 | 건물명·POI, `similar` | 소리 오류에 약함: 사용자 실험 Top5 36%(원문)·46%(전처리) vs 로컬 보정 98% | 보강용만 |
| juso.go.kr 검색 API | 공공·무료 | 키워드식, 소리 보정 없음, 네트워크 | 이번엔 안 씀 |

카카오 `analyze_type=similar` 원문: "입력한 건물명과 일부만 매칭될 경우에도 확장된 검색 결과 제공(기본값)". 즉 **건물명이 섞인 주소**에 맞는 옵션이다. 키워드 장소 검색(`keyword.json`)은 상호·POI에 맞다. 무료 일 100,000건(각 API), 초과 시 429 (`developers.kakao.com/docs/ko/getting-started/quota`).

## 5. 설계

원칙: 지역이 잡히는 발화는 **지금 경로 그대로**(v1 106/106 유지). 지역이 안 잡히거나 못 찾았을 때만 새 경로를 더한다. 외부(BE·PBX) 계약 변경 없음. 바뀌는 것은 내부 도구 계약(사유 코드 1개 추가)과 정책 문구.

### 5.1 지역 해석: 단계를 선택적으로
`시도 → 시군구 → 읍면동(법정동·리, 행정동)` 순으로 앞에서부터 **있으면 먹고 없으면 건너뜀**. 읍면동 단계를 새로 둔다(`areas` + 부가정보 행정동명). 결과는 scope `(시도, 시군구)` 집합과 선택적 읍면동 제한. 아무 단계도 안 맞으면 scope = 전국.
- "역삼동 테헤란로 212": 역삼동(전국 1곳) → 강남구 scope → 기존 도로 경로
- "역삼동 737": 같은 scope → 기존 지번 경로
- "교동 12": 교동이 18개 시군구 → 번지가 실제로 있는 곳만 남김 → 여러 곳이면 지역 되묻기

### 5.2 전국 이름 색인(새 테이블)
`names(kind, text, canon, sido, sigungu, ref)` + FTS5 **trigram**(SQLite 3.50 확인) on `canon`(발음 정규화 자모).
- kind=road 174,386행(시군구별), area 18,716행, building(시군구용건물명·건축물대장건물명, (시군구, 이름)별 1행) ≈ 50만 행 [빌드 후 측정]
- 질의: 들은 이름의 canon을 trigram OR로 MATCH → bm25 상위 N(200)만 Python `phonetic.distance`로 재순위. scope가 있으면 `sido/sigungu`로 제한. 지연 목표 수십 ms [측정 필요].
- 지역 있는 발화는 기존 `RoadDict` 경로를 그대로 쓰고, 색인은 **scope가 비었을 때**와 **건물명 경로**에서만 쓴다(회귀 0, 코드 최소).

### 5.3 건물명 경로
도로·지번 경로가 비고 남은 토큰에 숫자가 없으면(또는 숫자 뒤 이름이 남으면) 건물명 색인 검색(scope 있으면 제한, 없으면 전국) → 건물 → 도로명주소. 같은 주소로 모이면(아파트 동별 행) 1건으로 합친다. 잡음(405,856 고유명, "현대아파트" 다수)이 커서 건물명 단독은 **거리 임계를 엄격히**, 여러 시군구에 걸치면 지역 되묻기. 색인에 없는 상호(POI)는 5.5 카카오 키워드로.

### 5.4 판정과 결과(내부 계약)
`Resolution.status`에 **`region_needed`** 추가: 같은 이름·번호가 **서로 다른 시군구**에 실제로 있을 때(후보 지역 이름표 최대 3). P6(애매하면 1순위 자동 확정)는 **같은 시군구 안의 애매함에만** 적용 — 다른 지역을 자동으로 고르면 오배송이라 확정하지 않는다(AGENTS.md §6 "검증되지 않은 정보 확정 금지").
- `record_fields`: `needs_input` 사유 `ADDRESS_REGION_NEEDED`, `needs[].regions=[...]`, `needs[].heard=<들은 주소>`
- 정책 문구(policy/business_rules.md·backend_rules.md): 서버가 지역을 물으라고 하면 "{도로명}이 여러 지역에 있어 어느 시·군·구인지" 묻고, 고객이 지역을 말하면 **앞서 들은 도로명·번호와 합쳐** 전체 주소로 다시 넘김(서버가 합치지 않음 — 코드 최소. 운영 통화로 확인)
- `confirmed`·`ambiguous`·`not_found`·`off`·`error`는 그대로. 건물명으로 찾은 주소도 `confirmed`로 기록하고 별도 확인 단계는 두지 않는다(되읽기가 전체 주소를 읽음).

### 5.5 카카오 보강(`similar` + 키워드) — 로컬이 못 찾았을 때만
키가 있고 로컬이 `not_found`이며 이름 토큰이 있으면, 남은 예산 안에서 **둘을 병렬로**(독립 읽기, AGENTS.md §7):
1. `address.json?analyze_type=similar&query=<들은 주소>` → `road_address.address_name`들
2. `keyword.json?query=<이름 토큰>` → `road_address_name`들
받은 주소는 **로컬 DB로 검증**한 것만 채택(도로·건물번호가 실제로 있고, 들은 번호와 같음 — 2026-11-05 규칙 유지). 1건이면 `confirmed`, 같은 시군구 여럿이면 `ambiguous`, 다른 시군구면 `region_needed`. 검증 실패·429·타임아웃은 `not_found` 유지(근거 없는 확정 금지). 전송 범위: 주소 문자열(지금 geocode와 동일)·이름 토큰.

### 5.6 Geo 로컬화(선택, 측정 후)
부가정보 우편번호 + `jibun`(지번) + `areas`(법정동)로 `Geo(jibun_address, dong_name, postal_code)`를 로컬 생성 → 카카오 geocode 1회(네트워크)를 보통 경로에서 제거. 읍·면 지역 `dong_name` 표기(카카오 `region_3depth_name`과 같은지) [미확인] → 시험지 전체를 두 방식으로 돌려 **일치율을 재고** 채택. 카카오는 불일치·누락 시 fallback.

### 5.7 DB 빌드·배포
- `gazetteer.build`: 부가정보 적재(우편번호·행정동·건물명·공동주택 여부), `names` + FTS. 한 번 재빌드(현 2~3분 + FTS 빌드 [측정]), 용량 612MB → [측정].
- 서버 `shared/data/address.db` 재업로드(`deploy/upload.sh` 규약). 샘플 DB(`app/tests/address_sample_db.py`) 스키마 동기화.
- 기동: `open_db`가 `names` 테이블을 확인, 없으면 **기동 실패 + 재빌드 안내**(배포 실수를 바로 드러냄; 구 경로로 조용히 축소하지 않음).

## 6. 영향 범위

| 파일 | 변경 |
|---|---|
| `app/address/gazetteer.py` | 스키마(부가정보·names·FTS), 빌드, 조회 메서드 |
| `app/address/matcher.py` | 선택적 지역 단계, 전국·건물명 경로, `region_needed` |
| `app/address/parse.py` | 이름/숫자 토큰 분리 보조(최소) |
| `app/integrations/address.py`, `kakao.py` | 카카오 `similar`·키워드 호출(공유 클라이언트·세마포어·예산), 검증 |
| `app/tools/record.py` | `ADDRESS_REGION_NEEDED` 분기 |
| `policy/business_rules.md`, `backend_rules.md` | 지역 되묻기·합치기 문구 |
| `app/tests/test_address.py`, `test_tools.py`, `address_sample_db.py` | 새 경로·사유·스키마 |
| `scripts/evaluate_address.py`, `evaluation/datasets/address_v2.json` | 새 상태 분류, 새 문항 |
| `docs/contracts/tool-contracts.md`, `docs/architecture/error-recovery.md`, `decisions.md` | 사유 코드·P6 범위 |

유지: BE API 전부, PBX, `AddressResult`·`Geo` 모양, 기존 `address_v1` 결과(106/106·15/15).

## 7. 측정 계획
- `address_v2`(약 40문항, 정답 먼저 정함): road_only, building_only, building_typo, dong_first, dong_jibun_no_gu, poi, region_needed(정답 = 되묻기), 기존 v1 전부 회귀.
- 0단계에서 **현 코드로 v2 기준선**을 재 격차를 수치로 남김. 각 단계마다 v1·v2 정확도 + p50/p95(로컬·카카오 분리) + 동시 8스레드 결과 동일성.
- 카카오 문항은 단위 시험에선 가짜 transport, 측정 스크립트는 `--kakao`(키 있을 때만).

## 8. 단계(각 단계 = 시험 + worklog + 커밋)
0. v2 시험지 + 현 코드 기준선
1. gazetteer 확장(부가정보·names·FTS) + 샘플 DB + 재빌드·측정
2. matcher: 선택적 지역 단계·전국 경로·건물명 경로·`region_needed` + record 사유 + 정책 문구 + 문서
3. 카카오 `similar`·키워드 보강(로컬 검증) + 가짜 transport 시험
4. (선택) Geo 로컬화 — 일치율 측정 후 결정

## 9. 결정 필요(사용자)
1. 다른 시군구에 걸친 중복은 자동 확정(P6) 대신 **지역 되묻기** — 권고: 되묻기
2. 되묻은 지역과 앞서 들은 주소 합치기: 모델이 합쳐 재전달(권고, 코드 최소) vs 서버가 직전 들은 값과 합침
3. 카카오 키: 로컬 `.env`에 없음, 운영 보유 여부 [미확인]. 보강 호출(실패 시 최대 +2건/주소) 승인 여부
4. 새 DB 없이 기동 시 실패(권고) vs 구 경로 유지
5. 4단계 Geo 로컬화 추진 여부
6. 고객 맥락(등록 주소 지역)을 지역 없는 발화의 우선순위에 쓸지 — 권고: 이번엔 안 씀(받는 곳은 무관)

## 10. 위험
- 건물명 색인 잡음·전국 중복 → 되묻기가 잦아질 수 있음(측정으로 임계 조정)
- FTS 후보 상한(200)으로 긴 이름·심한 오인식 누락 가능 → 상한을 측정으로 정함
- DB 용량·재업로드, FTS 질의 지연 [측정 전 단정 금지]
- 카카오 의존(429·지연)은 로컬 검증 + 예산으로 격리, 로컬 결과는 영향 없음
- 정책 문구 변경이 Live 발화에 미치는 영향은 운영 통화로만 확인 가능
