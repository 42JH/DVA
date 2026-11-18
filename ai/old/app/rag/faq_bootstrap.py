"""전체 목록에서 번호만 영속 큐에 접수한다. 실제 원문은 소비자가 다시 조회한다."""

from uuid import NAMESPACE_URL, uuid5

from app.rag.faq_events import FaqChange


def initial_event(entries):
    ids = [entry.faq_id for entry in entries]
    if not ids:
        return None
    identity = 'dpostcall:faq-bootstrap:v1:' + ','.join(map(str, sorted(ids)))
    return FaqChange.model_validate({'eventId':str(uuid5(NAMESPACE_URL, identity)),
                                    'operation':'INSERT', 'faqEntrySeqs':ids})
