// src/queue/redisConnection.js
//
// Single shared Redis connection config for all BullMQ queues/workers.
// REDIS_URL supports free-tier providers (Upstash, Render Redis, etc.)
// as well as a local `redis-server` in dev.

const { RedisOptions } = {}; // placeholder to keep this file dependency-light

function getConnectionOptions() {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  return {
    url,
    // BullMQ requires this to be null, not undefined - it manages its
    // own retry/backoff semantics per job, not per connection.
    maxRetriesPerRequest: null,
  };
}

module.exports = { getConnectionOptions };
