# Chain Studio — complete source code

Each heading is the exact path inside the new project. The ZIP already contains these files, so manual copying is optional. `package-lock.json` is included separately in the ZIP to pin the tested dependencies. For manual reconstruction, create these files and run `npm install`, then follow START_HERE.md.

## `app/api/chains/route.ts`

```ts
import { requireAdmin, apiError, dbError, HttpError } from "@/lib/auth";
import { validateChain, validId } from "@/lib/validation";
import type { Chain, Run } from "@/lib/types";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const id = new URL(request.url).searchParams.get("chain");
    if (id && !validId(id)) throw new HttpError("Invalid chain ID");
    const { data, error } = await supabase.rpc("chain_studio_list", {
      p_chain_id: id || null,
    });
    if (error) throw dbError(error);
    data.chains = (data.chains || []).map((c: Chain) => ({
      ...c,
      description: c.description || "",
    }));
    for (const run of (data.runs || []) as Run[])
      for (const o of run.outputs) {
        if (o.path) {
          const { data: signed } = await supabase.storage
            .from("chain-studio")
            .createSignedUrl(o.path, 3600);
          o.url = signed?.signedUrl;
        }
      }
    return Response.json(data, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    return apiError(e);
  }
}
export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin(request);
    const body = await request.json();
    try {
      validateChain(body);
    } catch (e) {
      throw new HttpError((e as Error).message);
    }
    const { data, error } = await supabase.rpc("chain_studio_save", {
      p_chain: body,
    });
    if (error) throw dbError(error);
    return Response.json(data);
  } catch (e) {
    return apiError(e);
  }
}
export async function DELETE(request: Request) {
  try {
    const { supabase } = await requireAdmin(request);
    const body = await request.json();
    if (!validId(body.id) || !Number.isInteger(body.studio_version))
      throw new HttpError("Invalid chain");
    const { error } = await supabase.rpc("chain_studio_delete", {
      p_chain_id: body.id,
      p_version: body.studio_version,
    });
    if (error) throw dbError(error);
    return Response.json({ ok: true });
  } catch (e) {
    return apiError(e);
  }
}
```

## `app/api/runs/route.ts`

