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
