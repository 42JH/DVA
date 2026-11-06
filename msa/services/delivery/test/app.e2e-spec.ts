import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { DatabaseService } from '../src/database.service';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

describe('Delivery infrastructure (e2e)', () => {
  let app: INestApplication<App>;
  const query = jest.fn().mockResolvedValue({ rows: [] });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(DatabaseService)
      .useValue({
        pool: { query },
        transaction: jest.fn(),
      })
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health under the ingress prefix', async () => {
    await request(app.getHttpServer())
      .get('/delivery/health')
      .expect(200)
      .expect({ status: 'ok' });
    await request(app.getHttpServer()).get('/customer/health').expect(404);
  });

  it('serves Swagger UI and its assets under the same prefix', async () => {
    await request(app.getHttpServer())
      .get('/delivery/docs')
      .expect(200)
      .expect(/swagger-ui/);
    await request(app.getHttpServer())
      .get('/delivery/docs/swagger-ui-init.js')
      .expect(200)
      .expect(/DVA Delivery API/);
  });

  it('publishes the prefixed health contract in OpenAPI', async () => {
    await request(app.getHttpServer())
      .get('/delivery/docs-json')
      .expect(200)
      .expect(
        ({
          body,
        }: {
          body: { info: { title: string }; paths: Record<string, unknown> };
        }) => {
          expect(body.info.title).toBe('DVA Delivery API');
          expect(Object.keys(body.paths).sort()).toEqual([
            '/delivery/health',
            '/delivery/health/ready',
          ]);
        },
      );
  });
  it('does not expose the internal handler and rejects missing/bad service credentials', async () => {
    await request(app.getHttpServer())
      .get('/delivery/health/ready')
      .expect(200);
    await request(app.getHttpServer())
      .post('/internal/order-shipment-check')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/internal/order-shipment-check')
      .set('Authorization', 'Bearer ' + process.env.CUSTOMER_AUTH_TOKEN)
      .send({})
      .expect(422);
    await request(app.getHttpServer())
      .post('/delivery/internal/order-shipment-check')
      .send({})
      .expect(404);
  });
  it('keeps process health alive and redacts database readiness failures', async () => {
    query.mockRejectedValueOnce(new Error('private database probe'));
    const response = await request(app.getHttpServer())
      .get('/delivery/health/ready')
      .expect(503);
    expect(JSON.stringify(response.body)).not.toContain('private');
    await request(app.getHttpServer()).get('/delivery/health').expect(200);
    await request(app.getHttpServer())
      .get('/delivery/health/ready')
      .expect(200);
  });
});
