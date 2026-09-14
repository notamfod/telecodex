import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  timeout: 20_000,
  expect: { timeout: 4_000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4193",
    viewport: { width: 390, height: 844 },
    launchOptions: {
      ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
    },
  },
  webServer: {
    command: "npm run dev:web -- --host 127.0.0.1 --port 4193 --strictPort",
    url: "http://127.0.0.1:4193",
    reuseExistingServer: false,
  },
});