```ts
import { GoogleGenAI } from "@google/genai";
import { requireAdmin, apiError, HttpError, dbError } from "@/lib/auth";
import { validId, resolvePrompt, validateChain } from "@/lib/validation";
import type { Output, Run } from "@/lib/types";
export const runtime = "nodejs";
export const maxDuration = 300;
function fileMime(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  return null;
}
export async function POST(request: Request) {
  let active: Awaited<ReturnType<typeof requireAdmin>> | undefined;
  let run: Run | undefined;
  const outputs: Output[] = [];
  const started = Date.now();
  try {
    active = await requireAdmin(request);
    if (!process.env.GEMINI_API_KEY)
      throw new HttpError(
        "Add GEMINI_API_KEY to this app’s environment variables and redeploy.",
        503,
      );
    if (Number(request.headers.get("content-length") || 0) > 2500000)
      throw new HttpError("Upload an image smaller than 2 MB.", 413);
    const form = await request.formData();
    const chainId = form.get("chain_id");
    const version = Number(form.get("version"));
    const input = form.get("input");
    const image = form.get("image");
    if (
      !validId(chainId) ||
      !Number.isInteger(version) ||
      version < 1 ||
      typeof input !== "string" ||
      input.length > 10000
    )
      throw new HttpError("Invalid input. Use up to 10,000 characters.");
    let imagePart:
      { type: "image"; data: string; mime_type: string } | undefined;
    if (image instanceof File && image.size) {
      if (image.size > 2 * 1024 * 1024)
        throw new HttpError("Upload an image smaller than 2 MB.");
      const bytes = Buffer.from(await image.arrayBuffer());
      const mime = fileMime(bytes);
      if (!mime)
        throw new HttpError("Choose a valid PNG, JPEG, or WebP image.");
      imagePart = {
        type: "image",
        mime_type: mime,
        data: bytes.toString("base64"),
      };
    }
    if (!input.trim() && !imagePart)
      throw new HttpError("Add some text or an image to get started.");
    const { data, error } = await active.supabase.rpc(
      "chain_studio_start_run",
      {
        p_id: crypto.randomUUID(),
        p_chain_id: chainId,
        p_version: version,
        p_input: input.trim(),
        p_had_image: !!imagePart,
      },
    );
    if (error) throw dbError(error);
    run = data as Run;
    validateChain({
      id: chainId,
      name: run.chain_name,
      description: "",
      studio_version: run.chain_version,
      steps: run.steps_snapshot,
    });
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    for (const [i, step] of run.steps_snapshot.entries()) {
      const remaining = 240000 - (Date.now() - started);
      if (remaining < 5000)
        throw new HttpError(
          "This run reached the time limit. Try fewer steps or shorter prompts.",
          504,
        );
      const prompt = resolvePrompt(
        step.prompt_template,
        run.input_text,
        outputs,
      );
      const model =
        step.output_type === "image"
          ? process.env.GEMINI_IMAGE_MODEL || "gemini-nano-banana-2.1"
          : process.env.GEMINI_MODEL || "gemini-3.8-flash";
      const before = Date.now();
      const result = await ai.interactions.create(
        {
          model,
          input: imagePart
            ? [{ type: "text", text: prompt }, imagePart]
            : prompt,
          store: false,
          generation_config: { max_output_tokens: 4096 },
        },
        { signal: AbortSignal.timeout(Math.min(remaining, 90000)) },
      );
      if (result.status !== "completed")
        throw new HttpError(
          `Step ${i + 1} did not finish (${result.status || "no response"}). Try a simpler prompt.`,
          502,
        );
      const output: Output = {
        step_id: step.id,
        title: step.title || `Step ${i + 1}`,
        type: step.output_type,
        text: result.output_text || "",
        model,
        duration_ms: Date.now() - before,
      };
      if (step.output_type === "image") {
        const generated = result.output_image;
        if (!generated?.data)
          throw new HttpError(
            `Step ${i + 1} did not return an image. Try a more direct image prompt.`,
            502,
          );
        const mime = generated.mime_type || "image/png";
        if (!["image/png", "image/jpeg", "image/webp"].includes(mime))
          throw new HttpError(
            "The model returned an unsupported image format.",
            502,
          );
        const bytes = Buffer.from(generated.data, "base64");
        if (bytes.length > 10 * 1024 * 1024)
          throw new HttpError("The generated image is larger than 10 MB.", 502);
        const path = `${active.user.id}/${run.id}/${step.id}.${mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"}`;
        const { error: uploadError } = await active.supabase.storage
          .from("chain-studio")
          .upload(path, bytes, { contentType: mime, upsert: false });
        if (uploadError)
          throw new HttpError(
            "Could not save the generated image: " + uploadError.message,
            500,
          );
        output.path = path;
      } else if (!output.text.trim())
        throw new HttpError(
          `Step ${i + 1} returned no text. The provider may have blocked the request. Try a different prompt.`,
          502,
        );
      outputs.push(output);
    }
    const { error: finishError } = await active.supabase.rpc(
      "chain_studio_finish_run",
      { p_id: run.id, p_outputs: outputs, p_error: null },
    );
    if (finishError)
      throw new HttpError(
        "The AI finished, but saving the result failed: " + finishError.message,
        500,
      );
    return Response.json({ id: run.id });
  } catch (error) {
    let failure: HttpError;
    if (error instanceof HttpError) failure = error;
    else if (
      error instanceof Error &&
      ["TimeoutError", "AbortError", "RequestTimeoutError"].includes(error.name)
    )
      failure = new HttpError(
        "The AI request timed out. Try a shorter prompt or fewer steps.",
        504,
      );
    else {
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? String(error.status)
          : "";
      failure = new HttpError(
        status === "429"
          ? "Gemini quota reached. Check your Google AI Studio billing and limits, then try again."
          : status === "404"
            ? "The Gemini model is unavailable. Check GEMINI_MODEL or GEMINI_IMAGE_MODEL in Vercel."
            : "The AI request failed. Check your Gemini key and model access, then try again.",
        502,
      );
    }
    if (run && active) {
      const { error: saveError } = await active.supabase.rpc(
        "chain_studio_finish_run",
        { p_id: run.id, p_outputs: outputs, p_error: failure.message },
      );
      if (saveError)
        failure = new HttpError(
          failure.message +
            " The run status could not be saved; refresh history before trying again.",
          500,
        );
    }
    return apiError(failure);
  }
}
```

## `app/auth/callback/route.ts`

```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL("/studio", url.origin));
  }
  return NextResponse.redirect(new URL("/?error=login", url.origin));
}
```

## `app/auth/signout/route.ts`

```ts
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  if (request.headers.get("origin") !== origin)
    return Response.json({ error: "Forbidden" }, { status: 403 });
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error)
    return Response.json(
      { error: "Could not sign out. Try again." },
      { status: 500 },
    );
  return NextResponse.redirect(new URL("/", origin), 303);
}
```

## `app/error.tsx`

```tsx
"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <h1>Let’s reconnect.</h1>
      <p>
        Something interrupted the workspace. Check your connection and try
        again.
      </p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
      <a href="/">Back to sign in</a>
    </main>
  );
}
```

## `app/globals.css`

```css
@import url("https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;450;500;550;600;650;700&family=Manrope:wght@400;500;600;650;700;750;800&display=swap");
:root {
  --bg: #f8f8fa;
  --panel: #fff;
  --panel-alt: #f8f8fc;
  --text: #242332;
  --muted: #878594;
  --line: #e9e8ef;
  --accent: #7760ce;
  --accent-hover: #634abd;
  --accent-soft: #f0ecfc;
  --field: #faf9fc;
  --shadow: 0 3px 18px #29213e04;
  --success: #34866c;
  --danger: #bb4b5f;
  --sidebar: #201d32;
  --sidebar-muted: #a09aac;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --bg: #181720;
  --panel: #211f2b;
  --panel-alt: #252330;
  --text: #f0edf7;
  --muted: #a39dad;
  --line: #35313f;
  --accent: #b29aed;
  --accent-hover: #c3aaff;
  --accent-soft: #342b4a;
  --field: #1c1a25;
  --shadow: 0 3px 18px #00000015;
  --success: #8ed4b9;
  --danger: #f394a5;
  --sidebar: #13111d;
  --sidebar-muted: #aba2bd;
  color-scheme: dark;
}
* {
  box-sizing: border-box;
}
html,
body {
  margin: 0;
  min-height: 100%;
  background: var(--bg);
  color: var(--text);
  font-family:
    "DM Sans",
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}
button,
input,
textarea,
select {
  font: inherit;
}
button,
a,
input,
textarea,
select {
  -webkit-tap-highlight-color: transparent;
}
button {
  cursor: pointer;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
a {
  color: inherit;
  text-decoration: none;
}
button:focus-visible,
a:focus-visible,
summary:focus-visible {
  outline: 3px solid var(--accent);
  outline-offset: 3px;
}
input:focus,
textarea:focus,
select:focus {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
input,
textarea,
select {
  color: var(--text);
}
textarea {
  resize: vertical;
  line-height: 1.65;
}
button {
  transition:
    background 0.18s,
    border-color 0.18s,
    transform 0.18s;
}
h1,
h2,
h3,
p {
  margin: 0;
}
svg {
  flex-shrink: 0;
}
em {
  font-family: Georgia, "Times New Roman", serif;
  font-weight: 400;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.button {
  border: 1px solid transparent;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 11px 16px;
  font-size: 13px;
  font-weight: 650;
  white-space: nowrap;
  min-height: 41px;
}
.primary {
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 5px #64509b13;
}
.primary:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: translateY(-1px);
}
[data-theme="dark"] .primary {
  color: #20172f;
}
.secondary {
  background: var(--panel);
  border-color: var(--line);
}
.icon-button {
  padding: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  min-width: 27px;
  min-height: 27px;
}
.icon-button:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.icon-button.danger:hover:not(:disabled) {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}
.spin {
  animation: spin 1.2s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.live-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #70b79b;
}
.eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.7px;
  color: var(--accent);
}
.small-muted {
  color: var(--muted);
  font-size: 11px;
}
.error-text {
  color: var(--danger);
  font-size: 13px;
  line-height: 1.6;
  margin-top: 12px;
}
.panel {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow);
}
/* The workspace */
.studio-shell {
  display: grid;
  grid-template-columns: 232px minmax(0, 1fr);
  min-height: 100vh;
}
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  background: var(--sidebar);
  color: #f6f3ff;
  padding: 31px 18px 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-left: 7px;
  margin-bottom: 42px;
  font-family: "Manrope", sans-serif;
  font-weight: 750;
  font-size: 20px;
  letter-spacing: -0.8px;
}
.brand-icon {
  display: inline-flex;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  align-items: center;
  justify-content: center;
  background: #a58ade;
  color: #fff;
  box-shadow: inset 0 0 0 1px #ffffff25;
}
.brand-soft {
  font-weight: 400;
  color: #cec7e0;
}
.brand small {
  display: block;
  font:
    7px "DM Sans",
    sans-serif;
  letter-spacing: 1.8px;
  color: #9990ad;
  margin-top: 6px;
}
.sidebar-heading,
.library-heading {
  font-size: 9px;
  letter-spacing: 1.5px;
  color: var(--sidebar-muted);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 11px;
}
.tiny-pill {
  border: 1px solid #ffffff14;
  padding: 3px 5px;
  border-radius: 4px;
  font-size: 9px;
  letter-spacing: 0;
}
.sidebar-active {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 13px 11px;
  font-size: 12px;
  background: #ffffff0c;
  border-radius: 7px;
  margin: 10px 0 33px;
}
.sidebar-active svg:last-child {
  margin-left: auto;
  color: #9d93b2;
}
.library-heading {
  margin-bottom: 16px;
}
.library-heading span:last-child {
  font-size: 10px;
  letter-spacing: 0;
}
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border: 1px solid #ffffff12;
  border-radius: 7px;
  color: #837b95;
  margin: 0 2px 15px;
}
.search-box input {
  background: none;
  border: 0;
  width: 100%;
  color: #f4f1fc;
  font-size: 11px;
  min-width: 0;
}
.search-box input::placeholder {
  color: #9d94ad;
}
.search-box input:focus {
  outline: none;
}
.search-box:focus-within {
  outline: 1px solid #b29aed;
}
.chain-nav {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: 40vh;
  overflow-y: auto;
}
.chain-link {
  border: 0;
  background: transparent;
  color: #c5bed5;
  display: flex;
  align-items: center;
  text-align: left;
  gap: 9px;
  border-radius: 8px;
  padding: 11px 9px;
  min-width: 0;
  width: 100%;
  font-size: 12px;
}
.chain-link > span:nth-child(2) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chain-link small {
  display: block;
  font-size: 10px;
  color: #958ba7;
  margin-top: 5px;
}
.chain-link:hover:not(:disabled) {
  background: #ffffff08;
}
.chain-link.selected {
  background: #9880d41c;
  color: #e0d4fc;
  box-shadow: inset 0 0 0 1px #ac8be027;
}
.chain-glyph {
  width: 29px;
  height: 29px;
  border: 1px solid #ffffff15;
  border-radius: 7px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
}
.selected .chain-glyph {
  background: #9f7ed325;
  color: #bda1ec;
  border-color: #bda1ec20;
}
.selected-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #bfa6ea;
  margin-left: auto;
  flex-shrink: 0;
}
.sidebar-empty {
  font-size: 12px;
  color: var(--sidebar-muted);
  padding: 16px 12px;
  line-height: 1.7;
}
.sidebar-new {
  background: transparent;
  border: 1px dashed #ffffff22;
  border-radius: 7px;
  padding: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
  color: #bcb1d0;
  font-size: 11px;
  margin: 14px 3px 20px;
}
.sidebar-new:hover:not(:disabled) {
  background: #ffffff06;
}
.sidebar-bottom {
  margin-top: auto;
}
.sidebar-note {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 22px 10px;
}
.small-spark {
  font-size: 31px;
  font-weight: 400;
  color: #aa91d5;
}
.sidebar-note p {
  font-size: 12px;
  line-height: 1.8;
  color: #a398b5;
}
.sidebar-note strong {
  font-weight: 450;
  color: #b7acc8;
}
.account-row {
  border-top: 1px solid #ffffff10;
  padding: 22px 6px;
  display: flex;
  align-items: center;
  gap: 9px;
}
.avatar {
  width: 31px;
  height: 31px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: #b8a3d534;
  color: #dbc7f4;
  font:
    12px Georgia,
    serif;
}
.account-row strong {
  font-size: 11px;
  font-weight: 500;
  display: block;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.account-row small {
  display: block;
  font-size: 9px;
  color: var(--sidebar-muted);
  margin-top: 5px;
}
.account-row form {
  margin-left: auto;
}
.account-row .icon-button {
  color: #a196b0;
}
.workspace {
  min-width: 0;
}
.topbar {
  height: 72px;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 37px;
}
.breadcrumb {
  display: flex;
  align-items: center;
  gap: 11px;
  font-size: 11px;
  color: var(--muted);
}
.breadcrumb strong {
  font-weight: 500;
  color: var(--text);
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 21px;
}
.access-pill {
  font-size: 9px;
  letter-spacing: 1px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 6px;
}
.theme-picker {
  display: flex;
  align-items: center;
  gap: 3px;
  background: var(--bg);
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 7px;
}
.theme-picker button {
  display: grid;
  place-items: center;
  width: 27px;
  height: 25px;
  border: 0;
  background: transparent;
  border-radius: 4px;
  color: var(--muted);
}
.theme-picker button.active {
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 1px 4px #22193812;
}
.main-content {
  max-width: 1450px;
  margin: auto;
  padding: 39px 37px 0;
}
.page-intro {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 29px;
}
.page-intro .eyebrow > span {
  height: 1px;
  width: 19px;
  background: var(--accent);
}
.page-intro h1 {
  font-family: "Manrope", sans-serif;
  font-size: clamp(23px, 2.2vw, 32px);
  line-height: 1.4;
  letter-spacing: -1.1px;
  font-weight: 650;
  margin: 9px 0;
}
.page-intro h1 em {
  color: var(--accent);
  font-size: 1.06em;
}
.page-intro p {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 15px;
  margin-bottom: 32px;
}
.stat-card {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  box-shadow: var(--shadow);
}
.stat-card > div > span {
  font-size: 10px;
  color: var(--muted);
}
.stat-card strong {
  display: block;
  margin-top: 8px;
  font-family: "Manrope", sans-serif;
  font-size: 24px;
  font-weight: 500;
  letter-spacing: -1px;
}
.stat-icon {
  width: 39px;
  height: 39px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: var(--accent-soft);
  color: var(--accent);
}
.stat-card:nth-child(2) .stat-icon {
  background: color-mix(in srgb, #b9c3b0 18%, var(--panel));
  color: #8d9b80;
}
.stat-card:nth-child(3) .stat-icon {
  background: color-mix(in srgb, #d9b68b 16%, var(--panel));
  color: #b5946c;
}
.editor-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.28fr) minmax(0, 1fr);
  gap: 25px;
  align-items: start;
}
.editor-column,
.test-column {
  min-width: 0;
}
.section-label {
  height: 31px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 5px;
  font-size: 9px;
  letter-spacing: 1.25px;
  font-weight: 650;
}
.section-label > span:first-child {
  display: flex;
  align-items: center;
  gap: 7px;
  white-space: nowrap;
}
.label-number {
  font-size: 9px;
  color: var(--accent);
  background: var(--accent-soft);
  width: 19px;
  height: 17px;
  border-radius: 4px;
  display: grid;
  place-items: center;
  letter-spacing: 0;
}
.section-label .small-muted {
  font-size: 9px;
  letter-spacing: 1px;
  padding-top: 4px;
}
.editor-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.section-label .editor-actions {
  margin-top: -5px;
}
.save-status {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 9px;
  color: var(--muted);
  letter-spacing: 0;
  font-weight: 400;
}
.save-status > span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--success);
}
.save-status.unsaved > span {
  background: #ce9b49;
}
.chain-details {
  padding: 17px 20px 13px;
  margin-bottom: 18px;
}
.details-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  gap: 10px;
}
.tag {
  font-size: 9px;
  font-weight: 650;
  letter-spacing: 1.2px;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 5px 7px;
  border-radius: 4px;
}
.chain-name {
  width: 100%;
  font-family: "Manrope", sans-serif;
  font-size: 21px;
  letter-spacing: -0.6px;
  font-weight: 650;
  padding: 5px 0;
  border: 0;
  background: transparent;
  border-radius: 3px;
}
.chain-description {
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
  margin-top: 4px;
  padding: 3px 0;
  min-height: 42px;
}
.details-meta {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  font-size: 10px;
  border-top: 1px solid var(--line);
  margin-top: 7px;
  padding-top: 13px;
}
.template-menu {
  position: relative;
}
.template-menu > summary {
  list-style: none;
  font-size: 10px;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  padding: 5px;
}
.template-menu > div {
  position: absolute;
  right: 0;
  top: 30px;
  width: 215px;
  background: var(--panel);
  box-shadow: 0 6px 30px #20173320;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 6px;
  z-index: 3;
}
.template-menu button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  border: 0;
  background: none;
  color: var(--text);
  width: 100%;
  padding: 11px 8px;
  border-radius: 4px;
}
.template-menu button:hover {
  background: var(--accent-soft);
}
.step-connector {
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #b8afcd;
  position: relative;
}
.step-connector:before {
  content: "";
  position: absolute;
  height: 100%;
  width: 1px;
  background: var(--line);
}
.step-connector svg {
  z-index: 1;
  background: var(--bg);
}
.step-card {
  overflow: hidden;
}
.step-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 11px 11px 11px 9px;
  border-bottom: 1px solid var(--line);
  gap: 4px;
}
.step-identity {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.drag-handle {
  cursor: grab;
  min-width: 18px;
  padding: 2px;
  color: #c0bacb;
}
.drag-handle:active {
  cursor: grabbing;
}
.step-number {
  display: grid;
  place-items: center;
  width: 26px;
  height: 25px;
  flex-shrink: 0;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 700;
}
.step-identity input {
  background: transparent;
  border: 0;
  padding: 5px;
  min-width: 0;
  width: 100%;
  font-weight: 600;
  font-size: 12px;
  border-radius: 3px;
}
.step-actions {
  display: flex;
  gap: 0;
}
.step-actions .icon-button {
  padding: 5px;
  min-width: 24px;
  min-height: 26px;
}
.step-body {
  padding: 15px 18px;
}
.step-body > label,
.test-form > label {
  display: block;
  font-size: 9px;
  letter-spacing: 1.2px;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 8px;
}
.step-body > textarea,
.test-form > textarea {
  display: block;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 7px;
  padding: 12px;
  background: var(--field);
  font-size: 12px;
  line-height: 1.8;
  min-height: 113px;
}
.step-body > textarea::placeholder,
.test-form > textarea::placeholder {
  color: var(--muted);
  opacity: 0.8;
}
.step-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  margin-top: 11px;
  flex-wrap: wrap;
}
.variable-chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
}
.variable-chips button {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 4px;
  color: var(--accent);
  font-family: ui-monospace, SFMono-Regular, monospace;
  font-size: 9px;
  padding: 4px 5px;
}
.variable-chips button:hover:not(:disabled) {
  background: var(--accent-soft);
}
.output-select {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 10px;
}
.output-select select {
  font-size: 10px;
  max-width: 110px;
  background: var(--panel);
  border: 0;
  color: var(--muted);
  padding: 3px 0;
}
.add-step {
  width: 100%;
  margin: 17px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border: 1px dashed color-mix(in srgb, var(--accent) 36%, var(--line));
  border-radius: 9px;
  padding: 15px;
  background: color-mix(in srgb, var(--accent-soft) 35%, var(--panel));
  color: var(--accent);
  font-size: 11px;
  font-weight: 600;
}
.add-step > span {
  margin-left: auto;
  font-size: 9px;
  letter-spacing: 1.2px;
  color: var(--muted);
  font-weight: 400;
}
.add-step:hover:not(:disabled) {
  background: var(--accent-soft);
}
.variable-note {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  color: var(--muted);
  margin: 14px 2px 20px;
}
.variable-note svg {
  color: var(--accent);
  margin-top: 2px;
}
.variable-note p {
  font-size: 10px;
  line-height: 1.9;
}
.variable-note code {
  font-size: 9px;
  color: var(--accent);
}
.save-bar {
  position: sticky;
  bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: 0 4px 20px #2017330c;
  z-index: 2;
}
.save-bar > span {
  font-size: 10px;
  color: var(--muted);
}
.save-bar .button {
  padding: 9px 12px;
  min-height: 36px;
  font-size: 11px;
}
.key-hint {
  border: 1px solid #ffffff35;
  border-radius: 3px;
  padding: 2px 4px;
  color: #ffffffb5;
  font-size: 9px;
  margin-left: 5px;
}
.panel-tabs {
  display: flex;
  gap: 20px;
  padding: 0 21px;
  border-bottom: 1px solid var(--line);
}
.panel-tabs > button {
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 15px 0 13px;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
}
.panel-tabs > button.active {
  border-bottom-color: var(--accent);
  color: var(--accent);
}
.panel-tabs > button > span {
  font-size: 9px;
  background: var(--panel-alt);
  border-radius: 4px;
  padding: 2px 4px;
}
.test-intro {
  padding: 24px 23px 18px;
}
.test-intro h2 {
  font-family: "Manrope", sans-serif;
  font-size: 21px;
  font-weight: 500;
  letter-spacing: -0.6px;
  line-height: 1.5;
}
.test-intro h2 em {
  color: var(--accent);
  font-size: 23px;
}
.test-intro p {
  font-size: 11px;
  color: var(--muted);
  margin-top: 8px;
}
.test-form {
  padding: 0 22px 17px;
}
.test-form > textarea {
  min-height: 108px;
}
.upload-zone {
  margin-top: 12px;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 18px 13px;
  border: 1px dashed var(--line);
  border-radius: 7px;
  background: var(--panel-alt);
  color: var(--muted);
  text-align: left;
}
.upload-zone > svg:first-child {
  color: var(--accent);
  opacity: 0.7;
}
.upload-zone > span {
  font-size: 11px;
  color: var(--text);
}
.upload-zone small {
  display: block;
  font-size: 9px;
  color: var(--muted);
  margin-top: 5px;
  line-height: 1.5;
}
.upload-zone > svg:last-child {
  margin-left: auto;
}
.upload-zone:hover:not(:disabled) {
  border-color: var(--accent);
}
.upload-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  border: 1px solid var(--line);
  padding: 9px;
  border-radius: 7px;
  min-width: 0;
}
.upload-preview img {
  height: 42px;
  width: 48px;
  object-fit: cover;
  border-radius: 4px;
}
.upload-preview > div {
  min-width: 0;
}
.upload-preview strong {
  font-size: 10px;
  display: block;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.upload-preview small {
  display: block;
  font-size: 9px;
  color: var(--muted);
  margin-top: 5px;
}
.upload-preview button {
  margin-left: auto;
}
.run-button {
  width: 100%;
  margin-top: 17px;
  font-size: 12px;
  min-height: 43px;
}
.run-button svg:last-child {
  margin-left: auto;
}
.run-hint {
  text-align: center;
  font-size: 9px;
  color: var(--muted);
  margin-top: 9px;
  line-height: 1.6;
}
.result-placeholder {
  min-height: 244px;
  border: 1px dashed var(--line);
  border-radius: 12px;
  margin-top: 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  position: relative;
  overflow: hidden;
}
.result-star {
  font-family: Georgia, serif;
  font-size: 48px;
  line-height: 1;
  color: color-mix(in srgb, var(--accent) 43%, var(--panel));
  margin-bottom: 17px;
}
.result-placeholder h3 {
  font-family: Georgia, serif;
  font-style: italic;
  font-size: 20px;
  font-weight: 400;
  color: var(--muted);
}
.result-placeholder p {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.9;
  margin-top: 10px;
}
.dotted-line {
  width: 100px;
  height: 28px;
  border-bottom: 1px dashed var(--line);
  border-radius: 50%;
  position: absolute;
  bottom: 15px;
  right: 20px;
  transform: rotate(-15deg);
}
.result-card {
  margin-top: 18px;
  padding: 18px;
}
.result-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.result-heading > span:first-child {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 9px;
  letter-spacing: 1.1px;
  color: var(--accent);
  font-weight: 600;
}
.status-badge {
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--accent-soft);
  color: var(--accent);
}
.status-badge.completed {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 9%, transparent);
}
.status-badge.failed,
.status-badge.interrupted {
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 9%, transparent);
}
.result-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 9px;
  color: var(--muted);
  margin: 10px 0 17px;
  flex-wrap: wrap;
}
.final-output {
  padding: 15px;
  background: var(--accent-soft);
  border: 1px solid color-mix(in srgb, var(--accent) 15%, var(--line));
  border-radius: 8px;
  margin-bottom: 13px;
}
.final-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  gap: 8px;
}
.final-title > strong {
  font-size: 10px;
  color: var(--accent);
  font-weight: 600;
}
.output-text {
  font-size: 12px;
  line-height: 1.9;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.generated-image {
  display: block;
  width: 100%;
  height: auto;
  border-radius: 6px;
  margin-bottom: 10px;
}
.trace-heading {
  font-size: 9px;
  letter-spacing: 1.3px;
  color: var(--muted);
  margin: 17px 0 8px;
}
.output-trace {
  border-top: 1px solid var(--line);
  padding: 10px 0;
}
.output-trace > summary {
  display: flex;
  align-items: center;
  gap: 7px;
  cursor: pointer;
  list-style: none;
}
.trace-number {
  font-size: 9px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: 4px;
  padding: 4px 5px;
}
.output-trace strong {
  font-size: 10px;
  font-weight: 500;
  flex: 1;
}
.output-trace summary > span:nth-last-child(2) {
  font-size: 9px;
  color: var(--muted);
}
.output-trace summary > svg {
  color: var(--muted);
}
.output-trace[open] summary > svg {
  transform: rotate(90deg);
}
.output-trace > div {
  padding: 12px 5px 4px;
}
.model-label {
  font-size: 9px;
  color: var(--muted);
  margin-bottom: 7px;
  overflow-wrap: anywhere;
}
.run-input summary,
.snapshot-prompt summary {
  cursor: pointer;
  color: var(--muted);
  font-size: 10px;
  padding: 6px 0;
}
.run-input p,
.snapshot-prompt p {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  padding: 8px;
  background: var(--field);
  border-radius: 4px;
}
.snapshot-prompt {
  margin-top: 10px;
}
.inline-error {
  font-size: 11px;
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 6%, transparent);
  padding: 12px;
  line-height: 1.8;
  border-radius: 6px;
  margin-bottom: 13px;
}
.history-list {
  min-height: 310px;
  padding: 16px;
}
.history-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10px;
  color: var(--muted);
  margin-bottom: 8px;
}
.history-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 8px;
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text);
  text-align: left;
}
.history-item:hover,
.history-item.active {
  background: var(--accent-soft);
  border-color: var(--line);
}
.history-item > span:nth-child(2) {
  flex: 1;
  min-width: 0;
}
.history-item strong {
  font-size: 11px;
  font-weight: 500;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;
}
.history-item small {
  display: block;
  color: var(--muted);
  font-size: 9px;
  margin-top: 5px;
}
.history-item > svg {
  color: var(--muted);
}
.run-state {
  color: var(--accent);
  background: var(--panel-alt);
  height: 28px;
  width: 28px;
  border-radius: 7px;
  display: grid;
  place-items: center;
}
.run-state.completed {
  color: var(--success);
}
.run-state.failed,
.run-state.interrupted {
  color: var(--danger);
}
.mini-empty {
  padding: 45px 10px;
  display: flex;
  align-items: center;
  flex-direction: column;
  color: var(--muted);
}
.mini-empty p {
  margin: 12px 0 5px;
  font:
    italic 19px Georgia,
    serif;
}
.mini-empty small {
  font-size: 11px;
}
.running-card {
  margin-top: 18px;
  padding: 34px 20px;
  text-align: center;
  background: var(--accent-soft);
  border-radius: 12px;
  border: 1px solid var(--line);
}
.running-orbit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 55px;
  width: 55px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--accent);
  box-shadow: 0 0 0 9px color-mix(in srgb, var(--accent) 6%, transparent);
}
.running-orbit svg {
  animation: pulse 2s ease-in-out infinite;
}
.running-card h3 {
  font:
    italic 23px Georgia,
    serif;
  color: var(--accent);
  margin: 23px 0 10px;
}
.running-card p {
  font-size: 11px;
  line-height: 1.9;
  color: var(--muted);
}
.progress-track {
  height: 3px;
  background: var(--panel);
  border-radius: 4px;
  margin: 24px 30px 0;
  overflow: hidden;
}
.progress-track span {
  display: block;
  width: 35%;
  height: 100%;
  background: var(--accent);
  animation: progress 2s ease-in-out infinite;
}
@keyframes progress {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(400%);
  }
}
@keyframes pulse {
  50% {
    opacity: 0.4;
    transform: scale(0.9);
  }
}
.workspace-footer {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid var(--line);
  margin-top: 38px;
  padding: 18px 0 23px;
  font-size: 9px;
  letter-spacing: 1.2px;
  color: var(--muted);
}
.workspace-footer > span:first-child span {
  color: var(--accent);
  margin: 0 7px;
}
.workspace-footer > span:last-child {
  letter-spacing: 0;
  font-size: 9px;
}
.notice {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 15px;
  border-radius: 8px;
  font-size: 13px;
  line-height: 1.6;
  margin: 0 0 18px;
  overflow-wrap: anywhere;
}
.notice.error {
  background: color-mix(in srgb, var(--danger) 7%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--danger) 20%, var(--line));
  color: var(--danger);
}
.notice > span {
  flex: 1;
}
.toast {
  position: fixed;
  bottom: 25px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 13px 20px;
  background: var(--text);
  color: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  box-shadow: 0 8px 25px #0002;
  z-index: 20;
  font-size: 13px;
  max-width: 90vw;
}
.toast svg {
  color: #90c6aa;
}
.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  min-height: 300px;
  color: var(--muted);
  font-size: 13px;
}
.empty-workspace {
  text-align: center;
  padding: 35px 0 10px;
}
.empty-orbit {
  display: inline-grid;
  place-items: center;
  width: 76px;
  height: 76px;
  border-radius: 22px;
  background: var(--accent-soft);
  color: var(--accent);
  margin-bottom: 25px;
  transform: rotate(-7deg);
}
.empty-workspace > .eyebrow {
  justify-content: center;
}
.empty-workspace > h2 {
  font:
    34px Georgia,
    serif;
  letter-spacing: -0.8px;
  margin: 16px 0 12px;
}
.empty-workspace > p {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.8;
  margin-bottom: 22px;
}
.starter-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 15px;
  margin-top: 38px;
  text-align: left;
}
.starter-card {
  display: block;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 21px;
  color: var(--text);
  text-align: left;
}
.starter-card:hover:not(:disabled) {
  border-color: var(--accent);
  transform: translateY(-3px);
}
.starter-card > span {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--accent);
  font:
    italic 26px Georgia,
    serif;
  margin-bottom: 20px;
}
.starter-card h3 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
}
.starter-card p {
  font-size: 12px;
  line-height: 1.8;
  color: var(--muted);
  min-height: 60px;
}
.starter-card small {
  display: block;
  margin-top: 19px;
  font-size: 9px;
  letter-spacing: 1px;
  color: var(--accent);
}
/* The entrance */
.login-page {
  max-width: 1400px;
  margin: auto;
  min-height: 100vh;
  padding: 43px 7vw 20px;
  background: radial-gradient(
    ellipse at 75% 40%,
    var(--accent-soft),
    transparent 55%
  );
}
.login-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  letter-spacing: 2px;
  font-weight: 700;
}
.brand-by {
  border-left: 1px solid var(--line);
  padding-left: 15px;
  font-size: 11px;
  font-weight: 400;
  color: var(--muted);
  letter-spacing: 0;
}
.login-grid {
  display: grid;
  grid-template-columns: 1.12fr 1fr;
  gap: 65px;
  align-items: center;
  min-height: calc(100vh - 170px);
  padding: 75px 0;
}
.login-grid h1 {
  font-family: "Manrope", sans-serif;
  font-size: clamp(35px, 4.1vw, 60px);
  line-height: 1.23;
  font-weight: 550;
  letter-spacing: -2.6px;
  margin: 21px 0 26px;
}
.login-grid h1 em {
  color: var(--accent);
  letter-spacing: -2px;
}
.login-description {
  max-width: 410px;
  font-size: 14px;
  line-height: 1.9;
  color: var(--muted);
}
.login-access {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.7;
  margin: 32px 0 19px;
  max-width: 400px;
}
.login-access svg {
  color: var(--accent);
}
.login-button {
  min-width: 225px;
  justify-content: space-between;
}
.login-grid .notice {
  max-width: 420px;
}
.login-art {
  position: relative;
  padding: 26px 20px;
  isolation: isolate;
}
.mini-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--muted);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 1.5px;
  margin-bottom: 27px;
}
.mini-heading svg {
  color: var(--accent);
}
.sample-step {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 22px 20px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: 0 6px 25px #40315409;
  z-index: 1;
  position: relative;
}
.sample-step > span:first-child {
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  height: 36px;
  width: 36px;
  border-radius: 9px;
  font:
    italic 19px Georgia,
    serif;
}
.sample-step strong {
  font-size: 13px;
  font-weight: 600;
}
.sample-step p {
  font-size: 10px;
  color: var(--muted);
  margin-top: 7px;
}
.sample-dot {
  height: 6px;
  width: 6px;
  border-radius: 50%;
  background: #b7a1e0;
  margin-left: auto;
}
.sample-arrow {
  display: block;
  margin: 10px auto;
  color: #c2b7d8;
}
.sample-1 {
  transform: translateX(14px);
}
.sample-2 {
  transform: translateX(-6px);
}
.sample-1 > span:first-child {
  background: #eaf0e7;
  color: #7f9276;
}
.sample-2 > span:first-child {
  background: #f6eee3;
  color: #b39978;
}
.sample-result {
  font:
    italic 15px Georgia,
    serif;
  color: var(--accent);
  text-align: center;
  padding: 27px 5px 0;
}
.orb {
  position: absolute;
  border-radius: 50%;
  z-index: -1;
  filter: blur(3px);
}
.orb-one {
  width: 240px;
  height: 240px;
  border: 1px solid var(--line);
  top: 50%;
  left: 35%;
}
.orb-two {
  width: 320px;
  height: 320px;
  border: 1px dashed var(--line);
  top: 8%;
  left: 12%;
}
.login-footer {
  text-align: center;
  color: var(--muted);
  font-size: 9px;
  letter-spacing: 2px;
  border-top: 1px solid var(--line);
  padding: 22px 0 0;
}
.error-page {
  max-width: 500px;
  margin: 18vh auto;
  padding: 30px;
}
.error-page h1 {
  font:
    38px Georgia,
    serif;
  letter-spacing: -1px;
  margin-bottom: 15px;
}
.error-page p {
  color: var(--muted);
  line-height: 1.8;
  margin-bottom: 20px;
}
.error-page a {
  display: inline-block;
  margin-left: 16px;
  font-size: 13px;
}
@media (min-width: 1600px) {
  .main-content {
    padding-top: 47px;
  }
  .editor-grid {
    gap: 32px;
  }
  .page-intro {
    margin-bottom: 36px;
  }
  .step-body > textarea {
    font-size: 13px;
  }
  .step-identity input {
    font-size: 13px;
  }
  .output-text {
    font-size: 13px;
  }
  .test-intro h2 {
    font-size: 25px;
  }
}
@media (max-width: 1150px) {
  .studio-shell {
    grid-template-columns: 205px minmax(0, 1fr);
  }
  .sidebar {
    padding-left: 12px;
    padding-right: 12px;
  }
  .topbar {
    padding: 0 24px;
  }
  .main-content {
    padding: 30px 24px 0;
  }
  .editor-grid {
    gap: 18px;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  }
  .page-intro {
    align-items: flex-start;
  }
  .page-intro h1 em {
    display: block;
  }
  .page-intro h1 {
    font-size: 27px;
  }
  .step-header {
    flex-wrap: wrap;
  }
  .step-identity {
    flex: 1;
    min-width: 150px;
  }
  .step-actions {
    margin-left: auto;
  }
  .section-label .small-muted {
    display: none;
  }
  .add-step > span,
  .key-hint {
    display: none;
  }
  .save-bar > span {
    font-size: 9px;
  }
  .test-form {
    padding-left: 17px;
    padding-right: 17px;
  }
  .test-intro {
    padding-left: 18px;
    padding-right: 18px;
  }
  .test-intro h2 {
    font-size: 18px;
  }
  .test-intro h2 em {
    font-size: 20px;
  }
  .panel-tabs {
    padding: 0 17px;
  }
  .stat-card {
    padding: 16px;
  }
  .stat-card > div > span {
    font-size: 9px;
  }
  .stat-icon {
    width: 32px;
    height: 32px;
  }
  .save-status {
    font-size: 9px;
  }
}
@media (max-width: 920px) {
  .studio-shell {
    grid-template-columns: 190px minmax(0, 1fr);
  }
  .brand {
    font-size: 18px;
    gap: 8px;
    padding-left: 3px;
  }
  .brand-icon {
    width: 32px;
    height: 32px;
  }
  .brand small {
    font-size: 9px;
    letter-spacing: 1.2px;
  }
  .main-content {
    padding-left: 22px;
    padding-right: 22px;
  }
  .editor-grid {
    grid-template-columns: 1fr;
    gap: 28px;
  }
  .test-column {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    align-items: start;
  }
  .test-column > .section-label {
    grid-column: 1/-1;
    height: 20px;
  }
  .test-column > .result-placeholder,
  .test-column > .result-card,
  .test-column > .running-card {
    margin-top: 0;
  }
  .page-intro h1 {
    font-size: 25px;
  }
  .stats-grid {
    gap: 10px;
  }
  .stat-icon {
    display: none;
  }
  .stat-card > div > span {
    font-size: 9px;
  }
  .stat-card strong {
    font-size: 21px;
  }
  .new-top {
    font-size: 11px;
    padding: 10px 12px;
  }
  .login-grid {
    gap: 35px;
  }
  .login-page {
    padding-left: 6vw;
    padding-right: 6vw;
  }
  .login-grid h1 {
    font-size: 39px;
    letter-spacing: -1.6px;
  }
  .login-art {
    padding-left: 0;
    padding-right: 0;
  }
  .sample-step {
    padding: 17px 12px;
    gap: 10px;
  }
  .sample-step p {
    font-size: 9px;
  }
  .mini-heading {
    font-size: 9px;
  }
  .login-description {
    font-size: 13px;
  }
}
@media (max-width: 720px) {
  .studio-shell {
    display: block;
  }
  .sidebar {
    position: relative;
    height: auto;
    max-height: none;
    display: grid;
    grid-template-columns: 1fr auto;
    padding: 18px 20px 12px;
    overflow: visible;
  }
  .brand {
    margin: 0;
    font-size: 20px;
  }
  .brand small {
    font-size: 9px;
  }
  .sidebar-heading,
  .sidebar-active,
  .library-heading,
  .search-box,
  .sidebar-bottom,
  .sidebar-empty {
    display: none;
  }
  .chain-nav {
    grid-column: 1/-1;
    grid-row: 2;
    flex-direction: row;
    overflow: auto;
    max-height: none;
    gap: 7px;
    margin-top: 17px;
    padding-bottom: 4px;
  }
  .chain-link {
    width: auto;
    min-width: 145px;
    max-width: 210px;
    border: 1px solid #ffffff12;
    padding: 9px 11px;
    flex-shrink: 0;
  }
  .chain-link small {
    font-size: 9px;
  }
  .chain-glyph {
    display: none;
  }
  .sidebar-new {
    grid-column: 2;
    grid-row: 1;
    margin: 0;
    align-self: center;
    padding: 9px;
    font-size: 10px;
  }
  .topbar {
    height: 56px;
    padding: 0 22px;
  }
  .topbar-right {
    gap: 12px;
  }
  .access-pill {
    font-size: 9px;
  }
  .breadcrumb {
    font-size: 10px;
    gap: 7px;
  }
  .main-content {
    padding: 27px 20px 0;
  }
  .page-intro {
    gap: 10px;
    align-items: center;
  }
  .page-intro h1 {
    font-size: 25px;
  }
  .page-intro p {
    font-size: 11px;
  }
  .new-top {
    font-size: 0;
    gap: 0;
    width: 35px;
    min-height: 35px;
    padding: 8px;
  }
  .new-top svg {
    height: 17px;
    width: 17px;
  }
  .stats-grid {
    gap: 9px;
    margin-bottom: 26px;
  }
  .stat-card {
    padding: 14px 12px;
  }
  .stat-card > div > span {
    font-size: 9px;
  }
  .stat-card strong {
    font-size: 21px;
    margin-top: 7px;
  }
  .test-column {
    display: block;
  }
  .test-column > .section-label {
    margin-bottom: 10px;
  }
  .test-column > .result-placeholder,
  .test-column > .result-card,
  .test-column > .running-card {
    margin-top: 17px;
  }
  .test-intro h2 {
    font-size: 23px;
  }
  .test-intro h2 em {
    font-size: 25px;
  }
  .test-form {
    padding: 0 21px 20px;
  }
  .test-intro {
    padding: 23px 22px 17px;
  }
  .test-form > textarea {
    min-height: 120px;
  }
  .sidebar-note {
    display: none;
  }
  .save-status {
    font-size: 9px;
  }
  .chain-details {
    padding: 16px 18px;
  }
  .step-header {
    padding: 11px 9px;
  }
  .step-identity {
    min-width: 140px;
  }
  .step-actions {
    gap: 1px;
  }
  .step-body > textarea {
    font-size: 13px;
  }
  .step-identity input {
    font-size: 13px;
  }
  .variable-note p {
    font-size: 11px;
  }
  .variable-note code {
    font-size: 10px;
  }
  .section-label {
    font-size: 9px;
  }
  .save-bar {
    bottom: 8px;
  }
  .save-bar > span {
    font-size: 10px;
  }
  .workspace-footer {
    margin-top: 30px;
  }
  .workspace-footer > span:last-child {
    display: none;
  }
  .workspace-footer > span:first-child {
    font-size: 9px;
  }
  .login-page {
    padding: 28px 25px 20px;
  }
  .login-brand {
    font-size: 11px;
    letter-spacing: 1px;
  }
  .brand-by {
    font-size: 10px;
    padding-left: 10px;
  }
  .login-grid {
    grid-template-columns: 1fr;
    gap: 25px;
    padding: 65px 0 35px;
    min-height: 0;
  }
  .login-grid h1 {
    font-size: 43px;
  }
  .login-description {
    font-size: 13px;
  }
  .login-art {
    max-width: 430px;
    width: 100%;
    margin: auto;
    padding: 25px 10px;
  }
  .sample-step {
    padding: 21px 16px;
  }
  .sample-step p {
    font-size: 10px;
  }
  .mini-heading {
    font-size: 9px;
  }
  .login-footer {
    font-size: 9px;
    letter-spacing: 1.2px;
  }
  .starter-grid {
    grid-template-columns: 1fr;
    gap: 12px;
    margin-top: 28px;
  }
  .starter-card p {
    min-height: 0;
  }
  .starter-card > span {
    margin-bottom: 12px;
  }
  .starter-card small {
    margin-top: 12px;
  }
  .empty-workspace > h2 {
    font-size: 28px;
  }
  .empty-workspace > p {
    font-size: 12px;
  }
  .toast {
    bottom: 15px;
    font-size: 12px;
    white-space: normal;
    width: max-content;
  }
  .history-item strong {
    max-width: 240px;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *:before,
  *:after {
    animation: none !important;
    transition: none !important;
    scroll-behavior: auto !important;
  }
}

.mobile-signout {
  display: none;
}
@media (max-width: 720px) {
  .mobile-signout {
    display: block;
  }
}
```

## `app/layout.tsx`

```tsx
import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Chain Studio · Campus Chaos",
  description:
    "A creative workspace for building, testing, and refining AI prompt chains.",
};
const themeScript = `try{var t=localStorage.getItem('chain-studio-theme')||'system';document.documentElement.dataset.theme=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;}catch(e){}`;
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

