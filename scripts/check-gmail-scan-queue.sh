#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
source .env.server

REMOTE_DIR="/home/1619442.cloudwaysapps.com/yqcmhdmpah/public_html/inventorypal-email"
SSH_OPTS="-o StrictHostKeyChecking=no -p ${SSH_PORT}"

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
    failedReason: job.failedReason || null,
    result: job.returnvalue || null,
  };
}

async function main() {
  const queue = new Queue('gmail-scan', {
    connection: redisConnection(),
    prefix: bullPrefix(),
  });

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaiting(0, 20),
    queue.getActive(0, 20),
    queue.getCompleted(0, 20),
    queue.getFailed(0, 20),
    queue.getDelayed(0, 20),
  ]);

  console.log(JSON.stringify({
    checkedAtUtc: new Date().toISOString(),
    counts: {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
    },
    waiting: await Promise.all(waiting.map(serialize)),
    active: await Promise.all(active.map(serialize)),
    completed: await Promise.all(completed.map(serialize)),
    failed: await Promise.all(failed.map(serialize)),
    delayed: await Promise.all(delayed.map(serialize)),
  }, null, 2));

  await queue.close();
}

main().catch((error) => {
  console.error(JSON.stringify({ error: error.message, stack: error.stack }, null, 2));
  process.exit(1);
});
NODE
