import express from 'express';
import cors from 'cors';
import marketRouter from './routes/market';
import authRouter from './routes/auth';
import raAuthRouter from './routes/raAuth';
import raCallsRouter from './routes/raCalls';
import raOnboardingRouter from './routes/raOnboarding';
import callsRouter from './routes/calls';
import paymentsRouter from './routes/payments';
import paymentsWebhookRouter from './routes/paymentsWebhook';
import myCallsRouter from './routes/myCalls';

export const app = express();

app.use(cors());
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', marketRouter);
app.use('/api/auth', authRouter);
app.use('/api/ra', raAuthRouter);
app.use('/api/ra/onboarding', raOnboardingRouter);
app.use('/api/ra', raCallsRouter);
app.use('/api/calls', callsRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/payments/webhook', paymentsWebhookRouter);
app.use('/api/me', myCallsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
