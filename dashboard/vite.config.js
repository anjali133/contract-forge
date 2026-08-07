import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Runs on 5174 -- deliberately different from both the builder's own API (4000)
// and a generated app's frontend (5173), so all three can run at once.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // Must match the PORT in the root .env of the builder's backend.
      // If you change one, change both, or requests here will silently fail.
      '/api': 'http://localhost:4000'
    }
  }
});
