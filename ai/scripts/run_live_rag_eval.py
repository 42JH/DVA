"""고정 질문을 합성 음성으로 재생하고 실제 Live→검색→Live 발화를 기록한다."""

import argparse
import asyncio
import base64
import hashlib
import json
import os
import time
from pathlib import Path

from app.live_lab.bridge import DirectRagBridge, LabSession
from app.live_lab.config import load_lab_config
from scripts.run_text_rag import AI_DIR, save_report


BYTES_PER_SECOND = 24000 * 2


def valid_input_audio(pcm):
    """최소 형식·길이·비무음만 확인한다. 발음이나 질문 일치는 보장하지 않는다."""
    return BYTES_PER_SECOND <= len(pcm) <= BYTES_PER_SECOND*60 and len(pcm)%2 == 0 and any(pcm)


def settled(now, input_end, last_output, playback_end, jobs, has_answer, quiet):
    """완료 이벤트가 없으므로 수신·가상 재생·위임이 모두 조용해졌는지 판단한다."""
    return (input_end is not None and has_answer and not jobs
            and now - max(input_end, last_output, playback_end) >= quiet)


def generation_row(case, lab, status, timings, error_type=None):
    calls = []
    for trace in lab.traces:
        # 실패한 전달은 검색은 평가하되 실제 전달 문맥으로 둔갑시키지 않는다.
        call = {**trace.get('search_call', {}), 'question': trace.get('query'),
                'seconds': trace.get('search_seconds', 0),
                'evidence': trace.get('evidence', []) if trace.get('status') == 'delivered_to_live' else []}
        calls.append(call)
    answer = ''.join(event['delta'] for event in lab.events
                     if event['type'] == 'transcript' and event['role'] == 'assistant')
    return {'id': case['id'], 'question': case['question'], 'status': status, 'answer': answer,
            'tool_calls': calls, 'responses': [], 'total_seconds': None,
            'voice_timings': timings, 'live_trace': lab.snapshot(),
            **({'error_type': error_type} if error_type else {})}


