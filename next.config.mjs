/** @type {import('next').NextConfig} */
const nextConfig = {
  // The sandbox preview is served from https://{port}-{id}.e2b.app
  allowedDevOrigins: ['*.e2b.app'],
  serverExternalPackages: ['@electric-sql/pglite'],
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Keep server actions working behind the preview proxy.
    serverActions: { allowedOrigins: ['*.e2b.app', 'localhost:3000'] },
  },
};
export default nextConfig;
