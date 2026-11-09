-- a7988bf9 GET /api/calls: original SQL for result equivalence.
WITH matching AS NOT MATERIALIZED (SELECT c.call_session_seq AS "callSessionSeq",c.provider_call_id AS "providerCallId",
 CASE WHEN a.call_session_seq IS NOT NULL THEN 'COMPLETED'
  WHEN c.analysis_failed_at IS NOT NULL THEN 'FAILED' ELSE 'PENDING' END AS "analysisStatus",
 (SELECT min(r.created_at) FROM recordings r WHERE r.call_session_seq=c.call_session_seq) AS "recordedAt",
 c.caller_phone_number AS "callerPhoneNumber",c.order_seq AS "orderSeq",o.status AS "orderStatus",o.total_amount AS "orderTotalAmount",
 COALESCE(c.started_at,a.ai_started_at,c.incoming_at) AS "startedAt",COALESCE(c.ended_at,a.ai_ended_at) AS "endedAt",
 customer.customer_seq AS "customerSeq",customer.name AS "customerName",company.name AS "organizationName",
 a.ai_persona_version_seq AS "aiPersonaVersionSeq",v.name AS "personaName",v.version AS "personaVersion",
 a.ai_started_at AS "aiStartedAt",a.ai_ended_at AS "aiEndedAt",a.repeat_question_count AS "repeatQuestionCount",
 a.has_complaint AS "hasComplaint",a.complaints,a.analysed_at AS "analysedAt",
 a.is_new_customer AS "isNewCustomer",a.registered_parcel_count AS "registeredParcelCount",
 a.faq_answer_count AS "faqAnswerCount",a.order_lookup_count AS "orderLookupCount",
 a.cancelled_parcel_count AS "cancelledParcelCount",a.has_handoff_request AS "hasHandoffRequest",
 a.has_callback_request AS "hasCallbackRequest"
 FROM call_sessions c LEFT JOIN orders o ON o.order_seq=c.order_seq AND o.deleted_at IS NULL
 LEFT JOIN customers customer ON customer.customer_seq=COALESCE(o.customer_seq,c.customer_seq) AND customer.deleted_at IS NULL
 LEFT JOIN memberships membership ON membership.customer_seq=customer.customer_seq AND membership.deleted_at IS NULL
 LEFT JOIN organizations company ON company.organization_seq=membership.organization_seq AND company.deleted_at IS NULL
 LEFT JOIN call_analyses a ON a.call_session_seq=c.call_session_seq
 LEFT JOIN ai_persona_versions v ON v.ai_persona_version_seq=a.ai_persona_version_seq WHERE c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years') AND COALESCE(c.started_at,a.ai_started_at,c.incoming_at) >= $1 AND COALESCE(c.started_at,a.ai_started_at,c.incoming_at) < $2),
     page AS (
       SELECT matching.*,row_number() OVER (ORDER BY "startedAt" DESC NULLS LAST,"callSessionSeq" DESC) AS __page_ordinal
       FROM matching ORDER BY "startedAt" DESC NULLS LAST,"callSessionSeq" DESC LIMIT $3 OFFSET $4
     )
     SELECT page.*,totals.__total_count FROM (SELECT count(*) AS __total_count FROM matching) totals
     LEFT JOIN page ON true ORDER BY page.__page_ordinal