async def one_question(client, bridge, cfg, case, pcm, quiet, timeout):
    lab = LabSession('pending', 'offline-evaluation', cfg)
    timings = {'input_audio_seconds': len(pcm)/BYTES_PER_SECOND,
               'completion_rule': f'위임 종료·전사/오디오/가상 재생 후 {quiet}초 침묵',
               'transport': 'primary_websocket', 'playback': '재생 없음; PCM 길이로 대기만 추정'}
    input_end = None
    last_output = playback_end = 0.0
    started = asyncio.Event()
    stream_started = None
    task = None
    status, error = 'failed', None
    try:
        async with client.live.connect(max_retries=0) as conn:
            lab.connection = conn
            async def receive():
                nonlocal last_output, playback_end
                async for event in conn:
                    value = event.model_dump() if hasattr(event, 'model_dump') else event
                    kind = value.get('type')
                    now = time.monotonic()
                    if kind == 'session.started':
                        lab.id = value['session']['id']
                        started.set()
                    elif kind in ('session.input_transcript.delta', 'session.output_transcript.delta'):
                        lab.transcript(value)
                        if kind == 'session.output_transcript.delta':
                            last_output = now
                            if input_end is not None:
                                timings.setdefault('input_end_to_first_transcript_seconds', now-input_end)
                            bridge.output_observed(lab, 'transcript', value)
                    elif kind in ('session.thinking.appended', 'session.commentary.appended'):
                        future = lab.pending.get(value.get('client_event_id'))
                        if future is not None and not future.done():
                            future.set_result(value)
                    elif kind == 'session.delegation.created':
                        delegation = value.get('delegation', {})
                        if delegation.get('target') == 'client':
                            for old in tuple(lab.jobs):
                                old.cancel()
                            lab.latest_delegation = delegation['id']
                            job = asyncio.create_task(bridge.delegate(lab, conn, delegation['id'], value.get('offset_ms')))
                            lab.jobs.add(job)
                            job.add_done_callback(lab.jobs.discard)
                    elif kind == 'session.output_audio.delta':
                        raw = base64.b64decode(value['delta'])
                        # 음성 자체는 저장하지 않는다. 무음 패킷을 응답에 세지 않는다.
                        if any(raw):
                            last_output = now
                            playback_end = max(now, playback_end)+len(raw)/BYTES_PER_SECOND
                            if input_end is not None:
                                timings.setdefault('input_end_to_first_audio_packet_seconds', now-input_end)
                            bridge.output_observed(lab, 'audio', value)
                    elif kind == 'error':
                        raise RuntimeError('Live 이벤트 오류')
                    elif kind == 'session.closed':
                        raise RuntimeError('Live 세션 조기 종료')
            receiver = asyncio.create_task(receive())
            try:
                configuration = {'model': cfg.live_model, 'store': False,
                    'instructions': (AI_DIR/'prompts'/cfg.voice_prompt).read_text(encoding='utf-8'),
                    'audio': {'format': {'type': 'audio/pcm', 'rate': 24000}, 'output': {'voice': cfg.voice}},
                    'delegation': {'type': 'client'}}
                await conn.session.start(session=configuration)
                # 수신 실패를 무시하고 시작 시간 제한까지 기다리지 않는다.
                ready_task = asyncio.create_task(started.wait())
                try:
                    done, _ = await asyncio.wait([ready_task, receiver], timeout=20, return_when=asyncio.FIRST_COMPLETED)
                    if receiver in done:
                        await receiver
                    if not started.is_set():
                        raise TimeoutError('Live 시작 대기')
                finally:
                    ready_task.cancel()
                stream_started = time.monotonic()
                async def send():
                    nonlocal input_end
                    # 500ms 앞부분 무음부터 시작하고 질문 뒤에도 무음을 실시간으로 보낸다.
                    data = b'\0'*(BYTES_PER_SECOND//2)+pcm
                    block = BYTES_PER_SECOND//20
                    n = 0
                    while True:
                        if n*block >= len(data) and input_end is None:
                            input_end = time.monotonic()
                        chunk = data[n*block:(n+1)*block]
                        chunk += b'\0'*(block-len(chunk))
                        await conn.session.input_audio.append(audio=base64.b64encode(chunk).decode())
                        n += 1
                        await asyncio.sleep(max(0, stream_started+n*.05-time.monotonic()))
                task = asyncio.create_task(send())
                deadline = time.monotonic()+timeout
                while time.monotonic() < deadline:
                    if receiver.done():
                        await receiver
                        raise RuntimeError('Live 수신 종료')
                    if task.done():
                        await task
                    has_answer = any(e['type'] == 'transcript' and e['role'] == 'assistant' and e['delta'].strip()
                                     for e in lab.events)
                    if settled(time.monotonic(), input_end, last_output, playback_end, lab.jobs, has_answer, quiet):
                        # 위임이 있었다면 실패한 근거 전달을 성공으로 처리하지 않는다.
                        status = ('completed' if not lab.traces or all(t.get('status') == 'delivered_to_live' for t in lab.traces)
                                  else 'failed')
                        break
                    await asyncio.sleep(.1)
                else:
                    status, error = 'failed', 'ResponseTimeout'
                if input_end is not None:
                    timings['input_end_to_last_output_seconds'] = max(0, last_output-input_end)
                    timings['input_end_to_observation_end_seconds'] = time.monotonic()-input_end
                    for trace in lab.traces:
                        if 'first_audio_after_handoff_ms' in trace:
                            timings.setdefault('input_end_to_post_handoff_audio_seconds',
                                (trace['handoff_server_ms']+trace['first_audio_after_handoff_ms'])/1000
                                -(input_end-lab.created))
                await conn.session.close()
            finally:
                lab.closed = True
                for job in tuple(lab.jobs):
                    job.cancel()
                for job in (task, receiver):
                    if job is not None:
                        job.cancel()
                await asyncio.gather(*(j for j in (task, receiver, *lab.jobs) if j is not None), return_exceptions=True)
    except Exception as exc:
        status = 'failed'
        error = type(exc).__name__
    return generation_row(case, lab, status, timings, error)


async def run(args):
    from dotenv import load_dotenv
    from openai import AsyncOpenAI
    from scripts.remote_text_search import create_search

    load_dotenv(AI_DIR/'.env', override=False)
    if not os.getenv('OPENAI_API_KEY') or not os.getenv('QDRANT_API_KEY'):
        raise ValueError('API 인증 환경변수가 필요합니다.')
    cfg = load_lab_config()
    dataset_raw = args.dataset.read_bytes()
    cases = json.loads(dataset_raw)
    if args.id:
        cases = [c for c in cases if c['id'] in args.id]
        if {c['id'] for c in cases} != set(args.id):
            raise ValueError('지정한 문항이 없습니다.')
    if args.limit:
        cases = cases[:args.limit]
    contract = {'mode': 'live_rag_synthetic_audio_v1', 'model': cfg.live_model,
                'selection': {'dataset_sha256': hashlib.sha256(dataset_raw).hexdigest(), 'run_count': len(cases)},
                'ids': [c['id'] for c in cases], 'tts_model': 'gpt-4o-mini-tts', 'tts_voice': 'alloy',
                'quiet_seconds': args.quiet_seconds, 'timeout_seconds': args.timeout_seconds,
                'concurrency': args.concurrency,
                'files_sha256': {str(p.relative_to(AI_DIR)): hashlib.sha256(p.read_bytes()).hexdigest() for p in (
                    AI_DIR/'config/live-lab.toml', AI_DIR/'prompts'/cfg.voice_prompt,
                    AI_DIR/'prompts'/cfg.backend_prompt, AI_DIR/'manuals/delivery_faq.md',
                    AI_DIR/'config/rag-search-descriptions.json')}}
    report = {'contract': contract, 'records': [], 'status': 'running'}
    if args.output.exists():
        report = json.loads(args.output.read_text(encoding='utf-8'))
        if report['contract'] != contract:
            raise ValueError('기존 실행과 조건이 다릅니다. 새 저장 경로를 사용하세요.')
    done = {r['id'] for r in report['records'] if r['status'] == 'completed'}
    pending = [c for c in cases if c['id'] not in done]
    if not pending:
        print('모두 완료했습니다. 추가 API 호출 없음.')
        return
    search = await asyncio.to_thread(create_search, cfg)
    report['search'] = search.info
    report['input_audio_validation'] = 'PCM16 정렬, 1~60초, 비무음; 비정상 캐시는 보존하고 최대2회 재생성'
    cache = AI_DIR/'data/private/evaluation/audio/live_v1'
    cache.mkdir(parents=True, exist_ok=True)
    try:
        async with AsyncOpenAI(timeout=60, max_retries=1) as client:
            bridge = DirectRagBridge(client, search, cfg, (AI_DIR/'prompts'/cfg.backend_prompt).read_text(encoding='utf-8'))
            queue = asyncio.Queue()
            for case in pending:
                queue.put_nowait(case)
            stopped = asyncio.Event()
            async def worker():
                while not stopped.is_set():
                    try:
                        case = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        return
                    await execute(case)

            async def execute(case):
                key = hashlib.sha256(('gpt-4o-mini-tts/alloy/pcm/v1/'+case['question']).encode()).hexdigest()
                path = cache/(key+'.pcm')
                try:
                    if path.exists() and not valid_input_audio(path.read_bytes()):
                        invalid = path.with_name(path.stem+'.invalid-'+hashlib.sha256(path.read_bytes()).hexdigest()[:12]+'.pcm')
                        if not invalid.exists():
                            invalid.write_bytes(path.read_bytes())
                    pcm = path.read_bytes() if path.exists() else b''
                    for attempt in range(2):
                        if valid_input_audio(pcm):
                            break
                        audio = await client.audio.speech.create(model='gpt-4o-mini-tts', voice='alloy',
                                                               input=case['question'], response_format='pcm')
                        pcm = audio.content
                        if valid_input_audio(pcm):
                            path.write_bytes(pcm)
                    if not valid_input_audio(pcm):
                        raise ValueError('합성 질문 PCM이 너무 짧거나 비정상입니다.')
                    row = await one_question(client, bridge, cfg, {'id': case['id'], 'question': case['question']},
                                             path.read_bytes(), args.quiet_seconds, args.timeout_seconds)
                    row['input_audio_sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
                except Exception as exc:
                    row = {'id': case['id'], 'question': case['question'], 'status': 'failed',
                           'error_type': type(exc).__name__, 'answer': None, 'tool_calls': [], 'total_seconds': None}
                previous = next((r for r in report['records'] if r['id'] == case['id']), None)
                if previous:
                    report.setdefault('previous_attempts', []).append(previous)
                report['records'] = [r for r in report['records'] if r['id'] != case['id']]+[row]
                report['status'] = 'running' if row['status'] == 'completed' else 'blocked'
                save_report(args.output, report)
                print(f"{case['id']} | {row['status']} | {len(report['records'])}/{len(cases)}", flush=True)
                if row['status'] != 'completed':
                    stopped.set()
            await asyncio.gather(*(worker() for _ in range(args.concurrency)))
            report['status'] = ('completed' if len(report['records']) == len(cases)
                                and all(r['status'] == 'completed' for r in report['records']) else 'partial')
    finally:
        search.close()
        save_report(args.output, report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dataset', type=Path, default=AI_DIR/'evaluation/datasets/faq_v1/cases.json')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--id', action='append')
    parser.add_argument('--limit', type=int)
    parser.add_argument('--quiet-seconds', type=float, default=6)
    parser.add_argument('--timeout-seconds', type=float, default=75)
    parser.add_argument('--concurrency', type=int, default=1)
    args = parser.parse_args()
    if (not 3 <= args.quiet_seconds <= 15 or not 30 <= args.timeout_seconds <= 120
            or not 1 <= args.concurrency <= 3 or (args.limit is not None and args.limit < 1)):
        parser.error('대기 시간·문항 수 범위를 확인하세요.')
    try:
        asyncio.run(run(args))
    except Exception as exc:
        raise SystemExit(f'Live 평가 실행 실패: {type(exc).__name__}. 외부 예외 원문은 표시하지 않습니다.') from None


if __name__ == '__main__':
    main()
