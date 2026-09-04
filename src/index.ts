import dotenv from 'dotenv';
dotenv.config();

// Ensure all naive timestamps returned by pg are parsed as IST
process.env.TZ = 'Asia/Kolkata';

import { app } from './app';

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`sodhani-api listening on ${HOST}:${PORT}`);
});
