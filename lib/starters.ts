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
