import dotenv from 'dotenv';
dotenv.config();

import { app } from './app';

const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '127.0.0.1';

app.listen(PORT, HOST, () => {
  console.log(`sodhani-api listening on ${HOST}:${PORT}`);
});
