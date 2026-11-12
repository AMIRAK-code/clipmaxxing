import path from "node:path";
import type { NextConfig } from "next";
import { loadRootEnv } from "./src/lib/root-env";

// One env file for both processes: the repo-root .env.local / .env also feed the web app.
// Next has already loaded apps/web/.env* into process.env by now, and nothing set there (or in the real
// environment) is overridden. Runs in next dev, next build and next start (the config is evaluated in each).
loadRootEnv(path.resolve(__dirname, "..", ".."));

const config: NextConfig = {
  // Self-contained server (apps/web/.next/standalone) for the desktop app: a few MB of traced files
  // instead of the whole node_modules, so it starts in about a second. `next start` still works.
  output: "standalone",
  // The monorepo root; also stops Next guessing it from stray lockfiles higher up (e.g. in the home folder).
  outputFileTracingRoot: path.resolve(__dirname, "..", ".."),
  transpilePackages: ["@klipz/shared", "@klipz/publishers", "@klipz/video"],
  // Local single-user app: uploads go straight to disk through route handlers.
  experimental: { serverActions: { bodySizeLimit: "64mb" } },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
