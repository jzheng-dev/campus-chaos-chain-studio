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
