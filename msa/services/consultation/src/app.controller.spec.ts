import { AppController } from './app.controller';
import { AuthService } from './auth/auth.service';
import { DatabaseService } from './database/database.service';
import { CustomerContextClient } from './customers/customer-context.client';

describe('AppController', () => {
  it('서버 상태를 반환한다', () => {
    const controller = new AppController(
      {} as DatabaseService,
      {} as AuthService,
      {} as CustomerContextClient,
    );

    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });
});
