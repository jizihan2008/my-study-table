// Standalone runtime for Supabase-compatible hosts without Edge Functions.
// Place behind an HTTPS reverse proxy. Never deploy this process into the frontend.
import http from 'node:http';
import { createFeedHandler } from '../supabase/functions/calendar-feed/feed.mjs';

const handler = createFeedHandler({ url: process.env.SUPABASE_URL, serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY });
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the server.');
}
http.createServer(async (req, res) => {
  try {
    const parsed = new URL(req.url, 'http://localhost');
    if (parsed.pathname !== '/calendar-feed' && parsed.pathname !== '/functions/v1/calendar-feed') {
      res.writeHead(404); res.end(); return;
    }
    const response = await handler(new Request(parsed, { method: req.method }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(503, { 'Cache-Control': 'no-store' }); res.end('Calendar temporarily unavailable');
  }
}).listen(Number(process.env.MST_CALENDAR_PORT || 8787), process.env.MST_CALENDAR_HOST || '127.0.0.1', () => {
  console.log('MST calendar service started (request URLs and tokens are not logged).');
});
