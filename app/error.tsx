"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="error-page">
      <h1>Let’s reconnect.</h1>
      <p>
        Something interrupted the workspace. Check your connection and try
        again.
      </p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
      <a href="/">Back to sign in</a>
    </main>
  );
}
