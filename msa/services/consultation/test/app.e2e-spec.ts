import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';

describe('Consultation infrastructure (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves health under the ingress prefix', async () => {
    await request(app.getHttpServer())
      .get('/consultation/health')
      .expect(200)
      .expect({ status: 'ok' });
    await request(app.getHttpServer()).get('/customer/health').expect(404);
  });

  it('serves Swagger UI and its assets under the same prefix', async () => {
    await request(app.getHttpServer())
      .get('/consultation/docs')
      .expect(200)
      .expect(/swagger-ui/);
    await request(app.getHttpServer())
      .get('/consultation/docs/swagger-ui-init.js')
      .expect(200)
      .expect(/DVA Consultation API/);
  });

  it('publishes the prefixed health contract in OpenAPI', async () => {
    await request(app.getHttpServer())
      .get('/consultation/docs-json')
      .expect(200)
      .expect(
        ({
          body,
        }: {
          body: { info: { title: string }; paths: Record<string, unknown> };
        }) => {
          expect(body.info.title).toBe('DVA Consultation API');
          expect(Object.keys(body.paths)).toEqual(['/consultation/health']);
        },
      );
  });
});
