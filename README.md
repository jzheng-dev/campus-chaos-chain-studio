# Chain Studio

A separate prompt-chain workspace for Campus Chaos. Built for Jessica's Week 8 Design for Generative AI assignment using the existing Supabase schema supplied in the database CSV.

**Start with `START_HERE.md`.** That guide walks through the database setup, new GitHub repository, new Vercel project, Google login redirects, and submission checks. Every source file in this folder is a complete final file. No starter-file replacement workflow is needed.

## Features

- Google OAuth with existing Supabase Auth; server pages, API routes, and database functions verify `profiles.is_superadmin = true`.
- Create, edit, and delete chains; add, edit, delete, duplicate, and reorder steps with drag handles or keyboard-accessible arrow buttons.
- Save all chain edits in one database transaction; version checks prevent overwriting changes saved in another tab.
- Run the saved chain sequentially with original text, previous-step text, earlier-step references, and an optional image.
- Text output at any step, or image generation on the last step.
- Per-chain history with the exact prompt snapshot, intermediate outputs, model names, timings, errors, and final results.
- Private image storage, temporary signed links, copy/download results, and three ready-to-edit starter chains.
- Light, dark, and system themes; local preference persistence; responsive layouts and reduced-motion support.

## Local commands

Node.js 22.18+ is required. Node.js 24 is recommended for matching the tested environment.

```bash
npm ci
cp .env.example .env.local
# Fill in .env.local with your existing project credentials.
npm run dev
```

Visit http://localhost:3000. Add `http://localhost:3000/auth/callback` to Supabase's allowed Redirect URLs first. See START_HERE.md for the hosted setup.

```bash
npm test
npm run typecheck
npm run build
```

The tests use an isolated, embedded PostgreSQL database. They do not connect to your Supabase project or spend Gemini quota. PGlite supplies the SQL engine; the tests simulate the relevant Supabase Auth/Storage schemas.

## Architecture

`app/page.tsx` is the entrance and access-denied screen. `app/studio/page.tsx` protects the workspace on the server. `components/Studio.tsx` renders the editor and results UI. `app/api/chains` handles chain persistence, and `app/api/runs` executes the AI workflow. `supabase/setup.sql` adds columns, run history, an admin-only private image bucket, and narrow database functions without replacing existing table policies.

No Supabase service-role key is required. API routes use the signed-in user's session. The database functions verify that user's admin status again before operating on the shared tables. Existing `profiles` permissions must already prevent ordinary users from granting themselves superadmin access.

## Execution behavior and limits

- Save first. Test runs execute the saved version, not unsaved editor content.
- `{{input}}` means original text; `{{previous}}` means the preceding output (original input on the first step); `{{step_1}}` means the text from the first step. References are 1-based and must point backward.
- The original uploaded image accompanies every step. Image inputs are not retained in run history. Generated images are stored privately.
- At most 12 steps, 10,000 input characters, 20,000 prompt characters per step, and a 2 MB PNG/JPEG/WebP input image.
- Each AI call has a 90-second limit and the whole sequence has an approximately four-minute application budget. The Vercel route requests a 300-second maximum. If your Vercel plan/runtime has a lower limit, reduce the chain size or adjust your hosting plan/settings.
- No automatic retries are made, to avoid duplicate paid AI calls. Failed runs preserve intermediate results when error handling can finish.
- Closing the tab or a hard platform timeout may interrupt a run before its status is saved. History flags old running records as interrupted. This implementation does not have background execution or resumable runs.
- History shows the most recent 50 runs for the selected chain. Deleting a chain removes its steps and mix entries. Its run records and generated files remain in the database/storage, but deleted-chain history is not browsable in this UI.
- Existing media from before this tool cannot be attributed retroactively because the exported schema has no chain relationship on old generation requests. History starts with runs made through Chain Studio.
- Shared admin observability is populated in `generation_requests`, `llm_responses`, and `ai_generated_media`. Text media is stored in `description`; generated image URLs use `supabase://chain-studio/...` private storage references rather than public URLs. This app resolves them through signed URLs. The older admin viewer may display that reference as text.
- Gemini access/quota and image-model billing depend on your Google AI Studio project. Models are configured on the server through `GEMINI_MODEL` and `GEMINI_IMAGE_MODEL`.

## Verification completed in the supplied package

- Production build and TypeScript checks.
- Automated PostgreSQL checks: admin-only database function access, repeatable setup, ordering with unique step positions, stale-edit rejection, retained step IDs, immutable run snapshots, shared result writes, and chain deletion with retained run records.
- Automated prompt-variable validation, forward-reference rejection, duplicate-step rejection, and output placement validation.
- Browser review of the editor, arrow reordering, save state, history/results panels, and light/dark themes using disposable local fixtures. Those fixtures are removed from the delivered app.

Live Google sign-in, your actual Supabase constraints/policies, and paid Gemini calls still require checking with your credentials after setup. Previous-week feedback was not supplied, so that rubric category is not claimed as complete.

## Official references

- [Next.js route handlers](https://nextjs.org/docs/app/api-reference/file-conventions/route)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Gemini text generation](https://ai.google.dev/gemini-api/docs/text-generation)
- [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation)
- [Vercel deployment protection](https://vercel.com/docs/deployment-protection)
- [Vercel generated deployment URLs](https://vercel.com/docs/deployments/generated-urls)