## `app/not-found.tsx`

```tsx
export default function NotFound() {
  return (
    <main className="error-page">
      <h1>A step off the path.</h1>
      <p>This page doesn’t exist.</p>
      <a className="button primary" href="/studio">
        Open your studio
      </a>
    </main>
  );
}
```

## `app/page.tsx`

```tsx
import { redirect } from "next/navigation";
import { Workflow, LockKeyhole, ArrowDown, Sparkles } from "lucide-react";
import { configured, createClient } from "@/lib/supabase/server";
import LoginButton from "@/components/LoginButton";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ready = configured();
  const params = await searchParams;
  let signedIn = false;
  if (ready) {
    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (user) {
      signedIn = true;
      const { data: p } = await db
        .from("profiles")
        .select("is_superadmin")
        .eq("id", user.id)
        .single();
      if (p?.is_superadmin === true) redirect("/studio");
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <span className="brand-icon">
          <Workflow size={22} />
        </span>
        CHAIN STUDIO <span className="brand-by">by Campus Chaos</span>
      </div>
      <div className="login-grid">
        <section>
          <div className="eyebrow">
            <span className="live-dot" /> YOUR IDEAS, IN MOTION
          </div>
          <h1>
            A little structure.
            <br />
            <em>A lot of possibility.</em>
          </h1>
          <p className="login-description">
            Turn a spark into a sequence. Build AI workflows that see, think,
            and create—one thoughtful prompt at a time.
          </p>
          <div className="login-access">
            <LockKeyhole size={16} />
            <span>
              For the people behind Campus Chaos. Superadmin access required.
            </span>
          </div>
          {!ready ? (
            <p className="notice error">
              Setup needed: add the Supabase environment variables, then restart
              or redeploy.
            </p>
          ) : signedIn ? (
            <>
              <p className="notice error">
                You’re signed in, but your profile doesn’t have superadmin
                access. Ask the project owner to check your account.
              </p>
              <form action="/auth/signout" method="post">
                <button className="button secondary">Sign out</button>
              </form>
            </>
          ) : (
            <LoginButton />
          )}
          {params.error && (
            <p className="error-text" role="alert">
              Sign-in didn’t finish. Try again and check the Supabase redirect
              URL.
            </p>
          )}
        </section>
        <div className="login-art" aria-hidden="true">
          <div className="orb orb-one" />
          <div className="orb orb-two" />
          <div className="mini-heading">
            FROM IDEA TO SOMETHING GOOD <Sparkles size={16} />
          </div>
          {[
            ["01", "See the unexpected", "Describe what’s in the image."],
            ["02", "Find the funny", "Give the moment a new perspective."],
            ["03", "Make it yours", "Create five captions worth sharing."],
          ].map(([n, title, text], i) => (
            <div key={n}>
              <div className={`sample-step sample-${i}`}>
                <span>{n}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
                <span className="sample-dot" />
              </div>
              {i < 2 && <ArrowDown size={18} className="sample-arrow" />}
            </div>
          ))}
          <div className="sample-result">
            ✦ &nbsp; A good idea. A great chain reaction.
          </div>
        </div>
      </div>
      <footer className="login-footer">
        BUILT FOR EXPERIMENTATION. DESIGNED FOR POSSIBILITY.
      </footer>
    </main>
  );
}
```

