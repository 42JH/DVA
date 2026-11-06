import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { ApiException } from '../src/common/errors/api.exception';
import { AuditService } from '../src/audit/audit.service';
import { ConfigService } from '@nestjs/config';

describe('Customer read API (e2e)', () => {
  let app: INestApplication<App>;
  const businessToken = 'business-test-only-token-'.padEnd(48, 'b');
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const auth = {
    authenticate: jest
      .fn()
      .mockRejectedValue(
        new ApiException(401, 'UNAUTHORIZED', '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.'),
      ),
    readiness: jest.fn().mockResolvedValue(undefined),
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DatabaseService)
      .useValue({ pool })
      .overrideProvider(AuthService)
      .useValue(auth)
      .overrideProvider(AuditService)
      .useValue({
        recordFailure: jest.fn().mockResolvedValue(undefined),
        flush: jest.fn().mockResolvedValue(undefined),
      })
      .compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
    app.get(ConfigService).set('AI_BUSINESS_TOKEN', businessToken);
  });
  it('preserves AI context, cookie authentication and input validation without registering a call', async () => {
    await request(app.getHttpServer())
      .post('/api/customers/context')
      .set('Authorization', 'Bearer ' + businessToken)
      .send({ phoneNumber: '01000000001' })
      .expect(({ status, body }: { status: number; body: unknown }) => {
        if (status !== 200) throw new Error(JSON.stringify(body));
      })
      .expect(200)
      .expect('Cache-Control', 'no-store')
      .expect(({ body }: { body: { data: { lookupStatus: string } } }) =>
        expect(body.data.lookupStatus).toBe('UNREGISTERED'),
      );
    for (const body of [
      { phoneNumber: 12 },
      { phoneNumber: '010 1234' },
      { phoneNumber: '01012345678', call: null },
      {
        phoneNumber: '01012345678',
        call: { providerCallId: 'x', incomingAt: 'invalid' },
      },
    ])
      await request(app.getHttpServer())
        .post('/api/customers/context')
        .set('Authorization', 'Bearer ' + businessToken)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .post('/api/customers/context')
      .set('Cookie', 'dva_session=bad')
      .send({ phoneNumber: '01012345678' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/customers/context')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'dva_session=bad')
      .send({ phoneNumber: '01012345678' })
      .expect(401);
  });

  afterAll(async () => {
    await app.close();
  });

  it('permits only consultation read events and excludes private queries from Swagger', async () => {
    const token = 'context-query-test-token-'.padEnd(48, 'c');
    app.get(ConfigService).set('CONSULTATION_AUTH_TOKEN', token);
    const event = {
      eventId: '00000000-0000-4000-8000-000000000021',
      source: 'consultation',
      eventType: 'CallCustomerRequested',
      payload: { phoneNumber: '0' },
    };
    for (const authorization of ['', 'Bearer wrong', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN])
      await request(app.getHttpServer())
        .post('/internal/caller-context')
        .set('Authorization', authorization)
        .send(event)
        .expect(403);
    await request(app.getHttpServer())
      .post('/internal/caller-context')
      .set('Authorization', 'Bearer ' + token)
      .send(event)
      .expect(200)
      .expect({ eventId: event.eventId, status: 'processed', payload: { customerSeq: null } });
    await request(app.getHttpServer())
      .post('/internal/caller-context')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...event, source: 'operations' })
      .expect(422);
    await request(app.getHttpServer())
      .post('/internal/caller-context')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...event, payload: { phoneNumber: '0', sql: 'SELECT secret' } })
      .expect(422);
    await request(app.getHttpServer())
      .get('/customer/docs-json')
      .expect(({ body }: { body: { paths: Record<string, unknown> } }) =>
        expect(body.paths['/internal/caller-context']).toBeUndefined(),
      );
  });

  it('preserves health and Swagger under the original service prefix', async () => {
    await request(app.getHttpServer()).get('/customer/health').expect(200).expect({ status: 'ok' });
    await request(app.getHttpServer()).get('/customer/health/ready').expect(200);
    await request(app.getHttpServer())
      .get('/customer/docs')
      .expect(200)
      .expect(/swagger-ui/);
    await request(app.getHttpServer())
      .get('/customer/docs/swagger-ui-init.js')
      .expect(200)
      .expect(/DVA Customer API/);
  });
  it('documents exactly the implemented methods and keeps internal paths private', async () => {
    await request(app.getHttpServer())
      .get('/customer/docs-json')
      .expect(200)
      .expect(({ body }: { body: { paths: Record<string, Record<string, unknown>> } }) => {
        const paths = body.paths;
        for (const [path, methods] of Object.entries({
          '/api/customers': ['get', 'post'],
          '/api/customers/context': ['post'],
          '/api/customers/{id}': ['get', 'patch'],
          '/api/customers/{id}/pins': ['get', 'post'],
          '/api/pins/{id}': ['patch'],
          '/api/companies': ['get', 'post'],
          '/api/companies/search': ['get'],
          '/api/companies/members/search': ['get'],
          '/api/companies/{id}': ['get', 'patch', 'delete'],
          '/api/companies/{id}/members': ['get', 'post'],
          '/api/companies/{id}/departments': ['get', 'post'],
          '/api/members/{id}': ['patch', 'delete'],
          '/api/departments/{id}': ['patch', 'delete'],
        })) {
          expect(Object.keys(paths[path]).sort()).toEqual(methods.sort());
        }
        expect(paths['/api/companies/{id}/billing']).toBeUndefined();
        expect(paths['/internal/audit/flush']).toBeUndefined();
        expect(paths['/internal/call-scope']).toBeUndefined();
      });
  });
  it('authenticates internal audit barriers independently of administrator cookies', async () => {
    await request(app.getHttpServer()).post('/internal/audit/flush').send({}).expect(403);
    await request(app.getHttpServer())
      .post('/internal/audit/flush')
      .set('Cookie', 'dva_session=' + 'a'.repeat(64))
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/internal/audit/flush')
      .set('Authorization', 'Bearer ' + 'local-test-only-token-'.padEnd(40, 'a'))
      .send({})
      .expect(400);
  });
  it('authenticates scoped execution separately and rejects forged command or caller fields', async () => {
    const token = 'pin-scope-test-token-'.padEnd(48, 'c');
    app.get(ConfigService).set('CONSULTATION_AUTH_TOKEN', token);
    for (const authorization of ['', 'Bearer wrong', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN])
      await request(app.getHttpServer())
        .post('/internal/call-scope')
        .set('Authorization', authorization)
        .send({})
        .expect(403);
    const event = {
      eventId: '00000000-0000-4000-8000-000000000022',
      source: 'consultation',
      eventType: 'CallScopedCustomerRequested',
      payload: {
        command: {
          operation: 'CustomerUpdated',
          id: 1,
          callSessionSeq: 1,
          input: { address: null },
          requestId: '00000000-0000-4000-8000-000000000023',
        },
        caller: { phone: null, customerSeq: null, endedAt: 'invalid' },
      },
    };
    for (const invalid of [
      event,
      { ...event, source: 'customer' },
      { ...event, payload: { ...event.payload, actorId: 1 } },
    ])
      await request(app.getHttpServer())
        .post('/internal/call-scope')
        .set('Authorization', 'Bearer ' + token)
        .send(invalid)
        .expect(422);
  });
  it('requires current sessions for administrator reads and preserves error envelopes', async () => {
    await request(app.getHttpServer())
      .get('/api/customers')
      .expect(401)
      .expect(({ body }: { body: { error: { code: string }; meta: { requestId: string } } }) => {
        expect(body.error.code).toBe('UNAUTHORIZED');
        expect(body.meta.requestId).toEqual(expect.any(String));
      });
    await request(app.getHttpServer())
      .post('/api/customers')
      .set('Authorization', 'Bearer ' + businessToken)
      .send({})
      .expect(400);
  });
  it('requires the AI business token independently of internal tokens and stale cookies', async () => {
    for (const authorization of ['', 'Bearer wrong', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN])
      await request(app.getHttpServer())
        .post('/api/customers/context')
        .set('Authorization', authorization)
        .send({ phoneNumber: '01000000001' })
        .expect(401);
    await request(app.getHttpServer()).get('/api/companies/search?q=test').expect(401);
    pool.query.mockResolvedValueOnce({ rows: [{ __total_count: '0', __page_ordinal: null }] });
    await request(app.getHttpServer())
      .get('/api/companies/search?q=test')
      .set('Cookie', 'dva_session=stale')
      .set('Authorization', 'Bearer ' + businessToken)
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/companies/members/search?q=test')
      .set('Authorization', 'Bearer ' + businessToken)
      .expect(401);
    app.get(ConfigService).set('AI_BUSINESS_TOKEN', '');
    await request(app.getHttpServer())
      .post('/api/customers/context')
      .set('Authorization', 'Bearer ' + businessToken)
      .send({ phoneNumber: '01000000001' })
      .expect(503);
    app.get(ConfigService).set('AI_BUSINESS_TOKEN', businessToken);
  });
  it('fails readiness on DB or authentication dependency failure while keeping liveness', async () => {
    pool.query.mockRejectedValueOnce(new Error('unavailable'));
    await request(app.getHttpServer()).get('/customer/health/ready').expect(503);
    auth.readiness.mockRejectedValueOnce(new Error('unavailable'));
    await request(app.getHttpServer()).get('/customer/health/ready').expect(503);
    await request(app.getHttpServer()).get('/customer/health').expect(200);
    await request(app.getHttpServer()).get('/customer/health/ready').expect(200);
  });
});
