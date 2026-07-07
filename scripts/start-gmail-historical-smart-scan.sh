#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source .env.server

REMOTE_DIR="/home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email"
SSH_OPTS="-o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no -p ${SSH_PORT}"

sshpass -p "${SSH_PASSWORD}" ssh ${SSH_OPTS} "${SSH_USER}@${SSH_HOST}" "cd ${REMOTE_DIR} && DOTENV_CONFIG_PATH=.env.production node -r dotenv/config" <<'NODE'
const { Queue } = require('bullmq');

function redisConnection() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT || 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
  };
}

function bullPrefix() {
  return process.env.REDIS_USERNAME ? `${process.env.REDIS_USERNAME}:bull` : 'bull';
}

async function serialize(job) {
  return {
    id: job.id,
    name: job.name,
    state: await job.getState(),
    progress: job.progress,
    data: job.data,
    createdAtUtc: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    processedAtUtc: job.processedOn ? new Date(job.processedOn).toISOString() : null,
    finishedAtUtc: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
  };
}

async function main() {
  const queue = new Queue('gmail-scan', {
    connection: redisConnection(),
    prefix: bullPrefix(),
  });

  const [active, waiting, delayed] = await Promise.all([
    queue.getActive(0, 5),
    queue.getWaiting(0, 5),
    queue.getDelayed(0, 5),
  ]);

  const existing = [...active, ...waiting, ...delayed][0];
  if (existing) {
    console.log(JSON.stringify({
      started: false,
      reason: 'gmail-scan job already queued or running',
      job: await serialize(existing),
    }, null, 2));
    await queue.close();
    return;
  }

  const job = await queue.add(
    'historical-smart-scan-all-time-2026-07-01',
    {
      scanType: 'smart',
      autoUpdate: true,
      batchSize: 500,
    },
    {
      attempts: 2,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: false,
      removeOnFail: false,
    },
  );

  console.log(JSON.stringify({
    started: true,
    scope: 'in:anywhere -in:trash -in:spam',
    expectedMailboxMessages: 349918,
    job: await serialize(job),
  }, null, 2));

  await queue.close();
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
NODE
