import { CallComplaintDto } from '../src/call-insights/dto/create-call-analysis.dto';
import { createValidationPipe } from '../src/common/http/validation.pipe';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
import { AuditService } from '../src/audit/audit.service';
import { CustomerContextClient } from '../src/customers/customer-context.client';
import { ApiException } from '../src/common/errors/api.exception';

describe('Consultation PBX and active calls (e2e)', () => {
  let app: INestApplication<App>;
  const pool = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const auth = {
    authenticate: jest
      .fn()
      .mockRejectedValue(
        new ApiException(
          401,
          'UNAUTHORIZED',
          '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.',
        ),
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
        flush: jest.fn().mockResolvedValue(undefined),
        recordFailure: jest.fn().mockResolvedValue(undefined),
      })
      .overrideProvider(CustomerContextClient)
      .useValue({
        callCustomer: jest.fn().mockResolvedValue(null),
      })
      .compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('preserves health and Swagger under the original service prefix', async () => {
    await request(app.getHttpServer())
      .get('/consultation/health')
      .expect(200)
      .expect({ status: 'ok' });
    await request(app.getHttpServer())
      .get('/consultation/health/ready')
      .expect(200);
    await request(app.getHttpServer())
      .get('/consultation/docs')
      .expect(200)
      .expect(/swagger-ui/);
    await request(app.getHttpServer())
      .get('/consultation/docs/swagger-ui-init.js')
      .expect(200)
      .expect(/DVA Consultation API/);
  });
  it('publishes only the implemented calls and canonical PBX contract', async () => {
    const validation = createValidationPipe();
    const complaint = {
      type: 'DISSATISFACTION_EXPRESSION',
      evidenceText: '좀 불편하네요',
      offsetSeconds: 0,
      utteranceOrders: [1],
    };
    for (const fields of [
      {},
      { target: null, level: null },
      { target: 'ai_service', level: 'mild' },
      { target: 'price_policy', level: 'explicit' },
      { target: 'delivery_other', level: 'mild' },
    ]) {
      const input = { ...complaint, ...fields };
      await expect(
        validation.transform(input, {
          type: 'body',
          metatype: CallComplaintDto,
        }),
      ).resolves.toMatchObject(input);
    }
    for (const fields of [
      { target: 'external' },
      { level: 'severe' },
      { target: 1 },
      { level: 1 },
    ])
      await expect(
        validation.transform(
          { ...complaint, ...fields },
          { type: 'body', metatype: CallComplaintDto },
        ),
      ).rejects.toMatchObject({ status: 400 });
    await request(app.getHttpServer())
      .get('/consultation/docs-json')
      .expect(200)
      .expect(({ body }: { body: { paths: Record<string, unknown> } }) => {
        expect(Object.keys(body.paths).sort()).toEqual([
          '/api/ai/calls/{id}/analysis',
          '/api/ai/calls/{id}/analysis/failure',
          '/api/ai/calls/{id}/events',
          '/api/ai/calls/{id}/response-wait-metrics',
          '/api/ai/calls/{id}/stage-metrics',
          '/api/ai/unanswered-questions',
          '/api/calls',
          '/api/calls/active-count',
          '/api/calls/active-count/stream',
          '/api/calls/{id}',
          '/api/calls/{id}/actions',
          '/api/calls/{id}/order-intake',
          '/api/calls/{id}/processing-results',
          '/api/calls/{id}/transcript',
          '/api/dashboard/complaint-calls',
          '/api/dashboard/registration-time',
          '/api/dashboard/response-wait',
          '/api/dashboard/stage-dropoffs',
          '/api/unanswered-questions',
          '/api/unanswered-questions/{id}',
          '/api/unanswered-questions/{id}/faqs',
          '/consultation/health',
          '/consultation/health/ready',
          '/webhooks/pbx/call-ended',
        ]);
        expect(body.paths['/api/calls/{id}']).toHaveProperty('get');
        expect(body.paths['/api/calls/{id}']).toHaveProperty('delete');
      });
    await request(app.getHttpServer()).get('/api/calls').expect(401);
    await request(app.getHttpServer())
      .delete('/api/calls/1')
      .set('Origin', 'http://localhost:5173')
      .expect(401);
  });
  it('requires allowed Origin on content deletion before authenticating the session', async () => {
    const previous = auth.authenticate.mock.calls.length;
    for (const path of ['/api/calls/1', '/api/unanswered-questions/1']) {
      await request(app.getHttpServer()).delete(path).expect(403);
      await request(app.getHttpServer())
        .delete(path)
        .set('Origin', 'https://evil.invalid')
        .expect(403);
    }
    expect(auth.authenticate.mock.calls.length).toBe(previous);
    for (const path of ['/api/calls/1', '/api/unanswered-questions/1'])
      await request(app.getHttpServer())
        .delete(path)
        .set('Origin', 'http://localhost:5173')
        .expect(401);
  });
  it('requires administrator sessions for both active count routes', async () => {
    for (const path of [
      '/api/calls/active-count',
      '/api/calls/active-count/stream',
    ])
      await request(app.getHttpServer())
        .get(path)
        .expect(401)
        .expect('Cache-Control', 'no-store');
  });
  it('rejects unauthenticated or forged scoped commands before using a call connection', async () => {
    const previous = pool.query.mock.calls.length;
    for (const authorization of [
      '',
      'Bearer wrong',
      'Bearer ' + process.env.CONSULTATION_AUTH_TOKEN,
    ])
      await request(app.getHttpServer())
        .post('/internal/call-scope')
        .set('Authorization', authorization)
        .send({})
        .expect(403);
    await request(app.getHttpServer())
      .post('/internal/call-scope')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .send({})
      .expect(422);
    expect(pool.query.mock.calls.length).toBe(previous);
  });
  it('preserves dedicated PBX authentication on direct and public proxy paths', async () => {
    const previous = pool.query.mock.calls.length;
    for (const path of [
      '/webhooks/pbx/call-ended',
      '/api/webhooks/pbx/call-ended',
    ]) {
      const response = await request(app.getHttpServer())
        .post(path)
        .send({})
        .expect(401);
      expect(response.body).toHaveProperty('statusCode', 401);
      expect(response.body).not.toHaveProperty('meta');
    }
    expect(pool.query.mock.calls.length).toBe(previous);
  });
  it('keeps process health alive when database readiness fails', async () => {
    pool.query.mockRejectedValueOnce(new Error('unavailable'));
    await request(app.getHttpServer())
      .get('/consultation/health/ready')
      .expect(503);
    await request(app.getHttpServer()).get('/consultation/health').expect(200);
  });
  it('authenticates order deletion checks, validates fixed fields and exposes no public operation', async () => {
    const token = app.get(ConfigService).get<string>('CUSTOMER_AUTH_TOKEN')!;
    const body = {
      eventId: '00000000-0000-4000-8000-000000000001',
      source: 'order',
      eventType: 'OrderDeletionCheckRequested',
      payload: { orderSeq: 17 },
    };
    await request(app.getHttpServer())
      .post('/internal/order-deletion-check')
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post('/internal/order-deletion-check')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...body, payload: { orderSeq: '17' } })
      .expect(422);
    pool.query.mockResolvedValueOnce({ rows: [{ blocked: true }] });
    await request(app.getHttpServer())
      .post('/internal/order-deletion-check')
      .set('Authorization', 'Bearer ' + token)
      .send(body)
      .expect(200)
      .expect({
        eventId: body.eventId,
        status: 'processed',
        payload: { blocked: true },
      });
    const response = await request(app.getHttpServer())
      .get('/consultation/docs-json')
      .expect(200);
    expect(
      Object.keys(
        (response.body as { paths: Record<string, unknown> }).paths,
      ).some((path) => path.includes('order-deletion-check')),
    ).toBe(false);
  });

  it('authenticates FAQ source queries on the private path and rejects invalid envelopes', async () => {
    const token = 'faq-source-query-token-'.padEnd(48, 's');
    app.get(ConfigService).set('CONSULTATION_AUTH_TOKEN', token);
    const body = {
      eventId: '00000000-0000-4000-8000-000000000001',
      source: 'operations',
      eventType: 'FaqCallSourcesRequested',
      payload: { eventIds: ['00000000-0000-4000-8000-000000000002'] },
    };
    await request(app.getHttpServer())
      .post('/internal/faq-call-sources')
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post('/internal/faq-call-sources')
      .set('Authorization', 'Bearer ' + token)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .post('/internal/faq-call-sources')
      .set('Authorization', 'Bearer ' + token)
      .send({ ...body, source: 'customer' })
      .expect(422);
    await request(app.getHttpServer())
      .post('/internal/faq-call-sources')
      .set('Authorization', 'Bearer ' + token)
      .send(body)
      .expect(200)
      .expect({
        eventId: body.eventId,
        status: 'processed',
        payload: {
          calls: [{ eventId: body.payload.eventIds[0], callSessionSeq: null }],
        },
      });
    const response = await request(app.getHttpServer())
      .get('/consultation/docs-json')
      .expect(200);
    expect(
      Object.keys(
        (response.body as { paths: Record<string, unknown> }).paths,
      ).some((path) => path.includes('faq-call-sources')),
    ).toBe(false);
  });
});
