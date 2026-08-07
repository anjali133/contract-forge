import OpenAI from 'openai';
import { config } from '../config.js';

const client = new OpenAI({ apiKey: config.openaiApiKey });

/**
 * Calls the model with a system + user prompt and returns parsed JSON (by default)
 * along with token usage, so every agent call can be cost-tracked later.
 */
export async function callAgent({ systemPrompt, userPrompt, jsonMode = true, temperature = 0.3 }) {
  const response = await client.chat.completions.create({
    model: config.openaiModel,
    temperature,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    ...(jsonMode ? { response_format: { type: 'json_object' } } : {})
  });

  const content = response.choices[0]?.message?.content ?? '';
  const usage = response.usage;

  if (!jsonMode) return { text: content, usage };

  try {
    return { data: JSON.parse(content), usage };
  } catch (err) {
    throw new Error(`Agent returned invalid JSON: ${err.message}\n---\n${content}`);
  }
}
