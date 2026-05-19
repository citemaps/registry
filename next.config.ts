import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The registry is API-first. Most routes don't need pre-rendering;
  // the minimal landing page can be statically generated.
  reactStrictMode: true,
  // Phase 1 has no client-side React beyond a landing page; we keep
  // the build lean. As Phase 2 adds public-index pages we'll
  // revisit experimental flags.
};

export default nextConfig;
