"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Workflow,
  Plus,
  Search,
  ChevronRight,
  ArrowUpRight,
  ArrowDown,
  ArrowUp,
  Trash2,
  Copy,
  Play,
  Save,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Sparkles,
  Layers,
  Clock3,
  ImagePlus,
  X,
  Check,
  LoaderCircle,
  RefreshCw,
  Download,
  FileText,
  Image as ImageIcon,
  GripVertical,
  ArrowLeft,
  AlertCircle,
} from "lucide-react";
import type { Chain, Step, Run, Output } from "@/lib/types";
import { newChain, newStep, starters } from "@/lib/starters";
import { validateChain } from "@/lib/validation";
type Theme = "light" | "dark" | "system";
async function api(path: string, init?: RequestInit) {
  const response = await fetch(path, { cache: "no-store", ...init });
  const data = await response
    .json()
    .catch(() => ({ error: "The server did not respond. Try again." }));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
const stamp = (date: string) =>
  new Date(date).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
function statusOf(run: Run) {
  return run.status === "running" &&
    Date.now() - new Date(run.created_at).getTime() > 300000
    ? "interrupted"
    : run.status;
}
export default function Studio({ name }: { name: string }) {
  const [chains, setChains] = useState<Chain[]>([]);
  const [draft, setDraft] = useState<Chain | null>(null);
  const [baseline, setBaseline] = useState("");
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [themeLoaded, setThemeLoaded] = useState(false);
  const [tab, setTab] = useState<"test" | "history">("test");
  const [input, setInput] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const dragIndex = useRef<number | null>(null);
  const requestSequence = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirty = draft !== null && JSON.stringify(draft) !== baseline;
  const locked = !!busy;
  const setClean = useCallback((chain: Chain | null) => {
    setDraft(chain);
    setBaseline(chain ? JSON.stringify(chain) : "");
  }, []);
  const refresh = useCallback(
    async (id: string | null, choose: boolean) => {
      const seq = ++requestSequence.current;
      const data = await api("/api/chains" + (id ? `?chain=${id}` : ""));
      if (seq !== requestSequence.current) return;
      setChains(data.chains);
      setRuns(data.runs);
      if (choose) setClean(data.chains.find((c: Chain) => c.id === id) || null);
    },
    [setClean],
  );
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api("/api/chains");
        if (cancelled) return;
        setChains(data.chains);
        if (data.chains[0]) {
          setClean(data.chains[0]);
          await refresh(data.chains[0].id, false);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setBusy("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, setClean]);
  useEffect(() => {
    let saved: Theme = "system";
    try {
      const value = localStorage.getItem("chain-studio-theme");
      if (value === "light" || value === "dark" || value === "system")
        saved = value;
    } catch {}
    setTheme(saved);
    setThemeLoaded(true);
  }, []);
  useEffect(() => {
    if (!themeLoaded) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("chain-studio-theme", theme);
    } catch {}
    return () => media.removeEventListener("change", apply);
  }, [theme, themeLoaded]);
  useEffect(() => {
    if (!image) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(image);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  useEffect(() => {
    const prevent = (e: BeforeUnloadEvent) => {
      if (dirty || busy === "running") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty, busy]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const canLeave = () => !dirty || confirm("Discard your unsaved changes?");
  async function choose(chain: Chain) {
    if (locked || chain.id === draft?.id || !canLeave()) return;
    setError("");
    setSelectedRun(null);
    setBusy("loading");
    try {
      await refresh(chain.id, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function create(index?: number) {
    if (locked || !canLeave()) return;
    setDraft(newChain(index));
    setBaseline("");
    setRuns([]);
    setSelectedRun(null);
    setInput("");
    setImage(null);
    setTab("test");
    setError("");
  }
  function patchStep(id: string, patch: Partial<Step>) {
    setDraft((d) =>
      d
        ? {
            ...d,
            steps: d.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
          }
        : d,
    );
  }
  function move(from: number, to: number) {
    if (!draft || locked || to < 0 || to >= draft.steps.length) return;
    const steps = [...draft.steps];
    const [step] = steps.splice(from, 1);
    steps.splice(to, 0, step);
    setDraft({ ...draft, steps });
  }
  async function save() {
    if (!draft || locked) return;
    setError("");
    try {
      validateChain(draft);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setBusy("saving");
    try {
      const saved = await api("/api/chains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      await refresh(saved.id, true);
      setNotice("Chain saved. Ready when you are.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  async function remove() {
    if (
      !draft?.id ||
      locked ||
      !confirm(
        `Delete “${draft.name}”? Its steps and mix entries will also be removed. Saved run records are retained.`,
      )
    )
      return;
    setBusy("deleting");
    setError("");
    try {
      await api("/api/chains", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: draft.id,
          studio_version: draft.studio_version,
        }),
      });
      setClean(null);
      setSelectedRun(null);
      await refresh(null, false);
      setNotice("Chain deleted.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function run() {
    if (!draft?.id || locked || dirty) return;
    setBusy("running");
    setError("");
    setTab("test");
    setSelectedRun(null);
    try {
      const form = new FormData();
      form.set("chain_id", draft.id);
      form.set("version", String(draft.studio_version));
      form.set("input", input);
      if (image) form.set("image", image);
      const result = await api("/api/runs", { method: "POST", body: form });
      await refresh(draft.id, false);
      setSelectedRun(result.id);
      setNotice("Your chain has a new result.");
    } catch (e) {
      setError((e as Error).message);
      try {
        await refresh(draft.id, false);
      } catch {
        /* Keep the original error. */
      }
    } finally {
      setBusy("");
    }
  }
  async function reload() {
    if (locked || !canLeave()) return;
    setBusy("loading");
    setError("");
    try {
      await refresh(draft?.id || null, true);
      setNotice("Workspace refreshed.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function upload(file?: File) {
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 2 * 1024 * 1024
    ) {
      setError("Choose a PNG, JPEG, or WebP image smaller than 2 MB.");
      return;
    }
    setImage(file);
    setError("");
  }
  const current = runs.find((r) => r.id === selectedRun) || runs[0];
  const filtered = chains.filter((c) =>
    `${c.name} ${c.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  const stats = [
    { label: "Saved chains", value: chains.length, icon: Layers },
    {
      label: "Steps in this chain",
      value: draft?.steps.length || 0,
      icon: Workflow,
    },
    {
      label: "Recent completed runs",
      value: runs.filter((r) => r.status === "completed").length,
      icon: Sparkles,
    },
  ];
  return (
    <div className="studio-shell">
      <aside className="sidebar">
        <a className="brand" href="/studio">
          <span className="brand-icon">
            <Workflow size={22} />
          </span>
          <span>
            chain<span className="brand-soft">studio</span>
            <small>CAMPUS CHAOS / WORKSPACE</small>
          </span>
        </a>
        <div className="sidebar-heading">
          <span>YOUR WORKSPACE</span>
          <span className="tiny-pill">01</span>
        </div>
        <div className="sidebar-active">
          <Layers size={17} />
          Prompt chains
          <ChevronRight size={15} />
        </div>
        <div className="library-heading">
          <span>CHAIN LIBRARY</span>
          <span>{chains.length.toString().padStart(2, "0")}</span>
        </div>
        <label className="search-box">
          <Search size={15} />
          <input
            aria-label="Search chains"
            placeholder="Find a chain…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <nav className="chain-nav" aria-label="Prompt chains">
          {filtered.map((c) => (
            <button
              key={c.id}
              className={`chain-link ${c.id === draft?.id ? "selected" : ""}`}
              disabled={locked}
              onClick={() => void choose(c)}
            >
              <span className="chain-glyph">
                <Workflow size={15} />
              </span>
              <span>
                {c.name}
                <small>
                  {c.steps.length} {c.steps.length === 1 ? "step" : "steps"}
                </small>
              </span>
              {c.id === draft?.id && <span className="selected-dot" />}
            </button>
          ))}
          {!filtered.length && (
            <p className="sidebar-empty">
              {query
                ? "No chains match your search."
                : "Your next idea starts here."}
            </p>
          )}
        </nav>
        <button
          className="sidebar-new"
          disabled={locked}
          onClick={() => create()}
        >
          <Plus size={16} />
          New prompt chain
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="small-spark">✦</span>
            <p>
              Small steps.
              <br />
              <strong>Interesting possibilities.</strong>
            </p>
          </div>
          <div className="account-row">
            <span className="avatar">{name.charAt(0).toUpperCase()}</span>
            <div>
              <strong>{name}</strong>
              <small>Superadmin</small>
            </div>
            <form
              action="/auth/signout"
              method="post"
              onSubmit={(e) => {
                if (locked || !canLeave()) e.preventDefault();
              }}
            >
              <button
                title="Sign out"
                aria-label="Sign out"
                className="icon-button"
                disabled={locked}
              >
                <LogOut size={16} />
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>Prompt chains</strong>
          </div>
          <div className="topbar-right">
            <span className="access-pill">
              <span className="live-dot" /> SUPERADMIN
            </span>
            <div className="theme-picker" aria-label="Color theme">
              {(
                [
                  { value: "light", label: "Light", icon: Sun },
                  { value: "dark", label: "Dark", icon: Moon },
                  { value: "system", label: "System", icon: Monitor },
                ] as const
              ).map(({ value, label, icon: Icon }) => (
                <button
                  key={value}
                  title={`${label} theme`}
                  aria-label={`${label} theme`}
                  aria-pressed={theme === value}
                  className={theme === value ? "active" : ""}
                  onClick={() => setTheme(value)}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
            <form
              className="mobile-signout"
              action="/auth/signout"
              method="post"
              onSubmit={(e) => {
                if (locked || !canLeave()) e.preventDefault();
              }}
            >
              <button
                className="icon-button"
                aria-label="Sign out"
                disabled={locked}
              >
                <LogOut size={16} />
              </button>
            </form>
          </div>
        </header>
        <main className="main-content">
          <section className="page-intro">
            <div>
              <div className="eyebrow">
                <span />
                THE CREATIVE ENGINE
              </div>
              <h1>
                Good ideas have <em>great next steps.</em>
              </h1>
              <p>
                A space to connect prompts, explore possibilities, and make
                something unexpected.
              </p>
            </div>
            <button
              className="button primary new-top"
              disabled={locked}
              onClick={() => create()}
            >
              <Plus size={17} />
              New chain
            </button>
          </section>
          <div className="stats-grid">
            {stats.map(({ label, value, icon: Icon }) => (
              <div className="stat-card" key={label}>
                <div>
                  <span>{label}</span>
                  <strong>
                    {busy === "loading" ? "—" : String(value).padStart(2, "0")}
                  </strong>
                </div>
                <span className="stat-icon">
                  <Icon size={20} />
                </span>
              </div>
            ))}
          </div>
          {error && (
            <div className="notice error" role="alert">
              <AlertCircle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                onClick={() => setError("")}
                aria-label="Dismiss error"
              >
                <X size={16} />
              </button>
            </div>
          )}
          {busy === "loading" && !draft ? (
            <div className="loading-state">
              <LoaderCircle className="spin" />
              Opening your workspace…
            </div>
          ) : !draft ? (
            <section className="empty-workspace">
              <span className="empty-orbit">
                <Workflow size={36} />
              </span>
              <div className="eyebrow">A BLANK CANVAS. A HEAD START.</div>
              <h2>What will your first chain create?</h2>
              <p>
                Start from scratch, or borrow a little momentum from a starter.
              </p>
              <button
                className="button primary"
                disabled={locked}
                onClick={() => create()}
              >
                <Plus size={17} />
                Build a blank chain
              </button>
              <div className="starter-grid">
                {starters.map((s, i) => (
                  <button
                    className="starter-card"
                    key={s.name}
                    disabled={locked}
                    onClick={() => create(i)}
                  >
                    <span>
                      0{i + 1}
                      <ArrowUpRight size={18} />
                    </span>
                    <h3>{s.name}</h3>
                    <p>{s.description}</p>
                    <small>
                      {s.steps.length} STEPS ·{" "}
                      {i === 1 ? "IMAGE OUTPUT" : "TEXT OUTPUT"}
                    </small>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="editor-grid">
              <section className="editor-column">
                <div className="section-label">
                  <span>
                    <span className="label-number">01</span>BUILD YOUR CHAIN
                  </span>
                  <div className="editor-actions">
                    <span className={`save-status ${dirty ? "unsaved" : ""}`}>
                      <span />
                      {dirty ? "Unsaved changes" : "All changes saved"}
                    </span>
                    <button
                      className="icon-button"
                      title="Reload saved chain"
                      aria-label="Reload saved chain"
                      disabled={locked}
                      onClick={() => void reload()}
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                </div>
                <div className="chain-details panel">
                  <div className="details-top">
                    <span className="tag">
                      {draft.id ? "PROMPT CHAIN" : "NEW PROMPT CHAIN"}
                    </span>
                    <div className="editor-actions">
                      <details className="template-menu">
                        <summary>
                          Use a starter <ChevronRight size={13} />
                        </summary>
                        <div>
                          {starters.map((s, i) => (
                            <button
                              key={s.name}
                              disabled={locked}
                              onClick={(e) => {
                                e.currentTarget
                                  .closest("details")
                                  ?.removeAttribute("open");
                                create(i);
                              }}
                            >
                              {s.name}
                              <ArrowUpRight size={14} />
                            </button>
                          ))}
                        </div>
                      </details>
                      {draft.id && (
                        <button
                          className="icon-button danger"
                          disabled={locked}
                          title="Delete chain"
                          aria-label="Delete chain"
                          onClick={() => void remove()}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>
                  <label className="sr-only" htmlFor="chain-name">
                    Chain name
                  </label>
                  <input
                    id="chain-name"
                    className="chain-name"
                    maxLength={120}
                    disabled={locked}
                    value={draft.name}
                    onChange={(e) =>
                      setDraft({ ...draft, name: e.target.value })
                    }
                    placeholder="Give your idea a name"
                  />
                  <label className="sr-only" htmlFor="chain-description">
                    Chain description
                  </label>
                  <textarea
                    id="chain-description"
                    className="chain-description"
                    maxLength={2000}
                    rows={2}
                    disabled={locked}
                    value={draft.description || ""}
                    onChange={(e) =>
                      setDraft({ ...draft, description: e.target.value })
                    }
                    placeholder="What should this chain make possible?"
                  />
                  <div className="details-meta">
                    <Workflow size={13} />
                    {draft.steps.length} steps<span>·</span>
                    <span>
                      {draft.id ? `Version ${draft.studio_version}` : "Draft"}
                    </span>
                  </div>
                </div>
                <div className="step-list">
                  {draft.steps.map((step, i) => (
                    <div className="step-wrap" key={step.id}>
                      {i > 0 && (
                        <div className="step-connector">
                          <ArrowDown size={14} />
                        </div>
                      )}
                      <article
                        className="step-card panel"
                        onDragOver={(e) => {
                          if (dragIndex.current !== null) e.preventDefault();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          if (dragIndex.current !== null)
                            move(dragIndex.current, i);
                          dragIndex.current = null;
                        }}
                      >
                        <header className="step-header">
                          <div className="step-identity">
                            <button
                              className="drag-handle icon-button"
                              draggable={!locked}
                              disabled={locked}
                              title="Drag to reorder, or use the arrow buttons"
                              aria-label={`Drag step ${i + 1} to reorder`}
                              onDragStart={(e) => {
                                dragIndex.current = i;
                                e.dataTransfer.effectAllowed = "move";
                                e.dataTransfer.setData("text/plain", String(i));
                              }}
                              onDragEnd={() => (dragIndex.current = null)}
                            >
                              <GripVertical size={16} />
                            </button>
                            <span className="step-number">
                              {String(i + 1).padStart(2, "0")}
                            </span>
                            <input
                              aria-label={`Step ${i + 1} title`}
                              maxLength={100}
                              disabled={locked}
                              value={step.title}
                              placeholder={`Step ${i + 1}`}
                              onChange={(e) =>
                                patchStep(step.id, { title: e.target.value })
                              }
                            />
                          </div>
                          <div className="step-actions">
                            <button
                              className="icon-button"
                              title="Move up"
                              aria-label={`Move step ${i + 1} up`}
                              disabled={locked || i === 0}
                              onClick={() => move(i, i - 1)}
                            >
                              <ArrowUp size={14} />
                            </button>
                            <button
                              className="icon-button"
                              title="Move down"
                              aria-label={`Move step ${i + 1} down`}
                              disabled={locked || i === draft.steps.length - 1}
                              onClick={() => move(i, i + 1)}
                            >
                              <ArrowDown size={14} />
                            </button>
                            <button
                              className="icon-button"
                              title="Duplicate step"
                              aria-label={`Duplicate step ${i + 1}`}
                              disabled={locked || draft.steps.length >= 12}
                              onClick={() => {
                                const steps = [...draft.steps];
                                steps.splice(i + 1, 0, {
                                  ...step,
                                  id: crypto.randomUUID(),
                                  output_type: "text",
                                });
                                setDraft({ ...draft, steps });
                              }}
                            >
                              <Copy size={14} />
                            </button>
                            <button
                              className="icon-button danger"
                              title="Delete step"
                              aria-label={`Delete step ${i + 1}`}
                              disabled={locked}
                              onClick={() =>
                                setDraft({
                                  ...draft,
                                  steps: draft.steps.filter(
                                    (s) => s.id !== step.id,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </header>
                        <div className="step-body">
                          <label htmlFor={`prompt-${step.id}`}>PROMPT</label>
                          <textarea
                            id={`prompt-${step.id}`}
                            disabled={locked}
                            rows={5}
                            maxLength={20000}
                            value={step.prompt_template}
                            onChange={(e) =>
                              patchStep(step.id, {
                                prompt_template: e.target.value,
                              })
                            }
                            placeholder={
                              i === 0
                                ? "Describe what you want the AI to do with {{input}}…"
                                : "Build on {{previous}} to take the next step…"
                            }
                          />
                          <div className="step-bottom">
                            <div
                              className="variable-chips"
                              aria-label="Insert a prompt variable"
                            >
                              {[
                                "input",
                                "previous",
                                ...(i > 0 ? [`step_${i}`] : []),
                              ].map((v) => (
                                <button
                                  key={v}
                                  disabled={locked}
                                  title={`Insert {{${v}}}`}
                                  onClick={() => {
                                    const field = document.getElementById(
                                      `prompt-${step.id}`,
                                    ) as HTMLTextAreaElement | null;
                                    const start =
                                      field?.selectionStart ??
                                      step.prompt_template.length;
                                    const end = field?.selectionEnd ?? start;
                                    const token = `{{${v}}}`;
                                    patchStep(step.id, {
                                      prompt_template:
                                        step.prompt_template.slice(0, start) +
                                        token +
                                        step.prompt_template.slice(end),
                                    });
                                    requestAnimationFrame(() => {
                                      field?.focus();
                                      field?.setSelectionRange(
                                        start + token.length,
                                        start + token.length,
                                      );
                                    });
                                  }}
                                >{`{{${v}}}`}</button>
                              ))}
                            </div>
                            <label className="output-select">
                              <span className="sr-only">
                                Step {i + 1} output type
                              </span>
                              {step.output_type === "image" ? (
                                <ImageIcon size={13} />
                              ) : (
                                <FileText size={13} />
                              )}
                              <select
                                aria-label={`Step ${i + 1} output type`}
                                disabled={locked}
                                value={step.output_type}
                                onChange={(e) =>
                                  patchStep(step.id, {
                                    output_type: e.target
                                      .value as Step["output_type"],
                                  })
                                }
                              >
                                <option value="text">Text output</option>
                                <option
                                  value="image"
                                  disabled={i !== draft.steps.length - 1}
                                >
                                  Image output
                                </option>
                              </select>
                            </label>
                          </div>
                        </div>
                      </article>
                    </div>
                  ))}
                </div>
                <button
                  className="add-step"
                  disabled={locked || draft.steps.length >= 12}
                  onClick={() =>
                    setDraft({ ...draft, steps: [...draft.steps, newStep()] })
                  }
                >
                  <Plus size={17} />
                  {draft.steps.length >= 12
                    ? "12-step limit reached"
                    : "Add another step"}
                  <span>KEEP THE IDEA MOVING</span>
                </button>
                <div className="variable-note">
                  <Sparkles size={15} />
                  <p>
                    <code>{"{{input}}"}</code> is your original text.{" "}
                    <code>{"{{previous}}"}</code> is the last result (or input
                    on step 1). Use <code>{"{{step_1}}"}</code> to reference a
                    specific earlier step. Your uploaded image accompanies every
                    step.
                  </p>
                </div>
                <div className="save-bar">
                  <span>
                    {dirty
                      ? "A little progress, ready to save."
                      : "Your chain is ready for its next idea."}
                  </span>
                  <button
                    className="button primary"
                    disabled={locked || !dirty}
                    onClick={() => void save()}
                  >
                    {busy === "saving" ? (
                      <LoaderCircle size={16} className="spin" />
                    ) : (
                      <Save size={16} />
                    )}
                    Save chain<span className="key-hint">⌘ S</span>
                  </button>
                </div>
              </section>
              <aside className="test-column">
                <div className="section-label">
                  <span>
                    <span className="label-number">02</span>SEE WHAT HAPPENS
                  </span>
                  <span className="small-muted">PLAY. REFINE. REPEAT.</span>
                </div>
                <div className="test-panel panel">
                  <div className="panel-tabs">
                    <button
                      className={tab === "test" ? "active" : ""}
                      onClick={() => setTab("test")}
                    >
                      <Play size={14} />
                      Test run
                    </button>
                    <button
                      className={tab === "history" ? "active" : ""}
                      onClick={() => setTab("history")}
                    >
                      <Clock3 size={14} />
                      History<span>{runs.length}</span>
                    </button>
                  </div>
                  {tab === "test" ? (
                    <>
                      <div className="test-intro">
                        <h2>
                          A spark goes in.
                          <br />
                          <em>Something new comes out.</em>
                        </h2>
                        <p>Give your chain a starting point.</p>
                      </div>
                      <div className="test-form">
                        <label htmlFor="test-input">YOUR INPUT</label>
                        <textarea
                          id="test-input"
                          disabled={busy === "running"}
                          maxLength={10000}
                          rows={4}
                          placeholder="A campus moment, a half-formed idea, an unexpected observation…"
                          value={input}
                          onChange={(e) => setInput(e.target.value)}
                        />
                        <input
                          aria-label="Upload input image"
                          ref={fileRef}
                          className="sr-only"
                          type="file"
                          accept="image/png,image/jpeg,image/webp"
                          disabled={busy === "running"}
                          onChange={(e) => {
                            upload(e.target.files?.[0]);
                            e.target.value = "";
                          }}
                        />
                        {image ? (
                          <div className="upload-preview">
                            {preview && (
                              <img src={preview} alt="Your uploaded input" />
                            )}
                            <div>
                              <strong>{image.name}</strong>
                              <small>{Math.round(image.size / 1024)} KB</small>
                            </div>
                            <button
                              className="icon-button"
                              disabled={busy === "running"}
                              aria-label="Remove uploaded image"
                              onClick={() => setImage(null)}
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ) : (
                          <button
                            className="upload-zone"
                            disabled={busy === "running"}
                            onClick={() => fileRef.current?.click()}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              if (busy !== "running")
                                upload(e.dataTransfer.files[0]);
                            }}
                          >
                            <ImagePlus size={22} />
                            <span>
                              Add an image
                              <small>
                                Drop it here, or click to browse · up to 2 MB
                              </small>
                            </span>
                            <Plus size={16} />
                          </button>
                        )}
                        <button
                          className="button primary run-button"
                          disabled={
                            locked ||
                            dirty ||
                            !draft.id ||
                            !draft.steps.length ||
                            (!input.trim() && !image)
                          }
                          onClick={() => void run()}
                        >
                          {busy === "running" ? (
                            <LoaderCircle size={17} className="spin" />
                          ) : (
                            <Play size={16} fill="currentColor" />
                          )}
                          {busy === "running"
                            ? "Your chain is working…"
                            : "Run chain"}
                          {busy !== "running" && <ArrowUpRight size={17} />}
                        </button>
                        <p className="run-hint">
                          {dirty
                            ? "Save your changes to run this version."
                            : !draft.steps.length
                              ? "Add a step, then save your chain."
                              : "Runs use your saved chain and Gemini API quota."}
                        </p>
                      </div>
                    </>
                  ) : (
                    <div className="history-list">
                      <div className="history-heading">
                        <span>Last 50 runs for this chain</span>
                        <button
                          className="icon-button"
                          disabled={locked}
                          title="Refresh history and image links"
                          aria-label="Refresh history"
                          onClick={async () => {
                            setBusy("loading");
                            try {
                              await refresh(draft.id, false);
                            } catch (e) {
                              setError((e as Error).message);
                            } finally {
                              setBusy("");
                            }
                          }}
                        >
                          <RefreshCw size={14} />
                        </button>
                      </div>
                      {runs.length ? (
                        runs.map((r) => (
                          <button
                            className={`history-item ${current?.id === r.id ? "active" : ""}`}
                            key={r.id}
                            onClick={() => {
                              setSelectedRun(r.id);
                              setTab("test");
                            }}
                          >
                            <span className={`run-state ${statusOf(r)}`}>
                              {statusOf(r) === "completed" ? (
                                <Check size={15} />
                              ) : statusOf(r) === "running" ? (
                                <LoaderCircle size={15} />
                              ) : (
                                <AlertCircle size={15} />
                              )}
                            </span>
                            <span>
                              <strong>{r.input_text || "Image input"}</strong>
                              <small>
                                {stamp(r.created_at)} · v{r.chain_version}
                              </small>
                            </span>
                            <ChevronRight size={14} />
                          </button>
                        ))
                      ) : (
                        <div className="mini-empty">
                          <Clock3 size={26} />
                          <p>A clean slate.</p>
                          <small>Your saved runs will appear here.</small>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {busy === "running" ? (
                  <div className="running-card">
                    <span className="running-orbit">
                      <Sparkles size={25} />
                    </span>
                    <h3>Connecting the dots…</h3>
                    <p>
                      Running each saved step in sequence.
                      <br />
                      Keep this tab open while your ideas take shape.
                    </p>
                    <div className="progress-track">
                      <span />
                    </div>
                  </div>
                ) : current ? (
                  <Result
                    run={current}
                    onCopy={() => setNotice("Copied to clipboard.")}
                    onError={setError}
                  />
                ) : (
                  <div className="result-placeholder">
                    <span className="result-star">✳</span>
                    <h3>Room for a little magic.</h3>
                    <p>
                      Your results will land here.
                      <br />
                      Let’s see where this chain takes you.
                    </p>
                    <span className="dotted-line" />
                  </div>
                )}
              </aside>
            </div>
          )}
          <footer className="workspace-footer">
            <span>
              CHAIN STUDIO <span>✦</span> MADE FOR WHAT’S NEXT
            </span>
            <span>Campus Chaos / Creative tools</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={17} />
          {notice}
        </div>
      )}
    </div>
  );
}
function Result({
  run,
  onCopy,
  onError,
}: {
  run: Run;
  onCopy: () => void;
  onError: (message: string) => void;
}) {
  const final = run.outputs.at(-1);
  const state = statusOf(run);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      onCopy();
    } catch {
      onError(
        "Copy wasn’t available. You can select and copy the result manually.",
      );
    }
  }
  async function download(output: Output) {
    try {
      let blob: Blob;
      if (output.type === "image") {
        if (!output.url)
          throw new Error("Refresh history to renew this image link.");
        const response = await fetch(output.url);
        if (!response.ok)
          throw new Error(
            "The image link expired. Refresh history to renew it.",
          );
        blob = await response.blob();
      } else blob = new Blob([output.text], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `chain-studio-${run.id.slice(0, 8)}.${output.type === "image" ? (blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png") : "txt"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError((e as Error).message);
    }
  }
  return (
    <div className="result-card panel">
      <div className="result-heading">
        <span>
          <Sparkles size={15} />
          {state === "completed" ? "THE CHAIN REACTION" : "RUN DETAILS"}
        </span>
        <span className={`status-badge ${state}`}>{state}</span>
      </div>
      <div className="result-meta">
        {stamp(run.created_at)}
        <span>·</span>Version {run.chain_version}
        <span>·</span>
        {run.outputs.length}/{run.steps_snapshot.length} steps
      </div>
      {run.error && (
        <p className="inline-error" role="alert">
          {run.error}
        </p>
      )}
      {state === "interrupted" && (
        <p className="inline-error">
          This run was interrupted before its status was saved. Check your
          Vercel function logs, then start a new run.
        </p>
      )}
      {state === "running" && (
        <p className="small-muted">
          A run is still marked as running. Wait, then refresh History. Runs can
          take up to four minutes.
        </p>
      )}
      {final && (
        <div className="final-output">
          <div className="final-title">
            <strong>
              {state === "completed" ? "Final output" : "Last completed step"}
            </strong>
            <div className="editor-actions">
              {final.text && (
                <button
                  className="icon-button"
                  title="Copy result"
                  aria-label="Copy result"
                  onClick={() => void copy(final.text)}
                >
                  <Copy size={14} />
                </button>
              )}
              <button
                className="icon-button"
                title="Download result"
                aria-label="Download result"
                onClick={() => void download(final)}
              >
                <Download size={15} />
              </button>
            </div>
          </div>
          {final.type === "image" && final.url && (
            <img
              className="generated-image"
              src={final.url}
              alt={final.text || "Image generated by your prompt chain"}
              onError={(e) => {
                e.currentTarget.style.display = "none";
                onError(
                  "The image couldn’t load. Refresh History to renew the link.",
                );
              }}
            />
          )}
          {final.type === "image" && !final.url && (
            <p className="small-muted">
              Refresh History to load the generated image.
            </p>
          )}
          {final.text && <div className="output-text">{final.text}</div>}
        </div>
      )}
      <details className="run-input">
        <summary>Original input {run.had_image && "· image attached"}</summary>
        <p>
          {run.input_text ||
            "Image only. Input images are sent to Gemini for this run and are not saved in history."}
        </p>
      </details>
      <div className="trace-heading">FOLLOW THE THREAD</div>
      {run.outputs.map((o, i) => (
        <details className="output-trace" key={o.step_id}>
          <summary>
            <span className="trace-number">
              {String(i + 1).padStart(2, "0")}
            </span>
            <strong>{o.title}</strong>
            <span>{(o.duration_ms / 1000).toFixed(1)}s</span>
            <ChevronRight size={14} />
          </summary>
          <div>
            <p className="model-label">
              {o.model} · {o.type} output
            </p>
            <p className="output-text">
              {o.text || "Image generated—see the final output above."}
            </p>
            <details className="snapshot-prompt">
              <summary>Prompt used in this run</summary>
              <p>{run.steps_snapshot[i]?.prompt_template}</p>
            </details>
          </div>
        </details>
      ))}
    </div>
  );
}
