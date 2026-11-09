import { createFeedHandler } from './feed.mjs';

Deno.serve(createFeedHandler({
  url: Deno.env.get('SUPABASE_LOCAL_URL') || Deno.env.get('SUPABASE_URL'),
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
}));
