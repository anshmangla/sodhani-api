import express from 'express';
import cors from 'cors';
import marketRouter from './routes/market';
import authRouter from './routes/auth';
import raAuthRouter from './routes/raAuth';

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api', marketRouter);
app.use('/api/auth', authRouter);
app.use('/api/ra', raAuthRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
