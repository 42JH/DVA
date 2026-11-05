import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApplication } from '../src/configure-application';
import { DatabaseService } from '../src/database/database.service';
import { AuthService } from '../src/auth/auth.service';
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
    await request(app.getHttpServer())
      .get('/consultation/docs-json')
      .expect(200)
      .expect(({ body }: { body: { paths: Record<string, unknown> } }) => {
        expect(Object.keys(body.paths).sort()).toEqual([
          '/api/calls/active-count',
          '/api/calls/active-count/stream',
          '/consultation/health',
          '/consultation/health/ready',
          '/webhooks/pbx/call-ended',
        ]);
      });
    await request(app.getHttpServer()).get('/api/calls').expect(404);
    await request(app.getHttpServer()).delete('/api/calls/1').expect(404);
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
});
