import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@klipz/shared", "@klipz/publishers", "@klipz/video"],
  // Local single-user app: uploads go straight to disk through route handlers.
  experimental: { serverActions: { bodySizeLimit: "64mb" } },
  eslint: { ignoreDuringBuilds: true },
};

export default config;
