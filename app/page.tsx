import { redirect } from "next/navigation";
import { Workflow, LockKeyhole, ArrowDown, Sparkles } from "lucide-react";
import { configured, createClient } from "@/lib/supabase/server";
import LoginButton from "@/components/LoginButton";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const ready = configured();
  const params = await searchParams;
  let signedIn = false;
  if (ready) {
    const db = await createClient();
    const {
      data: { user },
    } = await db.auth.getUser();
    if (user) {
      signedIn = true;
      const { data: p } = await db
        .from("profiles")
        .select("is_superadmin")
        .eq("id", user.id)
        .single();
      if (p?.is_superadmin === true) redirect("/studio");
    }
  }
  return (
    <main className="login-page">
      <div className="login-brand">
        <span className="brand-icon">
          <Workflow size={22} />
        </span>
        CHAIN STUDIO <span className="brand-by">by Campus Chaos</span>
      </div>
      <div className="login-grid">
        <section>
          <div className="eyebrow">
            <span className="live-dot" /> YOUR IDEAS, IN MOTION
          </div>
          <h1>
            A little structure.
            <br />
            <em>A lot of possibility.</em>
          </h1>
          <p className="login-description">
            Turn a spark into a sequence. Build AI workflows that see, think,
            and create—one thoughtful prompt at a time.
          </p>
          <div className="login-access">
            <LockKeyhole size={16} />
            <span>
              For the people behind Campus Chaos. Superadmin access required.
            </span>
          </div>
          {!ready ? (
            <p className="notice error">
              Setup needed: add the Supabase environment variables, then restart
              or redeploy.
            </p>
          ) : signedIn ? (
            <>
              <p className="notice error">
                You’re signed in, but your profile doesn’t have superadmin
                access. Ask the project owner to check your account.
              </p>
              <form action="/auth/signout" method="post">
                <button className="button secondary">Sign out</button>
              </form>
            </>
          ) : (
            <LoginButton />
          )}
          {params.error && (
            <p className="error-text" role="alert">
              Sign-in didn’t finish. Try again and check the Supabase redirect
              URL.
            </p>
          )}
        </section>
        <div className="login-art" aria-hidden="true">
          <div className="orb orb-one" />
          <div className="orb orb-two" />
          <div className="mini-heading">
            FROM IDEA TO SOMETHING GOOD <Sparkles size={16} />
          </div>
          {[
            ["01", "See the unexpected", "Describe what’s in the image."],
            ["02", "Find the funny", "Give the moment a new perspective."],
            ["03", "Make it yours", "Create five captions worth sharing."],
          ].map(([n, title, text], i) => (
            <div key={n}>
              <div className={`sample-step sample-${i}`}>
                <span>{n}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{text}</p>
                </div>
                <span className="sample-dot" />
              </div>
              {i < 2 && <ArrowDown size={18} className="sample-arrow" />}
            </div>
          ))}
          <div className="sample-result">
            ✦ &nbsp; A good idea. A great chain reaction.
          </div>
        </div>
      </div>
      <footer className="login-footer">
        BUILT FOR EXPERIMENTATION. DESIGNED FOR POSSIBILITY.
      </footer>
    </main>
  );
}
