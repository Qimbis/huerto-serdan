# Huerto Serdán — panel del huerto

Static dashboard for a family apple orchard (Ciudad Serdán, Puebla).
No build step — plain HTML/JS served as-is via GitHub Pages.

Data lives in a Supabase project protected by row-level security;
the anon key in `config.js` is public by design and grants nothing
without an authenticated session. Sign-ups are disabled.
