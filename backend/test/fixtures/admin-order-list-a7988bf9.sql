-- a7988bf9 GET /api/admin/orders: original SQL for result equivalence.
WITH matching AS NOT MATERIALIZED (SELECT o.order_seq AS "orderSeq",o.status,o.created_at AS "createdAt",o.pickup_requested_at AS "pickupRequestedAt",
       customer.customer_seq AS "customerSeq",company.name AS "organizationName",
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'orderParcelSeq',p.order_parcel_seq,'status',p.status,
         'origin',jsonb_build_object('name',p.origin_name,'phoneNumber',p.origin_phone_number,'roadAddress',p.origin_road_address,'jibunAddress',p.origin_jibun_address,'detailAddress',p.origin_detail_address),
         'destination',jsonb_build_object('name',p.destination_name,'phoneNumber',p.destination_phone_number,'roadAddress',p.destination_road_address,'jibunAddress',p.destination_jibun_address,'detailAddress',p.destination_detail_address),
         'documentCount',p.document_count,'smallBoxCount',p.small_box_count,'mediumBoxCount',p.medium_box_count,'bigBoxCount',p.big_box_count,'otherItemDescription',p.other_item_description)
         ORDER BY p.parcel_position,p.order_parcel_seq) FROM order_parcels p WHERE p.order_seq=o.order_seq),'[]'::jsonb) AS parcels
       FROM orders o
       LEFT JOIN customers customer ON customer.customer_seq=o.customer_seq AND customer.deleted_at IS NULL
       LEFT JOIN memberships membership ON membership.customer_seq=customer.customer_seq AND membership.deleted_at IS NULL
       LEFT JOIN organizations company ON company.organization_seq=membership.organization_seq AND company.deleted_at IS NULL
       WHERE o.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM order_parcel_drafts d WHERE d.legacy_order_seq=o.order_seq) AND COALESCE(o.closed_at,o.created_at)>transaction_timestamp()-interval '5 years'
        AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM order_parcels p WHERE p.order_seq=o.order_seq AND (
         EXISTS(SELECT 1 FROM unnest(ARRAY[p.origin_name,p.origin_phone_number,p.origin_road_address,p.origin_jibun_address,p.origin_detail_address,
           p.destination_name,p.destination_phone_number,p.destination_road_address,p.destination_jibun_address,p.destination_detail_address]) AS v(value)
           WHERE strpos(lower(normalize(v.value,NFC)),lower($1))>0)
         OR ($5::text IS NOT NULL AND (strpos(p.origin_phone_number,$5)>0 OR strpos(p.destination_phone_number,$5)>0)))))
        AND ($2::timestamptz IS NULL OR o.created_at >= $2)
        AND ($3::timestamptz IS NULL OR o.created_at < $3)
        AND ($4::text IS NULL OR o.status=$4 OR ($4='PAID' AND o.status IN ('SUBMITTING','ACCEPTED'))
          OR ($4='SUBMISSION_FAILED' AND o.status='SUBMITTING_FAILED'))
         AND ($6::int IS NULL OR company.organization_seq=$6)),
     page AS (
       SELECT matching.*,row_number() OVER (ORDER BY "createdAt" DESC,"orderSeq" DESC) AS __page_ordinal
       FROM matching ORDER BY "createdAt" DESC,"orderSeq" DESC LIMIT $7 OFFSET $8
     )
     SELECT page.*,totals.__total_count FROM (SELECT count(*) AS __total_count FROM matching) totals
     LEFT JOIN page ON true ORDER BY page.__page_ordinal
