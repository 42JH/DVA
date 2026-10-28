"""별도 로컬 Python 환경에서 Qwen을 한 번 로드하고 JSON 한 줄씩 재정렬한다."""

import argparse
import json
import math
import sys
from pathlib import Path
from time import perf_counter

from app.rag.qwen import MODEL, QwenReranker


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-info', type=Path, required=True)
    args = parser.parse_args()
    info = json.loads(args.model_info.read_text(encoding='utf-8'))
    if info['model'] != MODEL or info['revision'] != 'e61197ed45024b0ed8a2d74b80b4d909f1255473':
        raise ValueError('기준선 Qwen 모델과 revision이 필요합니다.')
    model = QwenReranker(info['snapshot'], 'float16', 1024)
    model.predict([('준비 확인', '합성 준비 문장')])
    print(json.dumps({'ready': True, 'model': MODEL, 'revision': info['revision']}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            docs = request['documents']
            if not 1 <= len(docs) <= 5 or len({doc['chunk_id'] for doc in docs}) != len(docs):
                raise ValueError('후보 수 또는 ID가 올바르지 않습니다.')
            started = perf_counter()
            scores = model.predict([(request['question'], doc['context']) for doc in docs])
            if len(scores) != len(docs) or any(not math.isfinite(score) for score in scores):
                raise ValueError('리랭커 점수가 올바르지 않습니다.')
            ranked = [{**doc, 'input_rank': rank, 'reranker_score': score}
                      for rank, (doc, score) in enumerate(zip(docs, scores), 1)]
            ranked.sort(key=lambda doc: (-doc['reranker_score'], doc['input_rank']))
            print(json.dumps({'results': ranked, 'seconds': perf_counter()-started}, ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({'error_type': type(error).__name__}), flush=True)


if __name__ == '__main__':
    main()
