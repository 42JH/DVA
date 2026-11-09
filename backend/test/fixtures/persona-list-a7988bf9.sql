-- a7988bf9: original persona list SQL for result equivalence.
WITH matching AS NOT MATERIALIZED (SELECT p.ai_persona_seq AS "aiPersonaSeq", p.code, row_to_json(latest) AS "latestVersion",
       row_to_json(latest) AS "headVersion",
       row_to_json(active) AS "activeVersion",row_to_json(pending) AS "pendingVersion",
       row_to_json(draft) AS draft,active."aiPersonaVersionSeq" AS "activeVersionSeq",
       pending."aiPersonaVersionSeq" AS "pendingVersionSeq"
       FROM ai_personas p JOIN LATERAL (SELECT v.ai_persona_version_seq AS "aiPersonaVersionSeq",
 v.ai_persona_seq AS "aiPersonaSeq", identity.code, v.version, v.name, v.prompt_text AS "promptText",
 v.voice_id AS "voiceId", v.speaking_rate::float8 AS "speakingRate", v.turn_wait_level AS "turnWaitLevel",
 v.status, v.created_by_admin_user_seq AS "createdByAdminUserSeq", v.created_at AS "createdAt",
 v.application_id AS "applicationId", v.requested_by_admin_user_seq AS "requestedByAdminUserSeq",
 v.requested_at AS "requestedAt", v.applied_at AS "appliedAt", v.last_notified_at AS "lastNotifiedAt",
 v.apply_error_code AS "applyErrorCode"
 FROM ai_persona_versions v JOIN ai_personas identity USING(ai_persona_seq)
        WHERE v.ai_persona_seq=p.ai_persona_seq ORDER BY v.version DESC LIMIT 1) latest ON true
       LEFT JOIN LATERAL (SELECT v.ai_persona_version_seq AS "aiPersonaVersionSeq",
 v.ai_persona_seq AS "aiPersonaSeq", identity.code, v.version, v.name, v.prompt_text AS "promptText",
 v.voice_id AS "voiceId", v.speaking_rate::float8 AS "speakingRate", v.turn_wait_level AS "turnWaitLevel",
 v.status, v.created_by_admin_user_seq AS "createdByAdminUserSeq", v.created_at AS "createdAt",
 v.application_id AS "applicationId", v.requested_by_admin_user_seq AS "requestedByAdminUserSeq",
 v.requested_at AS "requestedAt", v.applied_at AS "appliedAt", v.last_notified_at AS "lastNotifiedAt",
 v.apply_error_code AS "applyErrorCode"
 FROM ai_persona_versions v JOIN ai_personas identity USING(ai_persona_seq)
        WHERE v.ai_persona_seq=p.ai_persona_seq AND v.status='ACTIVE') active ON true
       LEFT JOIN LATERAL (SELECT v.ai_persona_version_seq AS "aiPersonaVersionSeq",
 v.ai_persona_seq AS "aiPersonaSeq", identity.code, v.version, v.name, v.prompt_text AS "promptText",
 v.voice_id AS "voiceId", v.speaking_rate::float8 AS "speakingRate", v.turn_wait_level AS "turnWaitLevel",
 v.status, v.created_by_admin_user_seq AS "createdByAdminUserSeq", v.created_at AS "createdAt",
 v.application_id AS "applicationId", v.requested_by_admin_user_seq AS "requestedByAdminUserSeq",
 v.requested_at AS "requestedAt", v.applied_at AS "appliedAt", v.last_notified_at AS "lastNotifiedAt",
 v.apply_error_code AS "applyErrorCode"
 FROM ai_persona_versions v JOIN ai_personas identity USING(ai_persona_seq)
        WHERE v.ai_persona_seq=p.ai_persona_seq AND v.status='PENDING') pending ON true
       LEFT JOIN LATERAL (SELECT ai_persona_seq AS "aiPersonaSeq",draft_revision AS "draftRevision",
 base_version AS "baseVersion",name,prompt_text AS "promptText",voice_id AS "voiceId",
 speaking_rate::float8 AS "speakingRate",turn_wait_level AS "turnWaitLevel",
 updated_by_admin_user_seq AS "updatedByAdminUserSeq",created_at AS "createdAt",updated_at AS "updatedAt"
 FROM ai_persona_drafts WHERE ai_persona_seq=p.ai_persona_seq) draft ON true
       WHERE ($1::int IS NULL OR p.ai_persona_seq=$1)),
     page AS (
       SELECT matching.*,row_number() OVER (ORDER BY "aiPersonaSeq" DESC) AS __page_ordinal
       FROM matching ORDER BY "aiPersonaSeq" DESC LIMIT $2 OFFSET $3
     )
     SELECT page.*,totals.__total_count FROM (SELECT count(*) AS __total_count FROM matching) totals
     LEFT JOIN page ON true ORDER BY page.__page_ordinal
