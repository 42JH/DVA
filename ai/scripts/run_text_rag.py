"""텍스트 질문→LLM 도구 호출→실제 검색/Qwen→최종 답변을 기록한다."""

import argparse
import asyncio
import hashlib
import json
import os
import time
import tomllib
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

from app.rag.text_agent import answer_question
from scripts.evaluate_retrieval import load_cases


AI_DIR = Path(__file__).resolve().parent.parent


def save_report(path, report):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding='utf-8')
    for attempt in range(8):
        try:
            temporary.replace(path)
            break
        except PermissionError as error:
            # Windows 읽기/백신 검사와 원자적 교체가 잠깐 겹칠 수 있다.
            # 영구 권한 오류를 숨기지 않고 확인된 Windows 잠금 코드만 짧게 재시도한다.
            if getattr(error, 'winerror', None) not in (5, 32) or attempt == 7:
                raise
            time.sleep(min(.02*2**attempt, .25))


async def run(args):
    from dotenv import load_dotenv
    from openai import AsyncOpenAI
    from scripts.local_text_search import LocalTextSearch

    load_dotenv(AI_DIR / '.env', override=False)
    if not os.getenv('OPENAI_API_KEY') or not os.getenv('QDRANT_API_KEY'):
        raise ValueError('OpenAI와 Qdrant 인증 환경변수가 필요합니다.')
    from app.live_session import backend_settings
    settings = backend_settings(tomllib.loads((AI_DIR / 'config/live.toml').read_text(encoding='utf-8')))
    model = settings['model']
    effort = settings.get('reasoning', {}).get('effort', 'low')
    instructions_path = AI_DIR / 'prompts/drafts/text_rag_eval.md'
    instructions = instructions_path.read_text(encoding='utf-8')
    if args.question:
        cases, selection = [{'id': 'manual_question', 'question': args.question}], {'selected': 1}
    else:
        cases, selection = load_cases(args.dataset)
        if args.id:
            wanted = set(args.id)
            cases = [case for case in cases if case['id'] in wanted]
            if {case['id'] for case in cases} != wanted:
                raise ValueError('지정한 평가 문항을 찾을 수 없습니다.')
        if args.limit:
            cases = cases[:args.limit]
    selection = {**selection, 'run_count': len(cases)}
    contract = {'model': model, 'reasoning_effort': effort, 'selection': selection,
                'ids': [case['id'] for case in cases],
                'questions_sha256': hashlib.sha256(json.dumps([c['question'] for c in cases], ensure_ascii=False).encode()).hexdigest(),
                'prompt_sha256': hashlib.sha256(instructions.encode()).hexdigest(),
                'template_sha256': hashlib.sha256((AI_DIR/'prompts/rag_context.md').read_bytes()).hexdigest(),
                'source_sha256': hashlib.sha256((AI_DIR/'manuals/delivery_faq.md').read_bytes()).hexdigest(),
                'descriptions_sha256': hashlib.sha256((AI_DIR/'config/rag-search-descriptions.json').read_bytes()).hexdigest()}
    if args.output.exists():
        report = json.loads(args.output.read_text(encoding='utf-8'))
        if report['contract'] != contract:
            raise ValueError('재개할 실행의 입력·모델·프롬프트가 다릅니다. 새 출력 경로를 사용하세요.')
    else:
        report = {'status': 'running', 'contract': contract, 'records': [],
                  'started_at': datetime.now(timezone.utc).isoformat(), 'concurrency': args.concurrency,
                  'versions': {name: version(name) for name in ['openai', 'langchain-core', 'qdrant-client']}}
        save_report(args.output, report)
    done = {row['id'] for row in report['records'] if row['status'] == 'completed'}
    pending = [case for case in cases if case['id'] not in done]
    if not pending:
        print('모든 질문이 이미 완료됐습니다. 추가 API 호출 없음.')
        return
    if args.qwen_python:
        search = await asyncio.to_thread(LocalTextSearch, args.qwen_python)
    else:
        from scripts.remote_text_search import RemoteTextSearch
        search = await asyncio.to_thread(RemoteTextSearch)
    report['search'] = search.info
    print(f'검색 준비 완료 / 답변 모델 {model} / 대상 {len(cases)}개 / 남은 {len(pending)}개', flush=True)
    semaphore = asyncio.Semaphore(args.concurrency)
    try:
        async with AsyncOpenAI(timeout=60, max_retries=1) as client:
            async def one(case):
                async with semaphore:
                    try:
                        # 정답 제목·reference·required_facts는 답변 함수에 넘기지 않는다.
                        result = await answer_question(client, case['question'], search, instructions=instructions,
                                                       model=model, reasoning_effort=effort)
                        row = {'id': case['id'], 'question': case['question'], 'status': 'completed', **result}
                    except Exception as error:
                        row = {'id': case['id'], 'question': case['question'], 'status': 'failed',
                               **getattr(error, 'partial', {}),
                               'error_type': getattr(error, 'error_type', type(error).__name__),
                               'http_status': getattr(error, 'status_code', None)}
                    report['records'] = [old for old in report['records'] if old['id'] != case['id']] + [row]
                    save_report(args.output, report)
                    print(f"완료 {len(report['records'])}/{len(cases)} | {case['id']} | {row['status']}", flush=True)
                    return row
            # 설정·권한 오류로 전체 문항을 반복 실패하지 않도록 첫 한 건을 먼저 확인한다.
            first = await one(pending[0])
            if first['status'] != 'completed':
                report['status'] = 'blocked'
            else:
                await asyncio.gather(*(one(case) for case in pending[1:]))
                report['status'] = 'completed' if all(row['status'] == 'completed' for row in report['records']) else 'partial'
    finally:
        search.close()
        save_report(args.output, report)
    print(f'결과 저장: {args.output}', flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=AI_DIR/'evaluation/datasets/faq_v1/cases.json')
    parser.add_argument('--question')
    parser.add_argument('--id', action='append')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--concurrency', type=int, default=3)
    parser.add_argument('--qwen-python', type=Path, help='과거 로컬 CUDA 재현용. 생략하면 운영 /rerank 사용')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 4 or (args.limit is not None and args.limit < 1):
        parser.error('동시성 1~4, limit 양수를 사용하세요.')
    if args.question and (args.id or args.limit):
        parser.error('직접 질문과 평가 문항 선택을 섞지 마세요.')
    try:
        asyncio.run(run(args))
    except Exception as error:
        raise SystemExit(f'텍스트 실험 실패: {type(error).__name__}. 외부 오류 원문은 출력하지 않습니다.') from None


if __name__ == '__main__':
    main()
