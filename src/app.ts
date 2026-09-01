import express from 'express';
import cors from 'cors';
import path from 'path';
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

export const app = express();

const allowedOrigins = [
  'https://safedge.in',
  'https://www.safedge.in',
  'https://ra.safedge.in',
  'https://sodhani.vercel.app', 
  'http://localhost:5173',      
  'http://localhost:3000'       
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

app.use('/api', marketRouter);
app.use('/api', peersRouter);
app.use('/api/auth', authRouter);
app.use('/api/ra', raAuthRouter);
app.use('/api/ra/onboarding', raOnboardingRouter);
app.use('/api/ra', raCallsRouter);
app.use('/api/calls', callsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/payments/webhook', paymentsWebhookRouter);
app.use('/api/me', myCallsRouter);
app.use('/api/watchlist', watchlistRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
