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
