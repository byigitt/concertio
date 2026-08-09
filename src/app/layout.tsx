import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'concertio',
  description:
    'Dinledigin sanatcilarin yakinindaki konserleri tek listede toplar. Faz 0: SF Bay Area.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body className="min-h-dvh">
        <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-5 sm:px-8">
          <header className="flex items-baseline justify-between gap-4 border-b border-line py-6">
            <a href="/" className="font-display text-xl tracking-tight no-underline">
              concertio
            </a>
            <p className="text-xs uppercase tracking-[0.18em] text-faint">Faz 0 · SF Bay Area</p>
          </header>

          <main className="flex-1 py-10 sm:py-14">{children}</main>

          <footer className="border-t border-line py-6 text-xs leading-relaxed text-faint">
            concertio — kisisel konser takibi. Bildirim ya da e-posta yok; sayfayi acip bakarsin.
          </footer>
        </div>
      </body>
    </html>
  );
}
