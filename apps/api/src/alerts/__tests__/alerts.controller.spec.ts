import { Test, TestingModule } from '@nestjs/testing';
import { AlertsController } from '../alerts.controller';
import { AlertsService } from '../alerts.service';
import { SignalGrade } from '@quant/shared';

describe('AlertsController', () => {
  let controller: AlertsController;
  let service: any;

  const mockAlert = {
    id: 'alert-1',
    channel: 'TELEGRAM',
    target: '-100123456789',
    minScore: 80,
    minGrade: SignalGrade.A,
    isActive: true,
  };

  beforeEach(async () => {
    service = {
      createAlert: jest.fn().mockResolvedValue(mockAlert),
      listAlerts: jest.fn().mockResolvedValue([mockAlert]),
      deleteAlert: jest.fn().mockResolvedValue(mockAlert),
      testAlert: jest.fn().mockResolvedValue({ success: true, channel: 'TELEGRAM' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AlertsController],
      providers: [{ provide: AlertsService, useValue: service }],
    }).compile();

    controller = module.get<AlertsController>(AlertsController);
  });

  it('should create an alert rule', async () => {
    const res = await controller.createAlert({
      channel: 'TELEGRAM',
      target: '-100123456789',
      minScore: 80,
    });
    expect(res.channel).toBe('TELEGRAM');
    expect(res.minScore).toBe(80);
  });

  it('should list alert rules', async () => {
    const res = await controller.listAlerts();
    expect(res.length).toBe(1);
  });

  it('should test an alert dispatch', async () => {
    const res = await controller.testAlert({
      channel: 'TELEGRAM',
      target: '-100123456789',
    });
    expect(res.success).toBe(true);
  });
});
