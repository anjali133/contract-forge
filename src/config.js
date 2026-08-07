import 'dotenv/config';

export const config = {
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  mongoUri: process.env.MONGODB_URI || '',
  port: process.env.PORT || 4000,
  maxRetries: 2
};

if (!config.openaiApiKey) {
  console.warn(
    '\u26a0\ufe0f  OPENAI_API_KEY is not set. Add it to your .env file before calling /api/plan or /api/build.'
  );
}
