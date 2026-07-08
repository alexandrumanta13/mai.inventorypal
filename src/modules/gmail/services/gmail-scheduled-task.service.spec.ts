import { GmailScheduledTask } from './gmail-scheduled-task.service';

describe('GmailScheduledTask', () => {
  const fixedNow = new Date('2026-07-08T22:00:00.000Z');
  let queue: {
    getActiveCount: jest.Mock;
    getWaitingCount: jest.Mock;
    getDelayedCount: jest.Mock;
    add: jest.Mock;
  };
  let service: GmailScheduledTask;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(fixedNow);
    queue = {
      getActiveCount: jest.fn().mockResolvedValue(0),
      getWaitingCount: jest.fn().mockResolvedValue(0),
      getDelayedCount: jest.fn().mockResolvedValue(0),
      add: jest.fn().mockResolvedValue({ id: 'daily-1' }),
    };
    service = new GmailScheduledTask(queue as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not enqueue the daily scan when another Gmail scan is active', async () => {
    queue.getActiveCount.mockResolvedValueOnce(1);

    await service.handleDailyFullScan();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues the daily smart scan for the last 36 hours when the Gmail scan queue is idle', async () => {
    await service.handleDailyFullScan();

    expect(queue.add).toHaveBeenCalledWith(
      'daily-smart-scan',
      {
        scanType: 'smart',
        daysBack: undefined,
        afterDate: '2026-07-07T10:00:00.000Z',
        autoUpdate: true,
      },
      expect.objectContaining({
        attempts: 3,
        removeOnFail: false,
      }),
    );
  });

  it('queues a weekly reconciliation scan for the last 7 days', async () => {
    await service.handleWeeklyReconciliationScan();

    expect(queue.add).toHaveBeenCalledWith(
      'weekly-reconciliation-smart-scan',
      {
        scanType: 'smart',
        daysBack: 7,
        afterDate: undefined,
        autoUpdate: true,
      },
      expect.objectContaining({
        attempts: 3,
        removeOnFail: false,
      }),
    );
  });
});
