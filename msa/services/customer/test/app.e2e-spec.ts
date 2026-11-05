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

describe('Customer read API (e2e)', () => {
  let app: INestApplication<App>;
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
  });
  afterAll(async () => {
    await app.close();
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
          '/api/customers/{id}': ['get'],
          '/api/companies': ['get', 'post'],
          '/api/companies/search': ['get'],
          '/api/companies/{id}': ['get', 'patch', 'delete'],
          '/api/companies/{id}/members': ['get', 'post'],
          '/api/companies/{id}/departments': ['get', 'post'],
          '/api/members/{id}': ['patch', 'delete'],
          '/api/departments/{id}': ['patch', 'delete'],
        })) {
          expect(Object.keys(paths[path]).sort()).toEqual(methods.sort());
        }
        expect(paths['/api/customers/context']).toBeUndefined();
        expect(paths['/api/companies/{id}/billing']).toBeUndefined();
        expect(paths['/internal/audit/flush']).toBeUndefined();
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
  it('requires current sessions for administrator reads and preserves error envelopes', async () => {
    await request(app.getHttpServer())
      .get('/api/customers')
      .expect(401)
      .expect(({ body }: { body: { error: { code: string }; meta: { requestId: string } } }) => {
        expect(body.error.code).toBe('UNAUTHORIZED');
        expect(body.meta.requestId).toEqual(expect.any(String));
      });
    await request(app.getHttpServer()).post('/api/customers').send({}).expect(400);
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
