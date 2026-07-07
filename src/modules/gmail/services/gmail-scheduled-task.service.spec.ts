import { GmailScheduledTask } from './gmail-scheduled-task.service';

describe('GmailScheduledTask', () => {
  let queue: {
    getActiveCount: jest.Mock;
    getWaitingCount: jest.Mock;
    getDelayedCount: jest.Mock;
    add: jest.Mock;
  };
  let service: GmailScheduledTask;

  beforeEach(() => {
    queue = {
      getActiveCount: jest.fn().mockResolvedValue(0),
      getWaitingCount: jest.fn().mockResolvedValue(0),
      getDelayedCount: jest.fn().mockResolvedValue(0),
      add: jest.fn().mockResolvedValue({ id: 'daily-1' }),
    };
    service = new GmailScheduledTask(queue as any);
  });

  it('does not enqueue the daily scan when another Gmail scan is active', async () => {
    queue.getActiveCount.mockResolvedValueOnce(1);

    await service.handleDailyFullScan();

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues the daily smart scan when the Gmail scan queue is idle', async () => {
    await service.handleDailyFullScan();

    expect(queue.add).toHaveBeenCalledWith(
      'daily-smart-scan',
      {
        scanType: 'smart',
        daysBack: 7,
        autoUpdate: true,
      },
      expect.objectContaining({
        attempts: 3,
        removeOnFail: false,
      }),
    );
  });
});
