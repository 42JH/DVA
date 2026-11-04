"""주소 보정(외부 SDK 없음): 받아쓴 주소를 행안부 주소DB의 실제 도로명주소로 바로잡는다.

numbers(한글 숫자) · phonetic(소리 비교) · parse(말 다듬기·재시도 표기) · matcher(후보 찾기·판정, 입구 resolve)
· gazetteer(주소DB 조회·빌드). 실행기·시간 예산·카카오는 app/integrations/address.py.
"""
