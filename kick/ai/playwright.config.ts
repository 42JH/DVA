import { defineConfig } from '@playwright/test';

const port = process.env.GEMMA_TEST_PORT ?? '5178';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  use: { baseURL, channel: 'chrome' },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
