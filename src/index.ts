import dotenv from 'dotenv';
dotenv.config();

import { app } from './app';

const PORT = parseInt(process.env.PORT || '4000', 10);

app.listen(PORT, () => {
  console.log(`sodhani-api listening on port ${PORT}`);
});
