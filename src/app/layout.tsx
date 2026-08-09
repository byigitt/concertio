import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'concertio',
  description:
    'Dinlediğin sanatçıların yakınındaki konserleri tek listede toplar. Faz 0: SF Bay Area.',
};

/**
 * Belge iskeleti kaynak sirasinda: skip link, header, nav, main, footer.
 * Sarmalayici <div> yok — gereksiz kutu eklemek yapiyi gizler.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="tr">
      <body>
        <a className="skip" href="#main">
          İçeriğe geç
        </a>

        <header>
          {/* Wordmark baslik DEGIL: h1 her sayfanin kendi konusudur, boylece
              baslik hiyerarsisi tek ve dogru kalir. */}
          <p>
            <strong>
              <a href="/">concertio</a>
            </strong>
          </p>
          <p>
            Kişisel konser takibi · Faz 0 · SF Bay Area ·{' '}
            <a href="/api/health">durum</a>
          </p>
          <nav aria-label="Site">
            <ul>
              <li>
                <a href="/">Başlangıç</a>
              </li>
              <li>
                <a href="/me">Eşleşmelerim</a>
              </li>
              <li>
                <a href="/metro/sf-bay-area">SF Bay Area takvimi</a>
              </li>
            </ul>
          </nav>
        </header>

        <hr />

        <main id="main">{children}</main>

        <hr />

        <footer>
          <p>
            Bildirim ya da e-posta yok; sayfayı açıp bakarsın. Etkinlik verisi{' '}
            <a href="https://www.ticketmaster.com/">Ticketmaster</a>, zevk sinyali{' '}
            <a href="https://www.last.fm/">Last.fm</a>, sanatçı kimlikleri{' '}
            <a href="https://musicbrainz.org/">MusicBrainz</a>, adres çözümlemesi{' '}
            <a href="https://nominatim.openstreetmap.org/">OpenStreetMap Nominatim</a>.
          </p>
        </footer>
      </body>
    </html>
  );
}
