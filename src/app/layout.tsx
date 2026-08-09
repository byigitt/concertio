import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'concertio',
  description:
    'finds upcoming concerts by the artists you actually listen to. phase 0: sf bay area.',
};

/**
 * Belge iskeleti kaynak sirasinda: skip link, header, nav, main, footer.
 * Sarmalayici <div> yok — gereksiz kutu eklemek yapiyi gizler.
 *
 * Metinler ingilizce ve kaynakta kucuk harfle yazili; `body`'deki
 * `text-transform: lowercase` veri kaynakli metni de kucultuyor.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          skip to content
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
            personal concert tracking · phase 0 · sf bay area ·{' '}
            <a href="/api/health">status</a>
          </p>
          <nav aria-label="site">
            <ul>
              <li>
                <a href="/">start</a>
              </li>
              <li>
                <a href="/me">my matches</a>
              </li>
              <li>
                <a href="/metro/sf-bay-area">sf bay area calendar</a>
              </li>
            </ul>
          </nav>
        </header>

        <hr />

        <main id="main">{children}</main>

        <hr />

        <footer>
          <p>
            no notifications, no email; you open the page and look. event data from{' '}
            <a href="https://www.ticketmaster.com/">ticketmaster</a>, taste signal from{' '}
            <a href="https://www.last.fm/">last.fm</a>, artist identity from{' '}
            <a href="https://musicbrainz.org/">musicbrainz</a>, address lookup by{' '}
            <a href="https://nominatim.openstreetmap.org/">openstreetmap nominatim</a>.
          </p>
        </footer>
      </body>
    </html>
  );
}
