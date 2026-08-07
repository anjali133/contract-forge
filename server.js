import express from 'express';
import cors from 'cors';
import { config } from './src/config.js';
import { connectDB } from './src/db/connectDB.js';
import generateRouter from './src/routes/generate.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', generateRouter);

connectDB().finally(() => {
  app.listen(config.port, () => {
    console.log(`Multi-agent builder running at http://localhost:${config.port}`);
    console.log(`Open http://localhost:${config.port}/test.html to try it`);
  });
});
