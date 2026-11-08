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
