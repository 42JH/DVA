import { Injectable } from '@nestjs/common';
import { DashboardPersonaClient } from './dashboard-persona.client';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import {
  DROPOFF_STAGES,
  LATENCY_PROCESS_TYPES,
} from '../call-insights/call-dashboard-metrics.types';
import { DashboardCustomerType } from './dto/dashboard-query.dto';
import {
  ComplaintCallsDto,
  DASHBOARD_COMPLAINT_TYPES,
  RegistrationTimeDto,
  ResponseWaitDto,
  StageDropoffsDto,
} from './dto/dashboard-response.dto';

const FROM_CALLS =
  'FROM call_sessions c LEFT JOIN call_analyses a USING(call_session_seq)';
const CALL_DURATION_MS =
  '(extract(epoch FROM (COALESCE(c.ended_at,a.ai_ended_at)-COALESCE(c.started_at,a.ai_started_at)))*1000)';
const CALL_FILTER = `WHERE c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>transaction_timestamp()-interval '5 years')
 AND COALESCE(c.ended_at,a.ai_ended_at) IS NOT NULL
 AND ($1::text='ALL' OR ($1='NEW' AND a.is_new_customer IS TRUE) OR ($1='EXISTING' AND a.is_new_customer IS FALSE))`;

@Injectable()
export class DashboardRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly personas: DashboardPersonaClient,
  ) {}

  private async read<T>(
    sql: string,
    values: unknown[],
    client?: PoolClient,
  ): Promise<T> {
    return (
      await (client ?? this.database.pool).query<{ data: T }>(sql, values)
    ).rows[0].data;
  }

  stageDropoffs(
    customerType: DashboardCustomerType,
    client?: PoolClient,
  ): Promise<StageDropoffsDto> {
    return this.read(
      this.stageDropoffsSql(),
      [customerType, DROPOFF_STAGES.filter((stage) => stage !== 'NONE')],
      client,
    );
  }

  private stageDropoffsSql(shared = false): string {
    return `WITH calls AS (
      ${shared ? 'SELECT is_new_customer,dropoff_stage FROM dashboard_calls' : `SELECT a.is_new_customer,m.dropoff_stage ${FROM_CALLS} LEFT JOIN call_dashboard_metrics m USING(call_session_seq) ${CALL_FILTER}`}
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(dropoff_stage) AS assessed,count(*) FILTER(WHERE dropoff_stage<>'NONE') AS dropped FROM calls
     ), stages AS (SELECT dropoff_stage,count(*) AS n FROM calls WHERE dropoff_stage<>'NONE' GROUP BY dropoff_stage)
     SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'assessedCallCount',s.assessed,'unassessedCallCount',s.total-s.assessed,'dropoffCallCount',s.dropped,
      'dropoffRatePercent',s.dropped*100.0/NULLIF(s.assessed,0),'stages',(
       SELECT jsonb_agg(jsonb_build_object('stage',code,'callCount',COALESCE(n,0),
        'dropoffRatePercent',COALESCE(n,0)*100.0/NULLIF(s.assessed,0)) ORDER BY position)
       FROM unnest($2::text[]) WITH ORDINALITY AS keys(code,position) LEFT JOIN stages ON stages.dropoff_stage=code)) AS data
     FROM summary s`;
  }

  async registrationTime(
    customerType: DashboardCustomerType,
    client?: PoolClient,
  ): Promise<RegistrationTimeDto> {
    return this.read(
      this.registrationTimeSql(),
      [customerType, JSON.stringify(await this.personas.read())],
      client,
    );
  }

  private registrationTimeSql(shared = false): string {
    return `WITH persona_references AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(ai_persona_seq integer,ai_persona_version_seq integer,name text,version integer,status text,previous_active_version_seq integer)), calls AS (
      ${shared ? 'SELECT is_new_customer,ai_persona_version_seq,registered_parcel_count,duration_ms FROM dashboard_calls' : `SELECT a.is_new_customer,a.ai_persona_version_seq,a.registered_parcel_count,${CALL_DURATION_MS} AS duration_ms ${FROM_CALLS} ${CALL_FILTER}`}
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(*) FILTER(WHERE registered_parcel_count>0) AS registrations,
       count(*) FILTER(WHERE registered_parcel_count IS NULL) AS unmeasured,
       COALESCE(sum(registered_parcel_count) FILTER(WHERE registered_parcel_count>0),0) AS parcels,
       COALESCE(sum(duration_ms) FILTER(WHERE registered_parcel_count>0),0) AS duration FROM calls
     ), stats AS (
      SELECT ai_persona_version_seq,count(*) AS registrations,sum(registered_parcel_count) AS parcels,sum(duration_ms) AS duration
      FROM calls WHERE registered_parcel_count>0 GROUP BY ai_persona_version_seq
     ), live AS (SELECT ai_persona_version_seq,previous_active_version_seq FROM persona_references WHERE status='ACTIVE'),
     selected AS (
      SELECT 'CURRENT' AS role,ai_persona_version_seq AS id FROM live
      UNION ALL SELECT 'PREVIOUS',previous_active_version_seq FROM live WHERE previous_active_version_seq IS NOT NULL
     ), comparison AS (
      SELECT selected.role,stats.duration/NULLIF(stats.parcels,0)/1000 AS average,
       jsonb_build_object('aiPersonaVersionSeq',v.ai_persona_version_seq,'aiPersonaSeq',v.ai_persona_seq,'name',v.name,'version',v.version,
        'registrationCallCount',COALESCE(stats.registrations,0),'registeredParcelCount',COALESCE(stats.parcels,0),
        'totalCallDurationMs',COALESCE(stats.duration,0),'averageSecondsPerParcel',stats.duration/NULLIF(stats.parcels,0)/1000) AS data
      FROM selected JOIN persona_references v ON v.ai_persona_version_seq=selected.id
      LEFT JOIN stats ON stats.ai_persona_version_seq=v.ai_persona_version_seq
     ) SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'registrationCallCount',s.registrations,'unmeasuredCallCount',s.unmeasured,'registeredParcelCount',s.parcels,
      'totalCallDurationMs',s.duration,'averageSecondsPerParcel',s.duration/NULLIF(s.parcels,0)/1000,
      'comparison',jsonb_build_object('current',(SELECT data FROM comparison WHERE role='CURRENT'),
       'previous',(SELECT data FROM comparison WHERE role='PREVIOUS'),
       'previousMinusCurrentSeconds',(SELECT average FROM comparison WHERE role='PREVIOUS')-(SELECT average FROM comparison WHERE role='CURRENT'))) AS data
     FROM summary s`;
  }

  complaintCalls(
    customerType: DashboardCustomerType,
    client?: PoolClient,
  ): Promise<ComplaintCallsDto> {
    return this.read(
      this.complaintCallsSql(),
      [customerType, [...DASHBOARD_COMPLAINT_TYPES]],
      client,
    );
  }

  private complaintCallsSql(shared = false): string {
    const types = shared ? '$3' : '$2';
    return `WITH calls AS (
      ${shared ? 'SELECT call_session_seq,is_new_customer,has_complaint,complaints FROM dashboard_calls' : `SELECT c.call_session_seq,a.is_new_customer,a.has_complaint,a.complaints ${FROM_CALLS} ${CALL_FILTER}`}
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(has_complaint) AS assessed,count(*) FILTER(WHERE has_complaint IS TRUE) AS complained FROM calls
     ), call_types AS (
      SELECT DISTINCT c.call_session_seq,item->>'type' AS type
      FROM calls c CROSS JOIN LATERAL jsonb_array_elements(c.complaints) item WHERE c.has_complaint IS TRUE
     ), types AS (SELECT type,count(*) AS n FROM call_types WHERE type=ANY(${types}::text[]) GROUP BY type),
     type_total AS (SELECT COALESCE(sum(n),0) AS n FROM types)
     SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'assessedCallCount',s.assessed,'unassessedCallCount',s.total-s.assessed,'complaintCallCount',s.complained,
      'complaintRatePercent',s.complained*100.0/NULLIF(s.assessed,0),'typeTotalCount',t.n,
      'legacyTypeCallCount',(SELECT count(DISTINCT call_session_seq) FROM call_types WHERE type IS NULL OR NOT(type=ANY(${types}::text[]))),
      'types',(SELECT jsonb_agg(jsonb_build_object('type',code,'callCount',COALESCE(types.n,0),
       'sharePercent',COALESCE(types.n,0)*100.0/NULLIF(t.n,0)) ORDER BY position)
       FROM unnest(${types}::text[]) WITH ORDINALITY AS keys(code,position) LEFT JOIN types ON types.type=code)) AS data
     FROM summary s CROSS JOIN type_total t`;
  }

  responseWait(
    customerType: DashboardCustomerType,
    client?: PoolClient,
  ): Promise<ResponseWaitDto> {
    return this.read(
      this.responseWaitSql(),
      [customerType, [...LATENCY_PROCESS_TYPES]],
      client,
    );
  }

  private responseWaitSql(shared = false): string {
    const types = shared ? '$4' : '$2';
    return `WITH calls AS (
      ${shared ? 'SELECT is_new_customer,duration_ms,total_wait_ms,latency_stats,response_wait_received_at FROM dashboard_calls' : `SELECT a.is_new_customer,${CALL_DURATION_MS} AS duration_ms,m.total_wait_ms,m.latency_stats,m.response_wait_received_at ${FROM_CALLS} LEFT JOIN call_dashboard_metrics m USING(call_session_seq) ${CALL_FILTER}`}
     ), measured AS (
      SELECT * FROM calls WHERE response_wait_received_at IS NOT NULL AND total_wait_ms<=duration_ms
     ), summary AS (
      SELECT count(*) AS total,count(*) FILTER(WHERE is_new_customer IS NULL) AS unknown_customer,
       count(*) FILTER(WHERE response_wait_received_at IS NULL) AS unmeasured,
       count(*) FILTER(WHERE response_wait_received_at IS NOT NULL AND total_wait_ms>duration_ms) AS invalid FROM calls
     ), totals AS (
      SELECT count(*) AS measured,COALESCE(sum(total_wait_ms),0) AS wait,COALESCE(sum(duration_ms),0) AS duration FROM measured
     ), processes AS (
      SELECT item->>'processType' AS type,sum((item->>'measurementCount')::bigint) AS samples,
       sum((item->>'totalLatencyMs')::numeric) AS latency FROM measured CROSS JOIN LATERAL jsonb_array_elements(latency_stats) item
      GROUP BY item->>'processType'
     ) SELECT jsonb_build_object('customerType',$1::text,'endedCallCount',s.total,'unclassifiedCustomerCallCount',s.unknown_customer,
      'measuredCallCount',t.measured,'unmeasuredCallCount',s.unmeasured,'invalidWaitCallCount',s.invalid,
      'totalWaitMs',t.wait,'totalCallDurationMs',t.duration,'waitRatePercent',t.wait*100.0/NULLIF(t.duration,0),
      'processes',(SELECT jsonb_agg(jsonb_build_object('processType',code,'measurementCount',COALESCE(p.samples,0),
       'totalLatencyMs',COALESCE(p.latency,0),'averageLatencyMs',p.latency/NULLIF(p.samples,0)) ORDER BY position)
       FROM unnest(${types}::text[]) WITH ORDINALITY AS keys(code,position) LEFT JOIN processes p ON p.type=code)) AS data
     FROM summary s CROSS JOIN totals t`;
  }
}
