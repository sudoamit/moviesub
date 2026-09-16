/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
    './src/workspaces/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#080c14',
        surface: {
          DEFAULT: '#0e1422',
          subtle: '#0a0f1a',
          panel: '#0f172a',
          elevated: '#131b2e',
          overlay: '#162036',
          border: '#1e293b',
          hover: '#1a243a',
        },
        brand: {
          cyan: '#06b6d4',
          teal: '#14b8a6',
          emerald: '#10b981',
          indigo: '#6366f1',
        },
        bullish: '#10b981',
        bearish: '#ef4444',
        warning: '#f59e0b',
        neutralState: '#64748b',
        accent: '#06b6d4',
        'accent-glow': '#22d3ee',
        grade: {
          'a-plus': '#3b82f6',
          a: '#10b981',
          b: '#eab308',
          c: '#f97316',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        sans: ['Outfit', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