## `app/studio/page.tsx`

```tsx
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { configured } from "@/lib/supabase/server";
import Studio from "@/components/Studio";
export const dynamic = "force-dynamic";
export default async function Page() {
  if (!configured()) redirect("/");
  let name = "Creator";
  try {
    const { profile, user } = await requireAdmin();
    name = profile.first_name || user.email?.split("@")[0] || name;
  } catch {
    redirect("/");
  }
  return <Studio name={name} />;
}
```

## `components/LoginButton.tsx`

```tsx
"use client";
import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
export default function LoginButton() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login() {
    setBusy(true);
    setError("");
    try {
      const { error } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${location.origin}/auth/callback` },
      });
      if (error) throw error;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="button primary login-button"
        disabled={busy}
        onClick={login}
      >
        {busy ? "Connecting…" : "Continue with Google"}
        <ArrowUpRight size={18} />
      </button>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </>
  );
}
```

## `components/Studio.tsx`

```tsx
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Workflow,
  Plus,
  Search,
  ChevronRight,
  ArrowUpRight,
  ArrowDown,
  ArrowUp,
  Trash2,
  Copy,
  Play,
  Save,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Sparkles,
  Layers,
  Clock3,
  ImagePlus,
  X,
  Check,
  LoaderCircle,
  RefreshCw,
  Download,
  FileText,
  Image as ImageIcon,
  GripVertical,
  ArrowLeft,
  AlertCircle,
} from "lucide-react";
import type { Chain, Step, Run, Output } from "@/lib/types";
import { newChain, newStep, starters } from "@/lib/starters";
import { validateChain } from "@/lib/validation";
type Theme = "light" | "dark" | "system";
async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = await response
    .json()
    .catch(() => ({ error: "The server did not respond. Try again." }));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const stamp = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function statusOf(run: Run) {
  return run.status === "running" &&
    Date.now() - new Date(run.created_at).getTime() > 300000
    ? "interrupted"
    : run.status;
}
export default function Studio({ name }: { name: string }) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [draft, setDraft] = useState<Chain | null>(null);
  const [baseline, setBaseline] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [tab, setTab] = useState<"test" | "history">("test");
  const [input, setInput] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const dragIndex = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const locked = !!busy;
  const setClean = useCallback((chain: Chain | null) => {
    setDraft(chain);
    setBaseline(chain ? JSON.stringify(chain) : "");
  }, []);
  const refresh = useCallback(
    async (id: string | null, choose: boolean) => {
      const seq = ++requestSequence.current;
      const data = await api("/api/chains" + (id ? `?chain=${id}` : ""));
      if (seq !== requestSequence.current) return;
      setChains(data.chains);
      setRuns(data.runs);
      if (choose) setClean(data.chains.find((c: Chain) => c.id === id) || null);
    },
    [setClean],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api("/api/chains");
        if (cancelled) return;
        setChains(data.chains);
        if (data.chains[0]) {
          setClean(data.chains[0]);
          await refresh(data.chains[0].id, false);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, setClean]);
  useEffect(() => {
    let saved: Theme = "system";
    try {
      const value = localStorage.getItem("chain-studio-theme");
      if (value === "light" || value === "dark" || value === "system")
        saved = value;
    } catch {}
    setTheme(saved);
    setThemeLoaded(true);
  }, []);
  useEffect(() => {
    if (!themeLoaded) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("chain-studio-theme", theme);
    } catch {}
    return () => media.removeEventListener("change", apply);
  }, [theme, themeLoaded]);
  useEffect(() => {
    if (!image) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty || busy === "running") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const canLeave = () => !dirty || confirm("Discard your unsaved changes?");
  async function choose(chain: Chain) {
    if (locked || chain.id === draft?.id || !canLeave()) return;
    setError("");
    setSelectedRun(null);
    setBusy("loading");
    try {
      await refresh(chain.id, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function create(index?: number) {
    if (locked || !canLeave()) return;
    setDraft(newChain(index));
    setBaseline("");
    setRuns([]);
    setSelectedRun(null);
    setInput("");
    setImage(null);
    setTab("test");
    setError("");
  }
  function patchStep(id: string, patch: Partial<Step>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
          }
        : d,
    );
  }
  function move(from: number, to: number) {
    if (!draft || locked || to < 0 || to >= draft.steps.length) return;
    const steps = [...draft.steps];
    const [step] = steps.splice(from, 1);
    steps.splice(to, 0, step);
    setDraft({ ...draft, steps });
  }
  async function save() {
    if (!draft || locked) return;
    setError("");
    try {
      validateChain(draft);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy("saving");
    try {
      const saved = await api("/api/chains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      await refresh(saved.id, true);
      setNotice("Chain saved. Ready when you are.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  async function remove() {
    if (
      !draft?.id ||
      locked ||
      !confirm(
        `Delete “${draft.name}”? Its steps and mix entries will also be removed. Saved run records are retained.`,
      )
    )
      return;
    setBusy("deleting");
    setError("");
    try {
      await api("/api/chains", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          studio_version: draft.studio_version,
        }),
      });
      setClean(null);
      setSelectedRun(null);
      await refresh(null, false);
      setNotice("Chain deleted.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function run() {
    if (!draft?.id || locked || dirty) return;
    setBusy("running");
    setError("");
    setTab("test");
    setSelectedRun(null);
    try {
      const form = new FormData();
      form.set("chain_id", draft.id);
      form.set("version", String(draft.studio_version));
      form.set("input", input);
      if (image) form.set("image", image);
      const result = await api("/api/runs", { method: "POST", body: form });
      await refresh(draft.id, false);
      setSelectedRun(result.id);
      setNotice("Your chain has a new result.");
    } catch (e) {
      setError((e as Error).message);
      try {
        await refresh(draft.id, false);
      } catch {
        /* Keep the original error. */
      }
    } finally {
      setBusy("");
    }
  }
  async function reload() {
    if (locked || !canLeave()) return;
    setBusy("loading");
    setError("");
    try {
      await refresh(draft?.id || null, true);
      setNotice("Workspace refreshed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function upload(file?: File) {
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Choose a PNG, JPEG, or WebP image smaller than 2 MB.");
      return;
    }
    setImage(file);
    setError("");
  }
  const current = runs.find((r) => r.id === selectedRun) || runs[0];
  const filtered = chains.filter((c) =>
    `${c.name} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const stats = [
    { label: "Saved chains", value: chains.length, icon: Layers },
    {
      label: "Steps in this chain",
      value: draft?.steps.length || 0,
      icon: Workflow,
    },
    {
      label: "Recent completed runs",
      value: runs.filter((r) => r.status === "completed").length,
      icon: Sparkles,
    },
  ];
  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a className="brand" href="/studio">
          <span className="brand-icon">
            <Workflow size={22} />
          </span>
          <span>
            chain<span className="brand-soft">studio</span>
            <small>CAMPUS CHAOS / WORKSPACE</small>
          </span>
        </a>
        <div className="sidebar-heading">
          <span>YOUR WORKSPACE</span>
          <span className="tiny-pill">01</span>
        </div>
        <div className="sidebar-active">
          <Layers size={17} />
          Prompt chains
          <ChevronRight size={15} />
        </div>
        <div className="library-heading">
          <span>CHAIN LIBRARY</span>
          <span>{chains.length.toString().padStart(2, "0")}</span>
        </div>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="Search chains"
            placeholder="Find a chain…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav className="chain-nav" aria-label="Prompt chains">
          {filtered.map((c) => (
            <button
              key={c.id}
              className={`chain-link ${c.id === draft?.id ? "selected" : ""}`}
              disabled={locked}
              onClick={() => void choose(c)}
            >
              <span className="chain-glyph">
                <Workflow size={15} />
              </span>
              <span>
                {c.name}
                <small>
                  {c.steps.length} {c.steps.length === 1 ? "step" : "steps"}
                </small>
              </span>
              {c.id === draft?.id && <span className="selected-dot" />}
            </button>
          ))}
          {!filtered.length && (
            <p className="sidebar-empty">
              {query
                ? "No chains match your search."
                : "Your next idea starts here."}
            </p>
          )}
        </nav>
        <button
          className="sidebar-new"
          disabled={locked}
          onClick={() => create()}
        >
          <Plus size={16} />
          New prompt chain
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="small-spark">✦</span>
            <p>
              Small steps.
              <br />
              <strong>Interesting possibilities.</strong>
            </p>
          </div>
          <div className="account-row">
            <span className="avatar">{name.charAt(0).toUpperCase()}</span>
            <div>
              <strong>{name}</strong>
              <small>Superadmin</small>
            </div>
            <form
              action="/auth/signout"
              method="post"
              onSubmit={(e) => {
                if (locked || !canLeave()) e.preventDefault();
              }}
            >
              <button
                title="Sign out"
                aria-label="Sign out"
                className="icon-button"
                disabled={locked}
              >
                <LogOut size={16} />
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>Prompt chains</strong>
          </div>
          <div className="topbar-right">
            <span className="access-pill">
              <span className="live-dot" /> SUPERADMIN
            </span>
            <div className="theme-picker" aria-label="Color theme">
              {(
                [
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                  { value: "system", label: "System", icon: Monitor },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  title={`${label} theme`}
                  aria-label={`${label} theme`}
                  aria-pressed={theme === value}
                  className={theme === value ? "active" : ""}
                  onClick={() => setTheme(value)}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
            <form
              className="mobile-signout"
              action="/auth/signout"
              method="post"
              onSubmit={(e) => {
                if (locked || !canLeave()) e.preventDefault();
              }}
            >
              <button
                className="icon-button"
                aria-label="Sign out"
                disabled={locked}
              >
                <LogOut size={16} />
              </button>
            </form>
          </div>
        </header>
        <main className="main-content">
          <section className="page-intro">
            <div>
              <div className="eyebrow">
                <span />
                THE CREATIVE ENGINE
              </div>
              <h1>
                Good ideas have <em>great next steps.</em>
              </h1>
              <p>
                A space to connect prompts, explore possibilities, and make
                something unexpected.
              </p>
            </div>
            <button
              className="button primary new-top"
              disabled={locked}
              onClick={() => create()}
            >
              <Plus size={17} />
              New chain
            </button>
          </section>
          <div className="stats-grid">
            {stats.map(({ label, value, icon: Icon }) => (
              <div className="stat-card" key={label}>
                <div>
                  <span>{label}</span>
                  <strong>
                    {busy === "loading" ? "—" : String(value).padStart(2, "0")}
                  </strong>
                </div>
                <span className="stat-icon">
                  <Icon size={20} />
                </span>
              </div>
            ))}
          </div>
          {error && (
            <div className="notice error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {busy === "loading" && !draft ? (
            <div className="loading-state">
              <LoaderCircle className="spin" />
              Opening your workspace…
            </div>
          ) : !draft ? (
            <section className="empty-workspace">
              <span className="empty-orbit">
                <Workflow size={36} />
              </span>
              <div className="eyebrow">A BLANK CANVAS. A HEAD START.</div>
              <h2>What will your first chain create?</h2>
              <p>
                Start from scratch, or borrow a little momentum from a starter.
              </p>
              <button
                className="button primary"
                disabled={locked}
                onClick={() => create()}
              >
                <Plus size={17} />
                Build a blank chain
              </button>
              <div className="starter-grid">
                {starters.map((s, i) => (
                  <button
                    className="starter-card"
                    key={s.name}
                    disabled={locked}
                    onClick={() => create(i)}
                  >
                    <span>
                      0{i + 1}
                      <ArrowUpRight size={18} />
                    </span>
                    <h3>{s.name}</h3>
                    <p>{s.description}</p>
                    <small>
                      {s.steps.length} STEPS ·{" "}
                      {i === 1 ? "IMAGE OUTPUT" : "TEXT OUTPUT"}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="editor-grid">
              <section className="editor-column">
                <div className="section-label">
                  <span>
                    <span className="label-number">01</span>BUILD YOUR CHAIN
                  </span>
                  <div className="editor-actions">
                    <span className={`save-status ${dirty ? "unsaved" : ""}`}>
                      <span />
                      {dirty ? "Unsaved changes" : "All changes saved"}
                    </span>
                    <button
                      className="icon-button"
                      title="Reload saved chain"
                      aria-label="Reload saved chain"
                      disabled={locked}
                      onClick={() => void reload()}
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </div>
                <div className="chain-details panel">
                  <div className="details-top">
                    <span className="tag">
                      {draft.id ? "PROMPT CHAIN" : "NEW PROMPT CHAIN"}
                    </span>
                    <div className="editor-actions">
                      <details className="template-menu">
                        <summary>
                          Use a starter <ChevronRight size={13} />
                        </summary>
                        <div>
                          {starters.map((s, i) => (
                            <button
                              key={s.name}
                              disabled={locked}
                              onClick={(e) => {
                                e.currentTarget
                                  .closest("details")
                                  ?.removeAttribute("open");
                                create(i);
                              }}
                            >
                              {s.name}
                              <ArrowUpRight size={14} />
                            </button>
                          ))}
                        </div>
                      </details>
                      {draft.id && (
                        <button
                          className="icon-button danger"
                          disabled={locked}
                          title="Delete chain"
                          aria-label="Delete chain"
                          onClick={() => void remove()}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  <label className="sr-only" htmlFor="chain-name">
                    Chain name
                  </label>
                  <input
                    id="chain-name"
                    className="chain-name"
                    maxLength={120}
                    disabled={locked}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="Give your idea a name"
                  />
                  <label className="sr-only" htmlFor="chain-description">
                    Chain description
                  </label>
                  <textarea
                    id="chain-description"
                    className="chain-description"
                    maxLength={2000}
                    rows={2}
                    disabled={locked}
                    value={draft.description || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                    placeholder="What should this chain make possible?"
                  />
                  <div className="details-meta">
                    <Workflow size={13} />
                    {draft.steps.length} steps<span>·</span>
                    <span>
                      {draft.id ? `Version ${draft.studio_version}` : "Draft"}
                    </span>
                  </div>
                </div>
                <div className="step-list">
                  {draft.steps.map((step, i) => (
                    <div className="step-wrap" key={step.id}>
                      {i > 0 && (
                        <div className="step-connector">
                          <ArrowDown size={14} />
                        </div>
                      )}
                      <article
                        className="step-card panel"
                        onDragOver={(e) => {
                          if (dragIndex.current !== null) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragIndex.current !== null)
                            move(dragIndex.current, i);
                          dragIndex.current = null;
                        }}
                      >
                        <header className="step-header">
                          <div className="step-identity">
                            <button
                              className="drag-handle icon-button"
                              draggable={!locked}
                              disabled={locked}
                              title="Drag to reorder, or use the arrow buttons"
                              aria-label={`Drag step ${i + 1} to reorder`}
                              onDragStart={(e) => {
                                dragIndex.current = i;
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", String(i));
                              }}
                              onDragEnd={() => (dragIndex.current = null)}
                            >
                              <GripVertical size={16} />
                            </button>
                            <span className="step-number">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <input
                              aria-label={`Step ${i + 1} title`}
                              maxLength={100}
                              disabled={locked}
                              value={step.title}
                              placeholder={`Step ${i + 1}`}
                              onChange={(e) =>
                                patchStep(step.id, { title: e.target.value })
                              }
                            />
                          </div>
                          <div className="step-actions">
                            <button
                              className="icon-button"
                              title="Move up"
                              aria-label={`Move step ${i + 1} up`}
                              disabled={locked || i === 0}
                              onClick={() => move(i, i - 1)}
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              className="icon-button"
                              title="Move down"
                              aria-label={`Move step ${i + 1} down`}
                              disabled={locked || i === draft.steps.length - 1}
                              onClick={() => move(i, i + 1)}
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button
                              className="icon-button"
                              title="Duplicate step"
                              aria-label={`Duplicate step ${i + 1}`}
                              disabled={locked || draft.steps.length >= 12}
                              onClick={() => {
                                const steps = [...draft.steps];
                                steps.splice(i + 1, 0, {
                                  ...step,
                                  id: crypto.randomUUID(),
                                  output_type: "text",
                                });
                                setDraft({ ...draft, steps });
                              }}
                            >
                              <Copy size={14} />
                            </button>
                            <button
                              className="icon-button danger"
                              title="Delete step"
                              aria-label={`Delete step ${i + 1}`}
                              disabled={locked}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  steps: draft.steps.filter(
                                    (s) => s.id !== step.id,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </header>
                        <div className="step-body">
                          <label htmlFor={`prompt-${step.id}`}>PROMPT</label>
                          <textarea
                            id={`prompt-${step.id}`}
                            disabled={locked}
                            rows={5}
                            maxLength={20000}
                            value={step.prompt_template}
                            onChange={(e) =>
                              patchStep(step.id, {
                                prompt_template: e.target.value,
                              })
                            }
                            placeholder={
                              i === 0
                                ? "Describe what you want the AI to do with {{input}}…"
                                : "Build on {{previous}} to take the next step…"
                            }
                          />
                          <div className="step-bottom">
                            <div
                              className="variable-chips"
                              aria-label="Insert a prompt variable"
                            >
                              {[
                                "input",
                                "previous",
                                ...(i > 0 ? [`step_${i}`] : []),
                              ].map((v) => (
                                <button
                                  key={v}
                                  disabled={locked}
                                  title={`Insert {{${v}}}`}
                                  onClick={() => {
                                    const field = document.getElementById(
                                      `prompt-${step.id}`,
                                    ) as HTMLTextAreaElement | null;
                                    const start =
                                      field?.selectionStart ??
                                      step.prompt_template.length;
                                    const end = field?.selectionEnd ?? start;
                                    const token = `{{${v}}}`;
                                    patchStep(step.id, {
                                      prompt_template:
                                        step.prompt_template.slice(0, start) +
                                        token +
                                        step.prompt_template.slice(end),
                                    });
                                    requestAnimationFrame(() => {
                                      field?.focus();
                                      field?.setSelectionRange(
                                        start + token.length,
                                        start + token.length,
                                      );
                                    });
                                  }}
                                >{`{{${v}}}`}</button>
                              ))}
                            </div>
                            <label className="output-select">
                              <span className="sr-only">
                                Step {i + 1} output type
                              </span>
                              {step.output_type === "image" ? (
                                <ImageIcon size={13} />
                              ) : (
                                <FileText size={13} />
                              )}
                              <select
                                aria-label={`Step ${i + 1} output type`}
                                disabled={locked}
                                value={step.output_type}
                                onChange={(e) =>
                                  patchStep(step.id, {
                                    output_type: e.target
                                      .value as Step["output_type"],
                                  })
                                }
                              >
                                <option value="text">Text output</option>
                                <option
                                  value="image"
                                  disabled={i !== draft.steps.length - 1}
                                >
                                  Image output
                                </option>
                              </select>
                            </label>
                          </div>
                        </div>
                      </article>
                    </div>
                  ))}
                </div>
                <button
                  className="add-step"
                  disabled={locked || draft.steps.length >= 12}
                  onClick={() =>
                    setDraft({ ...draft, steps: [...draft.steps, newStep()] })
                  }
                >
                  <Plus size={17} />
                  {draft.steps.length >= 12
                    ? "12-step limit reached"
                    : "Add another step"}
                  <span>KEEP THE IDEA MOVING</span>
                </button>
                <div className="variable-note">
                  <Sparkles size={15} />
                  <p>
                    <code>{"{{input}}"}</code> is your original text.{" "}
                    <code>{"{{previous}}"}</code> is the last result (or input
                    on step 1). Use <code>{"{{step_1}}"}</code> to reference a
                    specific earlier step. Your uploaded image accompanies every
                    step.
                  </p>
                </div>
                <div className="save-bar">
                  <span>
                    {dirty
                      ? "A little progress, ready to save."
                      : "Your chain is ready for its next idea."}
                  </span>
                  <button
                    className="button primary"
                    disabled={locked || !dirty}
                    onClick={() => void save()}
                  >
                    {busy === "saving" ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Save size={16} />
                    )}
                    Save chain<span className="key-hint">⌘ S</span>
                  </button>
                </div>
              </section>
              <aside className="test-column">
                <div className="section-label">
                  <span>
                    <span className="label-number">02</span>SEE WHAT HAPPENS
                  </span>
                  <span className="small-muted">PLAY. REFINE. REPEAT.</span>
                </div>
                <div className="test-panel panel">
                  <div className="panel-tabs">
                    <button
                      className={tab === "test" ? "active" : ""}
                      onClick={() => setTab("test")}
                    >
                      <Play size={14} />
                      Test run
                    </button>
                    <button
                      className={tab === "history" ? "active" : ""}
                      onClick={() => setTab("history")}
                    >
                      <Clock3 size={14} />
                      History<span>{runs.length}</span>
                    </button>
                  </div>
                  {tab === "test" ? (
                    <>
                      <div className="test-intro">
                        <h2>
                          A spark goes in.
                          <br />
                          <em>Something new comes out.</em>
                        </h2>
                        <p>Give your chain a starting point.</p>
                      </div>
                      <div className="test-form">
                        <label htmlFor="test-input">YOUR INPUT</label>
                        <textarea
                          id="test-input"
                          disabled={busy === "running"}
                          maxLength={10000}
                          rows={4}
                          placeholder="A campus moment, a half-formed idea, an unexpected observation…"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                        />
                        <input
                          aria-label="Upload input image"
                          ref={fileRef}
                          className="sr-only"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={busy === "running"}
                          onChange={(e) => {
                            upload(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                        {image ? (
                          <div className="upload-preview">
                            {preview && (
                              <img src={preview} alt="Your uploaded input" />
                            )}
                            <div>
                              <strong>{image.name}</strong>
                              <small>{Math.round(image.size / 1024)} KB</small>
                            </div>
                            <button
                              className="icon-button"
                              disabled={busy === "running"}
                              aria-label="Remove uploaded image"
                              onClick={() => setImage(null)}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <button
                            className="upload-zone"
                            disabled={busy === "running"}
                            onClick={() => fileRef.current?.click()}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (busy !== "running")
                                upload(e.dataTransfer.files[0]);
                            }}
                          >
                            <ImagePlus size={22} />
                            <span>
                              Add an image
                              <small>
                                Drop it here, or click to browse · up to 2 MB
                              </small>
                            </span>
                            <Plus size={16} />
                          </button>
                        )}
                        <button
                          className="button primary run-button"
                          disabled={
                            locked ||
                            dirty ||
                            !draft.id ||
                            !draft.steps.length ||
                            (!input.trim() && !image)
                          }
                          onClick={() => void run()}
                        >
                          {busy === "running" ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <Play size={16} fill="currentColor" />
                          )}
                          {busy === "running"
                            ? "Your chain is working…"
                            : "Run chain"}
                          {busy !== "running" && <ArrowUpRight size={17} />}
                        </button>
                        <p className="run-hint">
                          {dirty
                            ? "Save your changes to run this version."
                            : !draft.steps.length
                              ? "Add a step, then save your chain."
                              : "Runs use your saved chain and Gemini API quota."}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="history-list">
                      <div className="history-heading">
                        <span>Last 50 runs for this chain</span>
                        <button
                          className="icon-button"
                          disabled={locked}
                          title="Refresh history and image links"
                          aria-label="Refresh history"
                          onClick={async () => {
                            setBusy("loading");
                            try {
                              await refresh(draft.id, false);
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          <RefreshCw size={14} />
                        </button>
                      </div>
                      {runs.length ? (
                        runs.map((r) => (
                          <button
                            className={`history-item ${current?.id === r.id ? "active" : ""}`}
                            key={r.id}
                            onClick={() => {
                              setSelectedRun(r.id);
                              setTab("test");
                            }}
                          >
                            <span className={`run-state ${statusOf(r)}`}>
                              {statusOf(r) === "completed" ? (
                                <Check size={15} />
                              ) : statusOf(r) === "running" ? (
                                <LoaderCircle size={15} />
                              ) : (
                                <AlertCircle size={15} />
                              )}
                            </span>
                            <span>
                              <strong>{r.input_text || "Image input"}</strong>
                              <small>
                                {stamp(r.created_at)} · v{r.chain_version}
                              </small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        ))
                      ) : (
                        <div className="mini-empty">
                          <Clock3 size={26} />
                          <p>A clean slate.</p>
                          <small>Your saved runs will appear here.</small>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {busy === "running" ? (
                  <div className="running-card">
                    <span className="running-orbit">
                      <Sparkles size={25} />
                    </span>
                    <h3>Connecting the dots…</h3>
                    <p>
                      Running each saved step in sequence.
                      <br />
                      Keep this tab open while your ideas take shape.
                    </p>
                    <div className="progress-track">
                      <span />
                    </div>
                  </div>
                ) : current ? (
                  <Result
                    run={current}
                    onCopy={() => setNotice("Copied to clipboard.")}
                    onError={setError}
                  />
                ) : (
                  <div className="result-placeholder">
                    <span className="result-star">✳</span>
                    <h3>Room for a little magic.</h3>
                    <p>
                      Your results will land here.
                      <br />
                      Let’s see where this chain takes you.
                    </p>
                    <span className="dotted-line" />
                  </div>
                )}
              </aside>
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              CHAIN STUDIO <span>✦</span> MADE FOR WHAT’S NEXT
            </span>
            <span>Campus Chaos / Creative tools</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
function Result({
  run,
  onCopy,
  onError,
}: {
  run: Run;
  onCopy: () => void;
  onError: (message: string) => void;
}) {
  const final = run.outputs.at(-1);
  const state = statusOf(run);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      onCopy();
    } catch {
      onError(
        "Copy wasn’t available. You can select and copy the result manually.",
      );
    }
  }
  async function download(output: Output) {
    try {
      let blob: Blob;
      if (output.type === "image") {
        if (!output.url)
          throw new Error("Refresh history to renew this image link.");
        const response = await fetch(output.url);
        if (!response.ok)
          throw new Error(
            "The image link expired. Refresh history to renew it.",
          );
        blob = await response.blob();
      } else blob = new Blob([output.text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chain-studio-${run.id.slice(0, 8)}.${output.type === "image" ? (blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png") : "txt"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="result-card panel">
      <div className="result-heading">
        <span>
          <Sparkles size={15} />
          {state === "completed" ? "THE CHAIN REACTION" : "RUN DETAILS"}
        </span>
        <span className={`status-badge ${state}`}>{state}</span>
      </div>
      <div className="result-meta">
        {stamp(run.created_at)}
        <span>·</span>Version {run.chain_version}
        <span>·</span>
        {run.outputs.length}/{run.steps_snapshot.length} steps
      </div>
      {run.error && (
        <p className="inline-error" role="alert">
          {run.error}
        </p>
      )}
      {state === "interrupted" && (
        <p className="inline-error">
          This run was interrupted before its status was saved. Check your
          Vercel function logs, then start a new run.
        </p>
      )}
      {state === "running" && (
        <p className="small-muted">
          A run is still marked as running. Wait, then refresh History. Runs can
          take up to four minutes.
        </p>
      )}
      {final && (
        <div className="final-output">
          <div className="final-title">
            <strong>
              {state === "completed" ? "Final output" : "Last completed step"}
            </strong>
            <div className="editor-actions">
              {final.text && (
                <button
                  className="icon-button"
                  title="Copy result"
                  aria-label="Copy result"
                  onClick={() => void copy(final.text)}
                >
                  <Copy size={14} />
                </button>
              )}
              <button
                className="icon-button"
                title="Download result"
                aria-label="Download result"
                onClick={() => void download(final)}
              >
                <Download size={15} />
              </button>
            </div>
          </div>
          {final.type === "image" && final.url && (
            <img
              className="generated-image"
              src={final.url}
              alt={final.text || "Image generated by your prompt chain"}
              onError={(e) => {
                e.currentTarget.style.display = "none";
                onError(
                  "The image couldn’t load. Refresh History to renew the link.",
                );
              }}
            />
          )}
          {final.type === "image" && !final.url && (
            <p className="small-muted">
              Refresh History to load the generated image.
            </p>
          )}
          {final.text && <div className="output-text">{final.text}</div>}
        </div>
      )}
      <details className="run-input">
        <summary>Original input {run.had_image && "· image attached"}</summary>
        <p>
          {run.input_text ||
            "Image only. Input images are sent to Gemini for this run and are not saved in history."}
        </p>
      </details>
      <div className="trace-heading">FOLLOW THE THREAD</div>
      {run.outputs.map((o, i) => (
        <details className="output-trace" key={o.step_id}>
          <summary>
            <span className="trace-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <strong>{o.title}</strong>
            <span>{(o.duration_ms / 1000).toFixed(1)}s</span>
            <ChevronRight size={14} />
          </summary>
          <div>
            <p className="model-label">
              {o.model} · {o.type} output
            </p>
            <p className="output-text">
              {o.text || "Image generated—see the final output above."}
            </p>
            <details className="snapshot-prompt">
              <summary>Prompt used in this run</summary>
              <p>{run.steps_snapshot[i]?.prompt_template}</p>
            </details>
          </div>
        </details>
      ))}
    </div>
  );
}
```

## `lib/auth.ts`

```ts
import { createClient } from "@/lib/supabase/server";
export class HttpError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export async function requireAdmin(request?: Request) {
  if (request && request.method !== "GET") {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin)
      throw new HttpError("Request origin is not allowed", 403);
  }
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user)
    throw new HttpError("Your session expired. Sign in again.", 401);
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("is_superadmin,first_name")
    .eq("id", user.id)
    .single();
  if (profileError || profile?.is_superadmin !== true)
    throw new HttpError("Superadmin access required", 403);
  return { supabase, user, profile };
}
export function apiError(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Something went wrong. Please try again.",
    },
    { status: error instanceof HttpError ? error.status : 500 },
  );
}
export function dbError(error: { message: string; code?: string }) {
  return new HttpError(
    error.message,
    error.code === "40001" ? 409 : error.code === "42501" ? 403 : 400,
  );
}
```

## `lib/starters.ts`

```ts
import type { Chain, Step } from "./types";
export const starters = [
  {
    name: "Campus caption lab",
    description: "Find the humor hiding in an everyday campus moment.",
    steps: [
      {
        title: "Read the room",
        prompt_template:
          "Describe the uploaded image in specific, concrete detail. If no image is attached, use this scene: {{input}}. Focus on expressions, objects, and unexpected details. Keep it under 150 words.",
        output_type: "text",
      },
      {
        title: "Find the funny",
        prompt_template:
          "Find three funny, relatable angles for this scene. Aim for smart college humor, not clichés. Scene: {{previous}}",
        output_type: "text",
      },
      {
        title: "Make it caption-worthy",
        prompt_template:
          "Write five distinct, short captions based on these angles: {{previous}}. Original context: {{input}}. One caption per line. Keep each under 15 words. No hashtags.",
        output_type: "text",
      },
    ],
  },
  {
    name: "Idea → visual",
    description: "Turn an idea into a creative brief, then a generated image.",
    steps: [
      {
        title: "Build the brief",
        prompt_template:
          "Develop a concise art direction brief for this idea: {{input}}. Include composition, a coherent color palette, lighting, and mood. Avoid lettering. Under 150 words.",
        output_type: "text",
      },
      {
        title: "Bring it to life",
        prompt_template:
          "Generate an original image following this art direction: {{previous}}. Make the composition polished and visually striking. No text or watermarks.",
        output_type: "image",
      },
    ],
  },
  {
    name: "The perspective shift",
    description: "Challenge an idea, sharpen it, and turn it into a pitch.",
    steps: [
      {
        title: "Find the friction",
        prompt_template:
          "Analyze this product idea: {{input}}. Identify the target user, their unmet need, and three weaknesses in the idea. Be specific. Under 200 words.",
        output_type: "text",
      },
      {
        title: "Make the idea stronger",
        prompt_template:
          "Improve this original idea: {{input}}. Address these critiques: {{previous}}. Write a clear 120-word pitch with a concrete use case. Avoid buzzwords.",
        output_type: "text",
      },
    ],
  },
] as const;
export function newStep(): Step {
  return {
    id: crypto.randomUUID(),
    title: "",
    prompt_template: "",
    output_type: "text",
  };
}
export function newChain(index?: number): Chain {
  const t = index === undefined ? undefined : starters[index];
  return {
    id: null,
    name: t?.name || "Untitled chain",
    description: t?.description || "",
    studio_version: 0,
    steps: t
      ? t.steps.map((s) => ({ ...s, id: crypto.randomUUID() }))
      : [newStep()],
  };
}
```

## `lib/supabase/client.ts`

```ts
"use client";
import { createBrowserClient } from "@supabase/ssr";
let client: ReturnType<typeof createBrowserClient> | undefined;
export function createClient() {
  return (client ??= createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  ));
}
```

## `lib/supabase/server.ts`

```ts
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
export function configured() {
  return !!(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  );
}
export async function createClient() {
  if (!configured())
    throw new Error(
      "Add the Supabase URL and public key to your environment variables.",
    );
  const jar = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => jar.getAll(),
        setAll(values) {
          try {
            values.forEach(({ name, value, options }) =>
              jar.set(name, value, options),
            );
          } catch {
            /* Server component: proxy refreshes cookies. */
          }
        },
      },
    },
  );
}
```

## `lib/types.ts`

```ts
export type Step = {
  id: string;
  title: string;
  prompt_template: string;
  output_type: "text" | "image";
  step_number?: number;
};
export type Chain = {
  id: string | null;
  name: string;
  description: string;
  studio_version: number;
  created_at?: string;
  steps: Step[];
};
export type Output = {
  step_id: string;
  title: string;
  type: "text" | "image";
  text: string;
  model: string;
  duration_ms: number;
  path?: string;
  url?: string;
};
export type Run = {
  id: string;
  prompt_chain_id: string | null;
  chain_name: string;
  chain_version: number;
  input_text: string;
  had_image: boolean;
  steps_snapshot: Step[];
  outputs: Output[];
  status: "running" | "completed" | "failed";
  error: string | null;
  created_at: string;
  completed_at: string | null;
};
```

## `lib/validation.ts`

```ts
import type { Chain } from "./types.ts";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}
export function validateChain(value: unknown): asserts value is Chain {
  if (!value || typeof value !== "object") throw new Error("Invalid chain");
  const c = value as Chain;
  if (c.id !== null && !validId(c.id)) throw new Error("Invalid chain ID");
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > 120)
    throw new Error("Use a name between 1 and 120 characters");
  if (typeof c.description !== "string" || c.description.length > 2000)
    throw new Error("Description must be at most 2,000 characters");
  if (!Number.isInteger(c.studio_version) || c.studio_version < 0)
    throw new Error("Invalid chain version");
  if (!Array.isArray(c.steps) || c.steps.length > 12)
    throw new Error("A chain can have up to 12 steps");
  const ids = new Set<string>();
  c.steps.forEach((s, i) => {
    if (!validId(s.id) || ids.has(s.id))
      throw new Error("Invalid or duplicate step ID");
    ids.add(s.id);
    if (typeof s.title !== "string" || s.title.length > 100)
      throw new Error("Step titles must be at most 100 characters");
    if (
      typeof s.prompt_template !== "string" ||
      !s.prompt_template.trim() ||
      s.prompt_template.length > 20000
    )
      throw new Error(
        `Step ${i + 1} needs a prompt (maximum 20,000 characters)`,
      );
    if (!["text", "image"].includes(s.output_type))
      throw new Error("Invalid output type");
    if (s.output_type === "image" && i !== c.steps.length - 1)
      throw new Error("Only the last step can generate an image");
    const tokens = s.prompt_template.match(/\{\{[^}]*\}\}/g) || [];
    for (const token of tokens) {
      const name = token.slice(2, -2).trim();
      const m = name.match(/^step_(\d+)$/);
      if (
        !["input", "previous"].includes(name) &&
        !(m && Number(m[1]) >= 1 && Number(m[1]) <= i)
      )
        throw new Error(
          `Step ${i + 1}: unknown or unavailable variable ${token}`,
        );
    }
  });
}
export function resolvePrompt(
  template: string,
  input: string,
  outputs: { text: string }[],
): string {
  const resolved = template.replace(
    /\{\{\s*(input|previous|step_\d+)\s*\}\}/g,
    (_, name: string) => {
      if (name === "input") return input;
      if (name === "previous") return outputs.at(-1)?.text || input;
      return outputs[Number(name.slice(5)) - 1]?.text || "";
    },
  );
  if (resolved.length > 100000)
    throw new Error(
      "Combined prompt is too large. Shorten your input or step output.",
    );
  return resolved;
}
```

## `next-env.d.ts`

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";
import "./.next/types/root-params.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

## `next.config.ts`

```ts
import type { NextConfig } from "next";
const config: NextConfig = { poweredByHeader: false };
export default config;
```

## `package.json`

```json
{
  "name": "chain-studio",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "node scripts/dev.mjs",
    "build": "next build",
    "start": "next start",
    "typecheck": "tsc --noEmit",
    "test": "node --experimental-strip-types --test tests/*.test.ts"
  },
  "dependencies": {
    "@google/genai": "^3.0.0",
    "@supabase/ssr": "^0.12.7",
    "@supabase/supabase-js": "^2.118.0",
    "lucide-react": "^0.468.0",
    "next": "16.4.5",
    "react": "19.3.1",
    "react-dom": "19.3.1"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.5.15",
    "@types/node": "^24",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "typescript": "^5"
  },
  "type": "module",
  "engines": {
    "node": ">=22.18.0"
  }
}
```

## `proxy.ts`

```ts
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  if (
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  )
    return response;
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll(values) {
          values.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          values.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );
  await supabase.auth.getUser();
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

## `scripts/dev.mjs`

```javascript
import { spawn } from "node:child_process";
// Accept both Next.js and common preview-host flags.
const args = process.argv
  .slice(2)
  .filter((v) => v !== "--strictPort")
  .map((v) => (v === "--host" ? "--hostname" : v));
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", ...args],
  { stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 0));
```

## `supabase/setup.sql`

```sql
-- Chain Studio: additive setup for Jessica's existing Design for Gen AI database.
-- Run the WHOLE file once in the existing project's SQL Editor.
-- No existing table, record, or policy is deleted or replaced.
begin;

alter table public.prompt_chains add column if not exists studio_version integer not null default 1;
alter table public.prompt_chain_steps add column if not exists title text not null default '';
alter table public.prompt_chain_steps add column if not exists output_type text not null default 'text';

create table if not exists public.chain_studio_runs (
  id uuid primary key,
  prompt_chain_id uuid references public.prompt_chains(id) on delete set null,
  generation_request_id uuid references public.generation_requests(id) on delete set null,
  user_id uuid not null references auth.users(id),
  chain_name text not null,
  chain_version integer not null,
  input_text text not null,
  had_image boolean not null default false,
  steps_snapshot jsonb not null,
  outputs jsonb not null default '[]',
  status text not null default 'running' check (status in ('running','completed','failed')),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists chain_studio_runs_chain_created on public.chain_studio_runs(prompt_chain_id,created_at desc);
alter table public.chain_studio_runs enable row level security;

create or replace function public.chain_studio_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=auth.uid() and is_superadmin=true);
$$;
revoke all on function public.chain_studio_is_admin() from public;
grant execute on function public.chain_studio_is_admin() to authenticated;

create or replace function public.chain_studio_list(p_chain_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'chains',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('steps',coalesce(
      (select jsonb_agg(to_jsonb(s) order by s.step_number,s.created_at,s.id) from public.prompt_chain_steps s where s.prompt_chain_id=c.id),'[]'::jsonb)) order by c.created_at desc) from public.prompt_chains c),'[]'::jsonb),
    'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from
      (select * from public.chain_studio_runs where prompt_chain_id=p_chain_id order by created_at desc limit 50) r),'[]'::jsonb)
  ) into result;
  return result;
end; $$;

create or replace function public.chain_studio_save(p_chain jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid; current_version integer; s jsonb; position integer:=0; step_ids uuid[]:='{}';
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  if length(trim(coalesce(p_chain->>'name','')))=0 or length(p_chain->>'name')>120 then raise exception 'Use a chain name between 1 and 120 characters'; end if;
  if jsonb_typeof(p_chain->'steps') is distinct from 'array' then raise exception 'Steps must be an array'; end if;
  if jsonb_array_length(p_chain->'steps')>12 then raise exception 'Maximum 12 steps'; end if;
  cid := (p_chain->>'id')::uuid;
  if cid is null then
    insert into public.prompt_chains(name,description) values(trim(p_chain->>'name'),coalesce(p_chain->>'description','')) returning id,studio_version into cid,current_version;
  else
    select studio_version into current_version from public.prompt_chains where id=cid for update;
    if not found then raise exception 'Chain not found'; end if;
    if current_version is distinct from (p_chain->>'studio_version')::integer then raise exception 'This chain changed in another tab. Reload before saving.' using errcode='40001'; end if;
    update public.prompt_chains set name=trim(p_chain->>'name'), description=coalesce(p_chain->>'description',''),studio_version=studio_version+1 where id=cid returning studio_version into current_version;
  end if;
  -- Park old positions so swapping steps also works with unique(chain_id,step_number).
  update public.prompt_chain_steps set step_number=step_number+1000000 where prompt_chain_id=cid;
  for s in select value from jsonb_array_elements(p_chain->'steps') loop
    position:=position+1;
    if length(trim(coalesce(s->>'prompt_template','')))=0 or length(s->>'prompt_template')>20000 then raise exception 'Every step needs a prompt, maximum 20,000 characters'; end if;
    if coalesce(s->>'output_type','text') not in ('text','image') then raise exception 'Invalid output type'; end if;
    if s->>'output_type'='image' and position<>jsonb_array_length(p_chain->'steps') then raise exception 'Image output is supported on the final step only'; end if;
    if (s->>'id')::uuid = any(step_ids) then raise exception 'Duplicate step ID'; end if;
    if exists(select 1 from public.prompt_chain_steps where id=(s->>'id')::uuid and prompt_chain_id is distinct from cid) then raise exception 'Step belongs to another chain'; end if;
    step_ids:=array_append(step_ids,(s->>'id')::uuid);
    insert into public.prompt_chain_steps(id,prompt_chain_id,step_number,prompt_template,title,output_type)
    values((s->>'id')::uuid,cid,position,s->>'prompt_template',left(coalesce(s->>'title',''),100),coalesce(s->>'output_type','text'))
    on conflict(id) do update set step_number=excluded.step_number,prompt_template=excluded.prompt_template,title=excluded.title,output_type=excluded.output_type;
  end loop;
  delete from public.prompt_chain_steps where prompt_chain_id=cid and not(id=any(step_ids));
  return jsonb_build_object('id',cid,'studio_version',current_version);
end; $$;

create or replace function public.chain_studio_delete(p_chain_id uuid,p_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select studio_version into v from public.prompt_chains where id=p_chain_id for update;
  if not found then raise exception 'Chain not found'; end if;
  if v is distinct from p_version then raise exception 'This chain changed. Reload before deleting.' using errcode='40001'; end if;
  delete from public.prompt_chain_mix where prompt_chain_id=p_chain_id;
  delete from public.prompt_chain_steps where prompt_chain_id=p_chain_id;
  delete from public.prompt_chains where id=p_chain_id;
end; $$;

create or replace function public.chain_studio_start_run(p_id uuid,p_chain_id uuid,p_version integer,p_input text,p_had_image boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.prompt_chains%rowtype; snapshot jsonb; request_id uuid; result jsonb;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select * into c from public.prompt_chains where id=p_chain_id for share;
  if not found then raise exception 'Chain not found'; end if;
  if c.studio_version is distinct from p_version then raise exception 'This chain changed. Reload and try again.' using errcode='40001'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by step_number,created_at,id),'[]'::jsonb) into snapshot from public.prompt_chain_steps s where prompt_chain_id=c.id;
  if jsonb_array_length(snapshot)=0 then raise exception 'Add and save at least one step first'; end if;
  if jsonb_array_length(snapshot)>12 then raise exception 'Maximum 12 steps'; end if;
  insert into public.generation_requests(user_id,prompt,status) values(auth.uid(),p_input,'running') returning id into request_id;
  insert into public.chain_studio_runs(id,prompt_chain_id,generation_request_id,user_id,chain_name,chain_version,input_text,had_image,steps_snapshot)
  values(p_id,c.id,request_id,auth.uid(),c.name,c.studio_version,p_input,p_had_image,snapshot) returning to_jsonb(chain_studio_runs.*) into result;
  return result;
end; $$;

create or replace function public.chain_studio_finish_run(p_id uuid,p_outputs jsonb,p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.chain_studio_runs%rowtype; o jsonb; last_output jsonb;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select * into r from public.chain_studio_runs where id=p_id for update;
  if not found or r.user_id<>auth.uid() then raise exception 'Run not found'; end if;
  if r.status<>'running' then raise exception 'Run already finalized'; end if;
  if jsonb_typeof(p_outputs) is distinct from 'array' then raise exception 'Outputs must be an array'; end if;
  update public.chain_studio_runs set outputs=p_outputs,status=case when p_error is null then 'completed' else 'failed' end,error=left(p_error,2000),completed_at=now() where id=p_id;
  update public.generation_requests set status=case when p_error is null then 'completed' else 'failed' end where id=r.generation_request_id;
  for o in select value from jsonb_array_elements(p_outputs) loop
    insert into public.llm_responses(generation_request_id,response_text) values(r.generation_request_id,coalesce(o->>'text','[Image output]'));
  end loop;
  if p_error is null and jsonb_array_length(p_outputs)>0 then
    last_output:=p_outputs->(jsonb_array_length(p_outputs)-1);
    insert into public.ai_generated_media(generation_request_id,media_type,description,media_url)
    values(r.generation_request_id,coalesce(last_output->>'type','text'),coalesce(last_output->>'text',''),case when last_output->>'path' is not null then 'supabase://chain-studio/'||(last_output->>'path') else null end);
  end if;
end; $$;

revoke all on function public.chain_studio_list(uuid),public.chain_studio_save(jsonb),public.chain_studio_delete(uuid,integer),public.chain_studio_start_run(uuid,uuid,integer,text,boolean),public.chain_studio_finish_run(uuid,jsonb,text) from public;
grant execute on function public.chain_studio_list(uuid),public.chain_studio_save(jsonb),public.chain_studio_delete(uuid,integer),public.chain_studio_start_run(uuid,uuid,integer,text,boolean),public.chain_studio_finish_run(uuid,jsonb,text) to authenticated;

-- Private generated images; signed URLs are produced only for authenticated admins.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chain-studio','chain-studio',false,10485760,array['image/png','image/jpeg','image/webp']) on conflict(id) do nothing;
do $$ begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='chain_studio_admin_images') then
    create policy chain_studio_admin_images on storage.objects for all to authenticated
    using(bucket_id='chain-studio' and public.chain_studio_is_admin())
    with check(bucket_id='chain-studio' and public.chain_studio_is_admin());
  end if;
end $$;
commit;
```

## `tests/database.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  member = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const step1 = "11111111-1111-4111-8111-111111111111",
  step2 = "22222222-2222-4222-8222-222222222222";
test("database enforces admin access, atomic ordering, conflicts, snapshots, and retained history", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role authenticated;create role anon;create schema auth;create schema storage;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);
 create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
 create table public.prompt_chains(id uuid primary key default gen_random_uuid(),name text not null,description text,created_at timestamptz default now());
 create table public.prompt_chain_steps(id uuid primary key default gen_random_uuid(),prompt_chain_id uuid references public.prompt_chains(id),step_number integer not null default 1 check(step_number>0),prompt_template text not null,created_at timestamptz default now(),unique(prompt_chain_id,step_number));
 create table public.prompt_chain_mix(id uuid primary key default gen_random_uuid(),prompt_chain_id uuid references public.prompt_chains(id));
 create table public.generation_requests(id uuid primary key default gen_random_uuid(),user_id uuid,prompt text,status text default 'pending',created_at timestamptz default now());
 create table public.llm_responses(id uuid primary key default gen_random_uuid(),generation_request_id uuid,model_id uuid,response_text text,created_at timestamptz default now());
 create table public.ai_generated_media(id uuid primary key default gen_random_uuid(),generation_request_id uuid,media_url text,media_type text,description text,created_at timestamptz default now());
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key,bucket_id text);alter table storage.objects enable row level security;
 insert into auth.users values('${admin}'),('${member}');insert into profiles values('${admin}',true),('${member}',false);`);
    const setup = readFileSync(
      new URL("../supabase/setup.sql", import.meta.url),
      "utf8",
    );
    await db.exec(setup);
    await db.exec(setup);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      member,
    ]);
    await assert.rejects(
      () => db.query("select public.chain_studio_list()"),
      /Superadmin/,
    );
    await assert.rejects(
      () => db.query("select public.chain_studio_save('{}'::jsonb)"),
      /Superadmin/,
    );
    await assert.rejects(
      () => db.query("select public.chain_studio_delete($1,1)", [step1]),
      /Superadmin/,
    );
    await assert.rejects(
      () =>
        db.query(
          "select public.chain_studio_start_run($1,$2,1,'input',false)",
          [step1, step2],
        ),
      /Superadmin/,
    );
    await assert.rejects(
      () =>
        db.query("select public.chain_studio_finish_run($1,'[]'::jsonb,null)", [
          step1,
        ]),
      /Superadmin/,
    );
    await assert.rejects(
      () => db.query("select * from public.chain_studio_runs"),
      /permission denied/,
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    const save = async (c: unknown) =>
      (
        await db.query<{ v: { id: string; studio_version: number } }>(
          "select public.chain_studio_save($1::jsonb) as v",
          [JSON.stringify(c)],
        )
      ).rows[0].v;
    const list = async (id: string) =>
      (
        await db.query<{ v: { chains: any[]; runs: any[] } }>(
          "select public.chain_studio_list($1) as v",
          [id],
        )
      ).rows[0].v;
    const steps = [
      {
        id: step1,
        title: "First",
        prompt_template: "{{input}}",
        output_type: "text",
      },
      {
        id: step2,
        title: "Second",
        prompt_template: "{{previous}}",
        output_type: "text",
      },
    ];
    const saved = await save({
      id: null,
      name: "Original",
      description: "",
      studio_version: 0,
      steps,
    });
    assert.equal(saved.studio_version, 1);
    let data = await list(saved.id);
    assert.deepEqual(
      data.chains[0].steps.map((s: { id: string }) => s.id),
      [step1, step2],
    );
    await save({
      id: saved.id,
      name: "Reordered",
      description: "",
      studio_version: 1,
      steps: [steps[1], steps[0]],
    });
    data = await list(saved.id);
    assert.deepEqual(
      data.chains[0].steps.map((s: { id: string }) => s.id),
      [step2, step1],
    );
    await assert.rejects(
      () =>
        save({
          id: saved.id,
          name: "Stale",
          description: "",
          studio_version: 1,
          steps,
        }),
      /another tab/,
    );
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.query(
      "select public.chain_studio_start_run($1,$2,2,'test input',false)",
      [runId, saved.id],
    );
    await save({
      id: saved.id,
      name: "Changed later",
      description: "",
      studio_version: 2,
      steps: [steps[0]],
    });
    data = await list(saved.id);
    assert.equal(data.runs[0].chain_name, "Reordered");
    assert.equal(data.runs[0].steps_snapshot.length, 2);
    assert.equal(data.chains[0].steps.length, 1);
    await db.query("select public.chain_studio_finish_run($1,$2::jsonb,null)", [
      runId,
      JSON.stringify([
        {
          step_id: step2,
          title: "Output",
          type: "text",
          text: "A real result",
          duration_ms: 100,
          model: "test-model",
        },
      ]),
    ]);
    data = await list(saved.id);
    assert.equal(data.runs[0].status, "completed");
    await assert.rejects(
      () =>
        db.query("select public.chain_studio_finish_run($1,'[]'::jsonb,null)", [
          runId,
        ]),
      /already finalized/,
    );
    const foreign = await save({
      id: null,
      name: "Other",
      description: "",
      studio_version: 0,
      steps: [],
    });
    await assert.rejects(
      () =>
        save({
          id: foreign.id,
          name: "Other",
          description: "",
          studio_version: 1,
          steps: [steps[0]],
        }),
      /another chain/,
    );
    await db.exec("reset role");
    assert.equal(
      (
        await db.query<{ description: string }>(
          "select description from ai_generated_media",
        )
      ).rows[0].description,
      "A real result",
    );
    await db.query("insert into prompt_chain_mix(prompt_chain_id) values($1)", [
      saved.id,
    ]);
    await db.exec("set role authenticated");
    await db.query("select public.chain_studio_delete($1,3)", [saved.id]);
    await db.exec("reset role");
    const retained = (
      await db.query<{ prompt_chain_id: string | null; chain_name: string }>(
        "select prompt_chain_id,chain_name from chain_studio_runs",
      )
    ).rows[0];
    assert.equal(retained.prompt_chain_id, null);
    assert.equal(retained.chain_name, "Reordered");
    assert.equal(
      (await db.query("select * from prompt_chain_steps")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
```

## `tests/validation.test.ts`

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePrompt, validateChain } from "../lib/validation.ts";
const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const chain = () => ({
  id: null,
  name: "Test",
  description: "",
  studio_version: 0,
  steps: ids.map((id, i) => ({
    id,
    title: "Step",
    prompt_template: i
      ? "Use {{previous}} and {{step_1}}"
      : "Describe {{input}}",
    output_type: "text" as const,
  })),
});
test("variables resolve original input, previous result, and specific earlier output", () => {
  assert.equal(
    resolvePrompt("{{input}} / {{previous}} / {{step_1}}", "original", [
      { text: "first" },
      { text: "second" },
    ]),
    "original / second / first",
  );
  assert.equal(resolvePrompt("{{previous}}", "original", []), "original");
});
test("model output is substituted literally without recursive variable expansion", () => {
  assert.equal(
    resolvePrompt("{{previous}}", "input", [{ text: "$& {{input}}" }]),
    "$& {{input}}",
  );
});
test("rejects forward references, duplicate steps, and image steps in the middle", () => {
  assert.doesNotThrow(() => validateChain(chain()));
  const forward = chain();
  forward.steps[0].prompt_template = "{{step_2}}";
  assert.throws(() => validateChain(forward), /unavailable/);
  const duplicate = chain();
  duplicate.steps[1].id = duplicate.steps[0].id;
  assert.throws(() => validateChain(duplicate), /duplicate/);
  const image = chain();
  Object.assign(image.steps[0], { output_type: "image" });
  assert.throws(() => validateChain(image), /last step/);
});
test("rejects blank names, blank prompts, and unbounded model context", () => {
  assert.throws(() => validateChain({ ...chain(), name: " " }), /name/);
  const empty = chain();
  empty.steps[1].prompt_template = " ";
  assert.throws(() => validateChain(empty), /needs a prompt/);
  assert.throws(
    () => resolvePrompt("{{previous}}", "", [{ text: "a".repeat(100001) }]),
    /too large/,
  );
});
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "react-jsx",
    "incremental": true,
    "plugins": [
      {
        "name": "next"
      }
    ],
    "paths": {
      "@/*": ["./*"]
    },
    "allowImportingTsExtensions": true
  },
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts"
  ],
  "exclude": ["node_modules"]
}
```

## `.env.example`

```text
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_EXISTING_PUBLIC_KEY
GEMINI_API_KEY=YOUR_GOOGLE_AI_STUDIO_KEY
GEMINI_MODEL=gemini-3.8-flash
GEMINI_IMAGE_MODEL=gemini-nano-banana-2.1
```

## `.gitignore`

```text
node_modules/
.next/
.env*
!.env.example
*.tsbuildinfo
.vercel/
.DS_Store
```
