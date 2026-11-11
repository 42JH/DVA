import { ParcelDraftMigrationService } from '../src/orders/parcel-draft-migration.service';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { DatabaseService } from '../src/database/database.service';
import { AuditService } from '../src/audit/audit.service';
import { AuthService } from '../src/auth/auth.service';
import { ApiException } from '../src/common/errors/api.exception';

describe('Order read API (e2e)', () => {
  let app: INestApplication<App>;
  const query = jest.fn().mockResolvedValue({ rows: [] });
  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ParcelDraftMigrationService)
      .useValue({ onApplicationBootstrap: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(DatabaseService)
      .useValue({ pool: { query } })
      .overrideProvider(AuditService)
      .useValue({ recordFailure: jest.fn().mockResolvedValue(undefined) })
      .overrideProvider(AuthService)
      .useValue({
        readiness: () => Promise.resolve(undefined),
        authenticate: () =>
          Promise.reject(
            new ApiException(
              401,
              'UNAUTHORIZED',
              '아이디·비밀번호 또는 로그인 상태를 확인해 주세요.',
            ),
          ),
      })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  it('keeps health and Swagger and declares reads, DELETE and both cancellation routes', async () => {
    await request(app.getHttpServer()).get('/order/health').expect(200).expect({ status: 'ok' });
    await request(app.getHttpServer()).get('/order/health/ready').expect(200);
    await request(app.getHttpServer())
      .get('/order/docs')
      .expect(200)
      .expect(/swagger-ui/);
    await request(app.getHttpServer())
      .get('/order/docs/swagger-ui-init.js')
      .expect(200)
      .expect(/DVA Order API/);
    await request(app.getHttpServer())
      .get('/order/docs-json')
      .expect(200)
      .expect(({ body }: { body: { paths: Record<string, Record<string, unknown>> } }) => {
        expect(Object.keys(body.paths).sort()).toEqual([
          '/api/admin/orders',
          '/api/admin/orders/{id}/retry',
          '/api/customers/{id}/addresses',
          '/api/orders',
          '/api/orders/{id}',
          '/api/orders/{id}/cancel',
          '/api/orders/{id}/parcels/cancel',
          '/api/parcel-drafts',
          '/api/parcel-drafts/{id}',
          '/api/payments/notifications/{id}/completion/retry',
          '/api/payments/notifications/{id}/retry',
          '/api/payments/requests/{id}',
          '/api/payments/requests/{id}/confirm',
          '/api/payments/requests/{id}/reconcile',
          '/order/health',
          '/order/health/ready',
        ]);
        expect(Object.keys(body.paths['/api/parcel-drafts/{id}']).sort()).toEqual([
          'delete',
          'get',
          'patch',
        ]);
        expect(Object.keys(body.paths['/api/parcel-drafts']).sort()).toEqual(['get', 'post']);
        expect(Object.keys(body.paths['/api/orders/{id}/cancel'])).toEqual(['post']);
        expect(Object.keys(body.paths['/api/admin/orders/{id}/retry'])).toEqual(['post']);
        expect(Object.keys(body.paths['/api/orders/{id}/parcels/cancel'])).toEqual(['post']);
        for (const path of [
          '/api/admin/orders',
          '/api/customers/{id}/addresses',
          '/api/orders',
          '/api/orders/{id}',
        ])
          expect(Object.keys(body.paths[path]).sort()).toEqual(
            path === '/api/orders/{id}' ? ['delete', 'get', 'patch'] : ['get'],
          );
      });
  });

  it('keeps payment reads public, validates UUIDs and returns the original disabled response', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    for (const path of ['requests', 'p', 'success', 'fail']) {
      await request(app.getHttpServer())
        .get('/api/payments/' + path + '/' + id)
        .set('Cookie', 'dva_session=invalid')
        .expect(503)
        .expect(({ body }: { body: { error: { code: string; message: string } } }) => {
          expect(body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
          expect(body.error.message).toBe('주문 결제 연동이 설정되지 않았습니다.');
        });
      await request(app.getHttpServer())
        .get('/api/payments/' + path + '/invalid')
        .expect(400);
    }
    await request(app.getHttpServer()).get('/api/payments/assets/checkout.js').expect(503);
  });

  it('rejects malformed inputs and invalid cookies before accessing owner data', async () => {
    for (const path of [
      '/api/parcel-drafts?status=unknown',
      '/api/parcel-drafts?limit=101',
      '/api/parcel-drafts/0',
      '/api/orders?status=unknown',
      '/api/orders?limit=101',
      '/api/orders/0',
      '/api/customers/1/addresses?direction=BAD',
    ])
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', 'Bearer ' + process.env.AI_BUSINESS_TOKEN)
        .expect(400);
    await request(app.getHttpServer()).get('/api/parcel-drafts').expect(401);
    await request(app.getHttpServer()).get('/api/orders').expect(401);
    await request(app.getHttpServer())
      .get('/api/orders/1')
      .set('Cookie', 'dva_session=bad')
      .set('call_session_seq', '1')
      .expect(401);
    await request(app.getHttpServer()).get('/api/admin/orders').expect(401);
  });

  it('requires the internal token and rejects unknown payloads without business queries', async () => {
    const before = query.mock.calls.length;
    await request(app.getHttpServer()).post('/internal/parcel-draft-delete').send({}).expect(403);
    await request(app.getHttpServer())
      .post('/internal/parcel-draft-delete')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .send({})
      .expect(422);
    await request(app.getHttpServer()).post('/internal/parcel-draft-read').send({}).expect(403);
    await request(app.getHttpServer())
      .post('/internal/parcel-draft-read')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .send({})
      .expect(422);
    await request(app.getHttpServer()).post('/internal/order-read').send({}).expect(403);
    await request(app.getHttpServer()).post('/internal/order-cancellation').send({}).expect(403);
    await request(app.getHttpServer())
      .post('/internal/order-read')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .send({})
      .expect(422);
    expect(query.mock.calls.length).toBe(before);
  });

  it('validates cancellation input before accepting AI scope', async () => {
    for (const body of [
      {},
      { orderParcelSeqs: [] },
      { orderParcelSeqs: [1, 1] },
      { orderParcelSeqs: ['1'] },
      { orderParcelSeqs: [0] },
      { orderParcelSeqs: [1], adminId: 1 },
    ])
      await request(app.getHttpServer())
        .post('/api/orders/1/parcels/cancel')
        .set('Authorization', 'Bearer ' + process.env.AI_BUSINESS_TOKEN)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .post('/api/orders/1/cancel')
      .set('Authorization', 'Bearer ' + process.env.AI_BUSINESS_TOKEN)
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/orders/1/cancel')
      .set('Origin', 'http://localhost:5173')
      .set('Cookie', 'dva_session=bad')
      .set('call_session_seq', '1')
      .expect(401);
  });

  it('requires an allowed Origin and administrator session for DELETE and protects audit recovery', async () => {
    await request(app.getHttpServer()).delete('/api/parcel-drafts/1').expect(403);
    await request(app.getHttpServer())
      .delete('/api/parcel-drafts/1')
      .set('Origin', 'http://localhost:5173')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .expect(401);
    await request(app.getHttpServer()).delete('/api/orders/1').expect(403);
    await request(app.getHttpServer())
      .delete('/api/orders/1')
      .set('Origin', 'http://localhost:5173')
      .set('call_session_seq', '1')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .expect(401);
    await request(app.getHttpServer()).post('/internal/audit/flush').send({}).expect(403);
    await request(app.getHttpServer())
      .post('/internal/audit/flush')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .send({})
      .expect(400);
  });
  it('keeps the original public body limit when the internal envelope parser is larger', async () => {
    await request(app.getHttpServer())
      .post('/api/orders/1/parcels/cancel')
      .send({ orderParcelSeqs: [], padding: 'x'.repeat(103000) })
      .expect(413);
  });
});
