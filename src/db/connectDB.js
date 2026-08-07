import mongoose from 'mongoose';
import { config } from '../config.js';

let connected = false;

export async function connectDB() {
  if (!config.mongoUri) {
    console.warn('\u26a0\ufe0f  MONGODB_URI is not set \u2014 generation history will not be saved (the builder still works fine).');
    return false;
  }
  try {
    await mongoose.connect(config.mongoUri);
    connected = true;
    console.log('Connected to MongoDB \u2014 generation history will be saved.');
    return true;
  } catch (err) {
    console.warn(`\u26a0\ufe0f  Could not connect to MongoDB (${err.message}) \u2014 the builder still works, history just won't be saved.`);
    return false;
  }
}

export function isDBConnected() {
  return connected;
}
