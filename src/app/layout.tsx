/**
 * Root layout (T08). Fonts per 06-design §11.7: Inter (UI, tabular numerals, U+20B9 lives in
 * latin-ext, F1), Manrope 600-800 (display only: headings and the landing hero), JetBrains Mono
 * (IDs, payloads). Dark ops theme ("Aurora", design spec §1): the html element carries `dark` for
 * libraries that read it, and themeColor matches --bg-0. The DEMO role switcher is mounted on
 * every route through the build-time gate (P19); a LIVE build ships none of it.
 */
import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import { DemoRoleSwitcher } from '@/components/patterns/DemoChrome';
import { Providers } from '@/components/patterns/Providers';
import './globals.css';

const inter = Inter({ subsets: ['latin', 'latin-ext'], display: 'swap', variable: '--font-inter' });
const manrope = Manrope({ subsets: ['latin', 'latin-ext'], display: 'swap', weight: ['600', '700', '800'], variable: '--font-manrope' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin', 'latin-ext'], display: 'swap', variable: '--font-jetbrains-mono' });

export const metadata: Metadata = {
  title: { default: 'AuraLead AI', template: '%s | AuraLead AI' },
  description: 'Lead capture, scoring, versioned quotes and consent-aware messaging for Indian service businesses.',
};

export const viewport: Viewport = {
  themeColor: '#060A13',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN" className={`dark ${inter.variable} ${manrope.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-dvh bg-bg-0 font-sans text-fg-1 antialiased">
        <Providers>
          {children}
          <DemoRoleSwitcher />
        </Providers>
      </body>
    </html>
  );
}
