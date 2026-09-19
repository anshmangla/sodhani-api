import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { globalLimiter } from './middleware/rateLimiter';
import marketRouter from './routes/market';
import peersRouter from './routes/peers';
import authRouter from './routes/auth';
import raAuthRouter from './routes/raAuth';
import raCallsRouter from './routes/raCalls';
import raOnboardingRouter from './routes/raOnboarding';
import callsRouter from './routes/calls';
import paymentsRouter from './routes/payments';
import paymentsWebhookRouter from './routes/paymentsWebhook';
import myCallsRouter from './routes/myCalls';
import watchlistRouter from './routes/watchlist';
import analystsRouter from './routes/analysts';
import adminAuthRouter from './routes/adminAuth';
import adminRasRouter from './routes/adminRas';
import adminUsersRouter from './routes/adminUsers';
import adminCallsRouter from './routes/adminCalls';
import adminTransactionsRouter from './routes/adminTransactions';
import { requireAdminAuth } from './auth/adminMiddleware';

export const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

const allowedOrigins = [
  'https://safedge.in',
  'https://www.safedge.in',
  'https://ra.safedge.in',
  'https://sodhani.vercel.app', 
  'http://localhost:5173',
  'http://localhost:3000',
  'http://localhost:5174',      // sodhani-admin local dev
  'https://sodhani-admin.vercel.app' // sodhani-admin prod, deployed at tanishbajaj101-5009s-projects/sodhani-admin
];

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use('/api/payments/webhook', express.raw({ type: 'application/json', limit: '1mb' }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Global rate limiter on all /api routes (100 req/min per IP)
app.use('/api', globalLimiter);

// peersRouter must be mounted before marketRouter: marketRouter's
// GET /company/:symbol/:concern is a wildcard that would otherwise swallow
// GET /company/:symbol/peers (binding "peers" as :concern and 400ing).
app.use('/api', peersRouter);
app.use('/api', marketRouter);
app.use('/api/auth', authRouter);
app.use('/api/ra', raAuthRouter);
app.use('/api/ra/onboarding', raOnboardingRouter);
app.use('/api/ra', raCallsRouter);
app.use('/api/calls', callsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/payments/webhook', paymentsWebhookRouter);
app.use('/api/me', myCallsRouter);
app.use('/api/watchlist', watchlistRouter);
app.use('/api/analyst', analystsRouter);
app.use('/api/admin/auth', adminAuthRouter);
app.use('/api/admin/ras', requireAdminAuth, adminRasRouter);
app.use('/api/admin/users', requireAdminAuth, adminUsersRouter);
app.use('/api/admin/calls', requireAdminAuth, adminCallsRouter);
app.use('/api/admin/transactions', requireAdminAuth, adminTransactionsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Postgres error-code mapping middleware (M-02, M-03)
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && typeof err === 'object' && 'code' in err) {
    if (err.code === '22P02' || err.code === '22007' || err.code === '22003') {
      res.status(400).json({ error: 'Invalid parameter format or value out of range' });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'Resource conflict or duplicate entry' });
      return;
    }
    if (err.code === '23503') {
      res.status(400).json({ error: 'Referenced resource does not exist' });
      return;
    }
  }
  next(err);
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
