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
