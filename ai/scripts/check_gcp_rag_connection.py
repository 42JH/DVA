"""배포 연결 확인. 공개 질문 3개 임베딩 + DB 읽기 + GCP 재정렬, 답변 LLM/PBX 없음."""
import asyncio
import json

from app.config import ROOT, load_server_config
from app.rag.service import RagService


async def main():
    from dotenv import load_dotenv
    load_dotenv(ROOT/'.env', override=False)
    service = RagService(load_server_config().rag)
    reports = []
    try:
        await service.warmup()
        for question, expected in [
            ('무인지점에서 소형 택배를 보내면 얼마인가요?', 'Q. 요금은 얼마인가요?'),
            ('실제 배송은 어느 택배 업체가 맡나요?', 'Q. 어느 택배사로 가나요?'),
            ('택배를 착불로 보낼 수 있나요?', 'Q. 착불도 되나요?'),
        ]:
            result = await service(question)
            titles = [row['title'] for row in result['context']['evidence']]
            reports.append({'question': question, 'expected_title': expected, 'top3': titles,
                            'hit3': expected in titles, 'timings': result['timings']})
    finally:
        await service.close()
    target = ROOT/'data/private/gcp/rag-connection-check.json'
    target.write_text(json.dumps({'records': reports, 'note': '구축 연결 점검3건.95문항 재평가나 통화 평가가 아님.'},
                                 ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(reports, ensure_ascii=False, indent=2))
    if not all(row['hit3'] for row in reports):
        raise RuntimeError('기대 FAQ가 Top3에 없는 점검 문항이 있습니다.')


if __name__ == '__main__':
    asyncio.run(main())
