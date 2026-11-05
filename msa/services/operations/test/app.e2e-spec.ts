import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { DatabaseService } from '../src/database/database.service';

describe('Operations infrastructure (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({ pool: { query: jest.fn().mockResolvedValue({ rows: [] }) } })
      .compile();
    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health under the ingress prefix', async () => {
    await request(app.getHttpServer())
      .get('/operations/health')
      .expect(200)
      .expect({ status: 'ok' });
    await request(app.getHttpServer()).get('/operations/health/ready').expect(200);
    await request(app.getHttpServer()).get('/customer/health').expect(404);
  });

  it('serves Swagger UI and its assets under the same prefix', async () => {
    await request(app.getHttpServer())
      .get('/operations/docs')
      .expect(200)
      .expect(/swagger-ui/);
    await request(app.getHttpServer())
      .get('/operations/docs/swagger-ui-init.js')
      .expect(200)
      .expect(/DVA Operations API/);
  });

  it('publishes the prefixed health contract in OpenAPI', async () => {
    await request(app.getHttpServer())
      .get('/operations/docs-json')
      .expect(200)
      .expect(({ body }: { body: { info: { title: string }; paths: Record<string, unknown> } }) => {
        expect(body.info.title).toBe('DVA Operations API');
        expect(Object.keys(body.paths)).toEqual(
          expect.arrayContaining([
            '/operations/health',
            '/operations/health/ready',
            '/api/auth/login',
            '/api/auth/signup',
            '/api/auth/logout',
            '/api/auth/me',
            '/api/auth/password',
            '/api/admins',
            '/api/admins/{id}',
            '/api/admins/{id}/password',
            '/api/audit-logs',
            '/api/audit-logs/{id}',
          ]),
        );
      });
  });

  it('requires a session and preserves the API error envelope', async () => {
    await request(app.getHttpServer())
      .get('/api/auth/me')
      .expect(401)
      .expect(({ body }: { body: { error: { code: string }; meta: { requestId: string } } }) => {
        expect(body.error.code).toBe('UNAUTHORIZED');
        expect(body.meta.requestId).toEqual(expect.any(String));
      });
  });

  it('fails readiness while keeping liveness when the database is unavailable', async () => {
    const database = app.get(DatabaseService);
    jest.spyOn(database.pool, 'query').mockRejectedValueOnce(new Error('unavailable') as never);
    await request(app.getHttpServer()).get('/operations/health/ready').expect(503);
    await request(app.getHttpServer()).get('/operations/health').expect(200);
  });

  it('lets consultation verify sessions while rejecting forged customer events and public admin access', async () => {
    const token = 'local-test-consultation-token-'.padEnd(48, 'c');
    app.get(ConfigService).set('CONSULTATION_AUTH_TOKEN', token);
    const authorization = 'Bearer ' + token;
    await request(app.getHttpServer())
      .post('/internal/auth/session')
      .set('Authorization', authorization)
      .send({ sessionToken: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/internal/events')
      .set('Authorization', authorization)
      .send({
        eventId: '00000000-0000-4000-8000-000000000001',
        source: 'customer',
        eventType: 'AuditAborted',
        payload: { transactionId: '00000000-0000-4000-8000-000000000002' },
      })
      .expect(401)
      .expect({ error: 'EVENT_UNAUTHORIZED' });
    await request(app.getHttpServer())
      .get('/api/admins')
      .set('Authorization', authorization)
      .expect(401);
  });

  it('requires service credentials for internal sessions and keeps them out of public Swagger', async () => {
    const body = { sessionToken: 'a'.repeat(64) };
    await request(app.getHttpServer()).post('/internal/auth/session').send(body).expect(403);
    await request(app.getHttpServer())
      .post('/internal/auth/session')
      .set('Cookie', 'dva_session=' + 'a'.repeat(64))
      .send(body)
      .expect(403);
    await request(app.getHttpServer())
      .post('/internal/auth/session')
      .set('Authorization', 'Bearer wrong')
      .send(body)
      .expect(403);
    const authorization = 'Bearer ' + 'local-test-only-token-'.padEnd(40, 'a');
    await request(app.getHttpServer())
      .get('/api/admins')
      .set('Authorization', authorization)
      .expect(401);
    await request(app.getHttpServer())
      .post('/internal/auth/session')
      .set('Authorization', authorization)
      .send({ sessionToken: '' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/internal/auth/session')
      .set('Authorization', authorization)
      .send({ ...body, role: 'SYSTEM_ADMIN' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/internal/auth/session')
      .set('Authorization', authorization)
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .get('/operations/docs-json')
      .expect(200)
      .expect(({ body }: { body: { paths: Record<string, unknown> } }) => {
        expect(body.paths['/internal/auth/session']).toBeUndefined();
        expect(body.paths['/api/internal/auth/session']).toBeUndefined();
      });
  });
});
