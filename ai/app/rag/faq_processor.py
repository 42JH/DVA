"""영속 FAQ FIFO 소비자. 원문 조회→문서 준비→색인 성공 뒤에만 알림을 완료한다."""

import asyncio
import logging
import math
import time

from app.rag.faq_documents import prepare_faq_document_refresh
from app.rag.faq_source import prepare_faq_refresh


log = logging.getLogger(__name__)


class FaqProcessor:
    @staticmethod
    def check_bindings(events, index, cfg, rag_cfg):
        if events.path.resolve() != index.state.events.path.resolve():
            raise ValueError('FAQ 접수 큐와 색인은 같은 상태 DB를 사용해야 합니다.')
        if (index.state.collection, index.state.model, index.state.dimensions) != (cfg.collection, rag_cfg.embedding_model, rag_cfg.dimensions):
            raise ValueError('FAQ 소비자와 색인의 컬렉션/모델/차원이 다릅니다.')

    def __init__(self, events, backend, index, cfg, rag_cfg, *, clock=time.time, monotonic=time.monotonic):
        self.check_bindings(events, index, cfg, rag_cfg)
        self.events, self.backend, self.index = events, backend, index
        self.cfg, self.rag_cfg, self.clock, self.monotonic = cfg, rag_cfg, clock, monotonic
        self._operation = asyncio.Lock()
        self._wake = asyncio.Event()
        self.running = False
        self._pending_retry = None

    def wake(self):
        self._wake.set()

    async def _thread(self, function, *args, **kwargs):
        task = asyncio.create_task(asyncio.to_thread(function, *args, **kwargs))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # asyncio 취소는 이미 실행 중인 스레드를 중지하지 않는다.
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not task.cancelled():
                task.exception()  # 취소 중 생긴 스레드 예외도 회수한다.
            raise

    def _retry(self, event_id, code):
        row = self.events.get(event_id)
        if row is None:
            raise RuntimeError('처리한 FAQ 알림 기록이 없습니다.')
        if row['status'] == 'APPLIED':
            return False  # 완료 커밋 후 응답만 잃었을 수 있다.
        if row['status'] == 'RETRY':
            return True
        if code == 'INTERRUPTED':
            delay = 0.
        else:
            cap = math.ceil(math.log2(self.cfg.retry_max_sec/self.cfg.retry_base_sec))
            exponent = min(max(0, row['attempts']-1), cap)
            delay = min(self.cfg.retry_max_sec, self.cfg.retry_base_sec * 2**exponent)
        self.events.retry(event_id, error_code=code, retry_at=self.clock()+delay)
        return True

    async def _record_pending(self):
        event_id, code = self._pending_retry
        retried = await self._thread(self._retry, event_id, code)
        self._pending_retry = None
        return retried

    def _prepare(self, source):
        descriptions = self.index.descriptions_for(source.upserts)
        return prepare_faq_document_refresh(source,
            chunk_size=self.cfg.chunk_size, chunk_overlap=self.cfg.chunk_overlap,
            embedding_model=self.rag_cfg.embedding_model, dimensions=self.rag_cfg.dimensions,
            descriptions=descriptions)

    async def process_one(self):
        async with self._operation:
            if self._pending_retry is not None:
                await self._record_pending()
                return False
            event = await self._thread(self.events.claim_next, now=self.clock())
            if event is None:
                return False
            code = 'FETCH_FAILED'
            try:
                source = await prepare_faq_refresh(event, self.backend)
                code = 'PREPARE_FAILED'
                prepared = await self._thread(self._prepare, source)
                code = 'INDEX_FAILED'
                await self._thread(self.index.apply, prepared)
                code = 'ACK_FAILED'
                await self._thread(self.events.applied, event.event_id)
            except asyncio.CancelledError:
                self._pending_retry = (event.event_id, 'INTERRUPTED')
                try:
                    await self._record_pending()
                except Exception as error:
                    log.warning('FAQ 종료 상태 저장 실패: event=%s error=%s', event.event_id, type(error).__name__)
                raise
            except Exception as error:
                self._pending_retry = (event.event_id, code)
                retried = await self._record_pending()
                if retried:
                    log.warning('FAQ 알림 재시도: event=%s code=%s error=%s',
                                event.event_id, code, type(error).__name__)
                else:
                    log.info('FAQ 알림 완료 기록 확인: event=%s', event.event_id)
            return True

    async def reconcile_once(self):
        async with self._operation:
            await self._thread(self.index.reconcile_deletions)

    async def run(self, *, recover=True):
        if self.running:
            raise RuntimeError('동일 FAQ 소비자를 중복 실행할 수 없습니다.')
        self.running = True
        try:
            needs_recovery = recover
            next_reconcile = self.monotonic()+self.cfg.reconcile_sec
            while True:
                self._wake.clear()
                if needs_recovery:
                    try:
                        async with self._operation:
                            await self._thread(self.events.recover_interrupted)
                        needs_recovery = False
                    except Exception as error:
                        log.warning('FAQ 중단 작업 복구 실패: error=%s', type(error).__name__)
                        await asyncio.sleep(self.cfg.poll_sec)
                        continue
                if self.monotonic() >= next_reconcile:
                    try:
                        await self.reconcile_once()
                    except Exception as error:
                        log.warning('FAQ 삭제 재점검 실패: error=%s', type(error).__name__)
                    next_reconcile = self.monotonic()+self.cfg.reconcile_sec
                try:
                    worked = await self.process_one()
                except Exception as error:
                    # DB 자체가 잠겼거나 재시도 기록 실패해도 조용히 작업을 건너뛰지 않는다.
                    log.warning('FAQ 소비자 저장소 오류: error=%s', type(error).__name__)
                    needs_recovery = self._pending_retry is None
                    worked = False
                if not worked:
                    try:
                        # 긴 접수 폴링 간격이 삭제 재점검 시각을 밀지 않게 한다.
                        wait_sec = min(self.cfg.poll_sec, max(0., next_reconcile-self.monotonic()))
                        async with asyncio.timeout(wait_sec):
                            await self._wake.wait()
                    except TimeoutError:
                        pass
        finally:
            self.running = False
