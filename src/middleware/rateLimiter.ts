import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { normalizePhoneNumber } from '../auth/msg91';

const isTest = process.env.NODE_ENV === 'test';
const skipTest = (req: any) => isTest && !req.headers['x-test-rate-limit'];

// Global rate limiter: 100 requests / minute per IP
export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  message: {
    detail: 'Too many requests, please try again later.',
    error: 'Too many requests, please try again later.',
  },
});

// Send OTP: 3 requests / hour per phone number
export const sendOtpPhoneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  keyGenerator: (req) => {
    const raw = req.body?.phone_number;
    if (typeof raw === 'string' && raw.trim()) {
      return `phone:${normalizePhoneNumber(raw.trim()) || raw.trim()}`;
    }
    return ipKeyGenerator(req.ip || '127.0.0.1');
  },
  message: {
    detail: 'Too many OTP requests for this phone number. Please try again in an hour.',
    error: 'Too many OTP requests for this phone number. Please try again in an hour.',
  },
});

// Send OTP: 10 requests / hour per IP
export const sendOtpIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  keyGenerator: (req) => ipKeyGenerator(req.ip || '127.0.0.1'),
  message: {
    detail: 'Too many OTP requests from this IP. Please try again in an hour.',
    error: 'Too many OTP requests from this IP. Please try again in an hour.',
  },
});

// Verify OTP (login & signup): 5 attempts / 15 minutes per phone number
export const verifyOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  keyGenerator: (req) => {
    const raw = req.body?.phone_number;
    if (typeof raw === 'string' && raw.trim()) {
      return `verify_phone:${normalizePhoneNumber(raw.trim()) || raw.trim()}`;
    }
    return ipKeyGenerator(req.ip || '127.0.0.1');
  },
  message: {
    detail: 'Too many OTP verification attempts. Please wait 15 minutes before trying again.',
    error: 'Too many OTP verification attempts. Please wait 15 minutes before trying again.',
  },
});

// Check phone: 10 requests / hour per IP
export const checkPhoneLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  keyGenerator: (req) => ipKeyGenerator(req.ip || '127.0.0.1'),
  message: {
    detail: 'Too many phone check requests. Please try again in an hour.',
    error: 'Too many phone check requests. Please try again in an hour.',
  },
});

// Admin Login: 5 attempts / 15 minutes per IP (no identity field to key on —
// it's a single shared password, not per-account credentials).
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  keyGenerator: (req) => ipKeyGenerator(req.ip || '127.0.0.1'),
  message: {
    detail: 'Too many login attempts. Please wait 15 minutes before trying again.',
    error: 'Too many login attempts. Please wait 15 minutes before trying again.',
  },
});

// RA Login: 5 attempts / 15 minutes per email
export const raLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipTest,
  keyGenerator: (req) => {
    const raw = req.body?.email;
    if (typeof raw === 'string' && raw.trim()) {
      return `ra_email:${raw.trim().toLowerCase()}`;
    }
    return ipKeyGenerator(req.ip || '127.0.0.1');
  },
  message: {
    detail: 'Too many login attempts. Please wait 15 minutes before trying again.',
    error: 'Too many login attempts. Please wait 15 minutes before trying again.',
  },
});
