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
