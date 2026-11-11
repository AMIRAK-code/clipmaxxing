import path from "node:path";
import type { NextConfig } from "next";
import { loadRootEnv } from "./src/lib/root-env";

// One env file for both processes: the repo-root .env.local / .env also feed the web app.
// Next has already loaded apps/web/.env* into process.env by now, and nothing set there (or in the real
// environment) is overridden. Runs in next dev, next build and next start (the config is evaluated in each).
loadRootEnv(path.resolve(__dirname, "..", ".."));

const config: NextConfig = {
  transpilePackages: ["@klipz/shared", "@klipz/publishers", "@klipz/video"],
  // Local single-user app: uploads go straight to disk through route handlers.
  experimental: { serverActions: { bodySizeLimit: "64mb" } },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
