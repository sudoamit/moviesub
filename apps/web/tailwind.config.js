/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#0a0d14',
        surface: '#111726',
        'surface-border': '#1e293b',
        'surface-hover': '#1e2738',
        bullish: '#10b981',
        bearish: '#ef4444',
        accent: '#6366f1',
        'accent-glow': '#818cf8',
        grade: {
          'a-plus': '#3b82f6',
          a: '#10b981',
          b: '#eab308',
          c: '#f97316',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
