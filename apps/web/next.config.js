/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@quant/shared', '@quant/trading-engine', '@quant/learning-engine'],
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
