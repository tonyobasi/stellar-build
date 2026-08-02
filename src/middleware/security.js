import crypto from 'node:crypto';
import { ApiError } from '../errors.js';

export function enforceAllowedHosts(config) {
  const allowedHosts = new Set(config.allowedHosts.map((host) => host.toLowerCase()));

  return (req, _res, next) => {
    if (allowedHosts.size === 0) {
      return next();
    }

    const hostname = req.hostname?.toLowerCase();
    if (!hostname || !allowedHosts.has(hostname)) {
      return next(new ApiError(400, 'Invalid host header'));
    }

    return next();
  };
}

export function enforceHttps(config) {
  return (req, _res, next) => {
    if (!config.requireHttps) {
      return next();
    }

    const forwardedProto = req.get('X-Forwarded-Proto')?.split(',')[0]?.trim();
    const protocol = forwardedProto || req.protocol;

    if (protocol !== 'https') {
      return next(new ApiError(426, 'HTTPS is required'));
    }

    return next();
  };
}

export function enforceIpAllowlist(config) {
  const allowedIps = new Set(config.apiAllowedIps.map(normalizeIp));

  return (req, _res, next) => {
    if (allowedIps.size === 0) {
      return next();
    }

    const ip = normalizeIp(req.ip || req.socket.remoteAddress || '');
    if (!allowedIps.has(ip)) {
      return next(new ApiError(403, 'IP address is not allowed'));
    }

    return next();
  };
}

export function createRateLimiter(config) {
  const buckets = new Map();
  const { windowMs, max } = config.rateLimit;

  return (req, res, next) => {
    const now = Date.now();
    const key = rateLimitKey(req);
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      setRateLimitHeaders(res, { limit: max, remaining: max - 1, resetAt: now + windowMs });
      cleanupBuckets(buckets, now);
      return next();
    }

    current.count += 1;
    const remaining = Math.max(0, max - current.count);
    setRateLimitHeaders(res, { limit: max, remaining, resetAt: current.resetAt });

    if (current.count > max) {
      return next(new ApiError(429, 'Too many requests'));
    }

    return next();
  };
}

function rateLimitKey(req) {
  const ip = normalizeIp(req.ip || req.socket.remoteAddress || '');
  const credential = req.get('X-API-Key') || req.get('Authorization') || 'anonymous';
  const credentialHash = crypto.createHash('sha256').update(credential).digest('hex').slice(0, 16);
  return `${ip}:${credentialHash}`;
}

function setRateLimitHeaders(res, { limit, remaining, resetAt }) {
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
}

function cleanupBuckets(buckets, now) {
  if (buckets.size < 10000) {
    return;
  }

  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function normalizeIp(ip) {
  return ip.replace(/^::ffff:/, '').replace(/^::1$/, '127.0.0.1');
}
