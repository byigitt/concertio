import { QueueForm } from '@/app/jobs/queue-form';
import { recentJobs, type Job } from '@/lib/jobs';
import { listMetros } from '@/lib/queries';

export const dynamic = 'force-dynamic';

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function progressOf(job: Job): string {
  const c = job.status === 'done' ? (job.result ?? job.cursor) : job.cursor;
  const done = c.processed ?? 0;
  const total = c.scored ?? 0;
  if (job.status === 'done') {
    return `${c.linked ?? 0} artists, ${c.eventsInserted ?? 0} new events, ${c.matches ?? 0} matches`;
  }
  if (total === 0) return job.status === 'queued' ? 'waiting' : 'starting';
  return `${done}/${total} artists`;
}

/**
 * Bu sayfa PUBLIC. Ham hata metni URL/anahtar/govde parcasi tasiyabilir
 * (`http.ts` URL'i maskeliyor ama govde snippet'i ucuncu tarafin metni).
 * O yuzden burada yalnizca kaba bir sinif gosteriliyor; ayrintiyi operator
 * DB'den okur.
 */
function publicError(raw: string): string {
  if (/HTTP 4\d\d/.test(raw)) return 'source rejected request';
  if (/HTTP 5\d\d|cooldown/.test(raw)) return 'source unavailable, will retry';
  if (/timeout|aborted/i.test(raw)) return 'source timed out';
  if (/schema error/.test(raw)) return 'unexpected source response';
  if (/is not set/.test(raw)) return 'server missing api key';
  return 'run failed';
}

export default async function JobsPage() {
  const [jobs, metros] = await Promise.all([recentJobs(20), listMetros()]);
  const busy = jobs.some((j) => j.status === 'queued' || j.status === 'running');

  return (
    <>
      {/* Is calisirken sayfa kendini yeniler. JS yok, tarayici isi yapar. */}
      {busy ? <meta httpEquiv="refresh" content="10" /> : null}

      <h1>queue</h1>

      <p>one worker, one job. musicbrainz: 1 req/sec. long job splits, resumes.</p>

      <h2>queue a refresh</h2>
      <QueueForm metros={metros} />

      <h2>jobs</h2>

      {jobs.length === 0 ? (
        <p>queue empty.</p>
      ) : (
        <div className="scroll-x">
          <table>
            <caption>active first, then newest. {busy ? 'page reloads every 10 s.' : null}</caption>
            <thead>
              <tr>
                <th scope="col">user</th>
                <th scope="col">area</th>
                <th scope="col">state</th>
                <th scope="col">progress</th>
                <th scope="col">asked</th>
                <th scope="col">list</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} id={job.id}>
                  <td>{job.lastfmUser}</td>
                  <td>{job.metroName}</td>
                  <td>
                    {job.status}
                    {job.attempts > 1 ? ` (try ${job.attempts})` : ''}
                    {job.lastError ? (
                      <>
                        <br />
                        {publicError(job.lastError)}
                      </>
                    ) : null}
                  </td>
                  <td>{progressOf(job)}</td>
                  <td>
                    <time dateTime={job.requestedAt.toISOString()}>
                      {timeFmt.format(job.requestedAt)}
                    </time>
                  </td>
                  <td>
                    <a href={`/me?u=${encodeURIComponent(job.lastfmUser)}&metro=${job.metroSlug}`}>
                      open
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
