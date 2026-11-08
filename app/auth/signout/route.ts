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
