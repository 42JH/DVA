import { DatabaseService } from './database.service';
import { AppController } from './app.controller';

describe('AppController', () => {
  it('서버 상태를 반환한다', () => {
    const controller = new AppController({} as DatabaseService);

    expect(controller.getHealth()).toEqual({ status: 'ok' });
  });
});
