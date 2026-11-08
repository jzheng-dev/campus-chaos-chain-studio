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
