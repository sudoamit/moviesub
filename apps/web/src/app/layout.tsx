import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Quant Intelligence Pro | SMC & Market Structure Platform',
  description:
    'Institutional Smart Money Concepts (SMC) scanner, multi-timeframe market structure, liquidity sweeps, FVG, risk management, and quantitative backtesting platform for NIFTY, Indian Stocks, and Crypto.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body
        className="bg-[#0A0E17] text-slate-100 min-h-screen flex flex-col antialiased"
        suppressHydrationWarning
      >
        {children}
      </body>
    </html>
  );
}
