// src/middleware/redisRateLimitStore.js
//
// express-rate-limit's default store is an in-memory Map. With more than
// one API instance running (which any real deployment needs for
// availability), each instance has its own counter - so "20 login
// attempts per 15 minutes" actually becomes "20 * (number of instances)"
// in practice, because instance A has no idea what instance B has
// counted (see audit report, Medium #22).
//
// This is a small Store implementation (matching express-rate-limit v7's
// Store interface: increment/decrement/resetKey, optional init) backed by
// Redis, which every instance already talks to for BullMQ - so this adds
// no new infrastructure dependency, just a new use of the one already
// there.
//
// Deliberately NOT using the `rate-limit-redis` package: this repo
// already depends on `ioredis` transitively via BullMQ, and the
// interface needed here is tiny, so a few dozen lines here avoids adding
// another dependency to a payments codebase for something this small.

const Redis = require('ioredis');
const { getConnectionOptions } = require('../queue/redisConnection');

let sharedClient = null;

function getClient() {
  if (!sharedClient) {
    const { url, ...opts } = getConnectionOptions();
    sharedClient = new Redis(url, opts);
    sharedClient.on('error', (err) => {
      // Don't let a Redis hiccup crash rate limiting - fail OPEN (allow
      // the request) rather than fail closed (take the whole API down),
      // since the risk here is "temporarily under-throttled", not
      // "financial correctness". express-rate-limit's `increment()`
      // rejecting will just propagate as a 500 for that request unless
      // we swallow it - see RedisStore.increment below.
      console.error('[rateLimit] redis connection error:', err.message);
    });
  }
  return sharedClient;
}

class RedisStore {
  constructor({ prefix, windowMs }) {
    this.prefix = prefix;
    this.windowMs = windowMs;
    this.client = getClient();
  }

  key(k) {
    return `ratelimit:${this.prefix}:${k}`;
  }

  async increment(key) {
    const redisKey = this.key(key);
    try {
      const totalHits = await this.client.incr(redisKey);
      if (totalHits === 1) {
        await this.client.pexpire(redisKey, this.windowMs);
      }
      const ttl = await this.client.pttl(redisKey);
      const resetTime = new Date(Date.now() + (ttl > 0 ? ttl : this.windowMs));
      return { totalHits, resetTime };
    } catch (err) {
      // Fail open - see getClient() comment above.
      console.error('[rateLimit] increment failed, allowing request:', err.message);
      return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key) {
    try {
      await this.client.decr(this.key(key));
    } catch {
      // Best-effort - a missed decrement just makes this window very
      // slightly stricter than intended, not a correctness problem.
    }
  }

  async resetKey(key) {
    try {
      await this.client.del(this.key(key));
    } catch {
      // Best-effort, same as above.
    }
  }
}

module.exports = { RedisStore };
