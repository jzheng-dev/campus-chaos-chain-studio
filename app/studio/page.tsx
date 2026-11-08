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
