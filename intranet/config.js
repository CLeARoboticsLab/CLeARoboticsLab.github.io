// ------------------------------------------------------------
// Fill these in from: Supabase dashboard > Project Settings > API
// The anon/public key is *meant* to be visible in client-side code —
// it's safe because every table is protected by Row Level Security
// policies (see schema.sql). Do not paste the "service_role" key here.
// ------------------------------------------------------------
const SUPABASE_URL = 'https://jgjhqwkgjmvwmjttjasc.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_bkJ0_XKiFqbWNUyalBDcBQ_epNW5TsU';

// Newer Supabase CDN builds name the global after your project key instead
// of the fixed name 'supabase' — this finds whichever one is present.
const _sb = window.supabase
      || window[Object.keys(window).find(k => k.startsWith('sb_publishable'))];

if (!_sb) throw new Error('Supabase client library did not load — check the script tag in your HTML files.');

const supabaseClient = _sb.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
//const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
