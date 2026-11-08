import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
const admin = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  member = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const step1 = "11111111-1111-4111-8111-111111111111",
  step2 = "22222222-2222-4222-8222-222222222222";
test("database enforces admin access, atomic ordering, conflicts, snapshots, and retained history", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role authenticated;create role anon;create schema auth;create schema storage;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table auth.users(id uuid primary key);
 create table public.profiles(id uuid primary key references auth.users(id),is_superadmin boolean not null default false);
 create table public.prompt_chains(id uuid primary key default gen_random_uuid(),name text not null,description text,created_at timestamptz default now());
 create table public.prompt_chain_steps(id uuid primary key default gen_random_uuid(),prompt_chain_id uuid references public.prompt_chains(id),step_number integer not null default 1 check(step_number>0),prompt_template text not null,created_at timestamptz default now(),unique(prompt_chain_id,step_number));
 create table public.prompt_chain_mix(id uuid primary key default gen_random_uuid(),prompt_chain_id uuid references public.prompt_chains(id));
 create table public.generation_requests(id uuid primary key default gen_random_uuid(),user_id uuid,prompt text,status text default 'pending',created_at timestamptz default now());
 create table public.llm_responses(id uuid primary key default gen_random_uuid(),generation_request_id uuid,model_id uuid,response_text text,created_at timestamptz default now());
 create table public.ai_generated_media(id uuid primary key default gen_random_uuid(),generation_request_id uuid,media_url text,media_type text,description text,created_at timestamptz default now());
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid primary key,bucket_id text);alter table storage.objects enable row level security;
 insert into auth.users values('${admin}'),('${member}');insert into profiles values('${admin}',true),('${member}',false);`);
    const setup = readFileSync(
      new URL("../supabase/setup.sql", import.meta.url),
      "utf8",
    );
    await db.exec(setup);
    await db.exec(setup);
    await db.exec("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      member,
    ]);
    await assert.rejects(
      () => db.query("select public.chain_studio_list()"),
      /Superadmin/,
    );
    await assert.rejects(
      () => db.query("select public.chain_studio_save('{}'::jsonb)"),
      /Superadmin/,
    );
    await assert.rejects(
      () => db.query("select public.chain_studio_delete($1,1)", [step1]),
      /Superadmin/,
    );
    await assert.rejects(
      () =>
        db.query(
          "select public.chain_studio_start_run($1,$2,1,'input',false)",
          [step1, step2],
        ),
      /Superadmin/,
    );
    await assert.rejects(
      () =>
        db.query("select public.chain_studio_finish_run($1,'[]'::jsonb,null)", [
          step1,
        ]),
      /Superadmin/,
    );
    await assert.rejects(
      () => db.query("select * from public.chain_studio_runs"),
      /permission denied/,
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      admin,
    ]);
    const save = async (c: unknown) =>
      (
        await db.query<{ v: { id: string; studio_version: number } }>(
          "select public.chain_studio_save($1::jsonb) as v",
          [JSON.stringify(c)],
        )
      ).rows[0].v;
    const list = async (id: string) =>
      (
        await db.query<{ v: { chains: any[]; runs: any[] } }>(
          "select public.chain_studio_list($1) as v",
          [id],
        )
      ).rows[0].v;
    const steps = [
      {
        id: step1,
        title: "First",
        prompt_template: "{{input}}",
        output_type: "text",
      },
      {
        id: step2,
        title: "Second",
        prompt_template: "{{previous}}",
        output_type: "text",
      },
    ];
    const saved = await save({
      id: null,
      name: "Original",
      description: "",
      studio_version: 0,
      steps,
    });
    assert.equal(saved.studio_version, 1);
    let data = await list(saved.id);
    assert.deepEqual(
      data.chains[0].steps.map((s: { id: string }) => s.id),
      [step1, step2],
    );
    await save({
      id: saved.id,
      name: "Reordered",
      description: "",
      studio_version: 1,
      steps: [steps[1], steps[0]],
    });
    data = await list(saved.id);
    assert.deepEqual(
      data.chains[0].steps.map((s: { id: string }) => s.id),
      [step2, step1],
    );
    await assert.rejects(
      () =>
        save({
          id: saved.id,
          name: "Stale",
          description: "",
          studio_version: 1,
          steps,
        }),
      /another tab/,
    );
    const runId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await db.query(
      "select public.chain_studio_start_run($1,$2,2,'test input',false)",
      [runId, saved.id],
    );
    await save({
      id: saved.id,
      name: "Changed later",
      description: "",
      studio_version: 2,
      steps: [steps[0]],
    });
    data = await list(saved.id);
    assert.equal(data.runs[0].chain_name, "Reordered");
    assert.equal(data.runs[0].steps_snapshot.length, 2);
    assert.equal(data.chains[0].steps.length, 1);
    await db.query("select public.chain_studio_finish_run($1,$2::jsonb,null)", [
      runId,
      JSON.stringify([
        {
          step_id: step2,
          title: "Output",
          type: "text",
          text: "A real result",
          duration_ms: 100,
          model: "test-model",
        },
      ]),
    ]);
    data = await list(saved.id);
    assert.equal(data.runs[0].status, "completed");
    await assert.rejects(
      () =>
        db.query("select public.chain_studio_finish_run($1,'[]'::jsonb,null)", [
          runId,
        ]),
      /already finalized/,
    );
    const foreign = await save({
      id: null,
      name: "Other",
      description: "",
      studio_version: 0,
      steps: [],
    });
    await assert.rejects(
      () =>
        save({
          id: foreign.id,
          name: "Other",
          description: "",
          studio_version: 1,
          steps: [steps[0]],
        }),
      /another chain/,
    );
    await db.exec("reset role");
    assert.equal(
      (
        await db.query<{ description: string }>(
          "select description from ai_generated_media",
        )
      ).rows[0].description,
      "A real result",
    );
    await db.query("insert into prompt_chain_mix(prompt_chain_id) values($1)", [
      saved.id,
    ]);
    await db.exec("set role authenticated");
    await db.query("select public.chain_studio_delete($1,3)", [saved.id]);
    await db.exec("reset role");
    const retained = (
      await db.query<{ prompt_chain_id: string | null; chain_name: string }>(
        "select prompt_chain_id,chain_name from chain_studio_runs",
      )
    ).rows[0];
    assert.equal(retained.prompt_chain_id, null);
    assert.equal(retained.chain_name, "Reordered");
    assert.equal(
      (await db.query("select * from prompt_chain_steps")).rows.length,
      0,
    );
  } finally {
    await db.close();
  }
});
