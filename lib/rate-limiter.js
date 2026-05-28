/**
 * Simple in-memory rate limiter for API endpoints
 * Tracks requests per IP address with sliding window
 */

// Store: Map<key, { count, resetTime, timestamps[] }>
const store = globalThis.__streamixRateLimiter || new Map();
globalThis.__streamixRateLimiter = store;

/**
 * Check if request should be rate limited
 * @param {string} key - Unique identifier (usually IP address)
 * @param {number} maxRequests - Maximum requests allowed
 * @param {number} windowMs - Time window in milliseconds
 * @returns {boolean} true if rate limit exceeded
 */
export function isRateLimited(key, maxRequests, windowMs) {
  const now = Date.now();
  const record = store.get(key);

  if (!record) {
    store.set(key, {
      timestamps: [now],
      resetTime: now + windowMs,
    });
    return false;
  }

  // Remove expired timestamps (sliding window)
  const cutoff = now - windowMs;
  record.timestamps = record.timestamps.filter((t) => t > cutoff);

  if (record.timestamps.length >= maxRequests) {
    return true; // Rate limit exceeded
  }

  record.timestamps.push(now);
  return false;
}

/**
 * Get current count for a key
 */
export function getCount(key, windowMs) {
  const record = store.get(key);
  if (!record) return 0;

  const now = Date.now();
  const cutoff = now - windowMs;
  return record.timestamps.filter((t) => t > cutoff).length;
}

/**
 * Clean up old entries (run periodically)
 */
export function cleanupRateLimiter() {
  const now = Date.now();
  for (const [key, record] of store.entries()) {
    const cutoff = now - 60000; // 1 minute
    record.timestamps = record.timestamps.filter((t) => t > cutoff);
    if (record.timestamps.length === 0) {
      store.delete(key);
    }
  }
}

// Auto-cleanup every 5 minutes
setInterval(cleanupRateLimiter, 5 * 60 * 1000);
