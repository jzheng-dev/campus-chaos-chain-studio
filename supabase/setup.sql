-- Chain Studio: additive setup for Jessica's existing Design for Gen AI database.
-- Run the WHOLE file once in the existing project's SQL Editor.
-- No existing table, record, or policy is deleted or replaced.
begin;

alter table public.prompt_chains add column if not exists studio_version integer not null default 1;
alter table public.prompt_chain_steps add column if not exists title text not null default '';
alter table public.prompt_chain_steps add column if not exists output_type text not null default 'text';

create table if not exists public.chain_studio_runs (
  id uuid primary key,
  prompt_chain_id uuid references public.prompt_chains(id) on delete set null,
  generation_request_id uuid references public.generation_requests(id) on delete set null,
  user_id uuid not null references auth.users(id),
  chain_name text not null,
  chain_version integer not null,
  input_text text not null,
  had_image boolean not null default false,
  steps_snapshot jsonb not null,
  outputs jsonb not null default '[]',
  status text not null default 'running' check (status in ('running','completed','failed')),
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists chain_studio_runs_chain_created on public.chain_studio_runs(prompt_chain_id,created_at desc);
alter table public.chain_studio_runs enable row level security;

create or replace function public.chain_studio_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id=auth.uid() and is_superadmin=true);
$$;
revoke all on function public.chain_studio_is_admin() from public;
grant execute on function public.chain_studio_is_admin() to authenticated;

create or replace function public.chain_studio_list(p_chain_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select jsonb_build_object(
    'chains',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('steps',coalesce(
      (select jsonb_agg(to_jsonb(s) order by s.step_number,s.created_at,s.id) from public.prompt_chain_steps s where s.prompt_chain_id=c.id),'[]'::jsonb)) order by c.created_at desc) from public.prompt_chains c),'[]'::jsonb),
    'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from
      (select * from public.chain_studio_runs where prompt_chain_id=p_chain_id order by created_at desc limit 50) r),'[]'::jsonb)
  ) into result;
  return result;
end; $$;

create or replace function public.chain_studio_save(p_chain jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cid uuid; current_version integer; s jsonb; position integer:=0; step_ids uuid[]:='{}';
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  if length(trim(coalesce(p_chain->>'name','')))=0 or length(p_chain->>'name')>120 then raise exception 'Use a chain name between 1 and 120 characters'; end if;
  if jsonb_typeof(p_chain->'steps') is distinct from 'array' then raise exception 'Steps must be an array'; end if;
  if jsonb_array_length(p_chain->'steps')>12 then raise exception 'Maximum 12 steps'; end if;
  cid := (p_chain->>'id')::uuid;
  if cid is null then
    insert into public.prompt_chains(name,description) values(trim(p_chain->>'name'),coalesce(p_chain->>'description','')) returning id,studio_version into cid,current_version;
  else
    select studio_version into current_version from public.prompt_chains where id=cid for update;
    if not found then raise exception 'Chain not found'; end if;
    if current_version is distinct from (p_chain->>'studio_version')::integer then raise exception 'This chain changed in another tab. Reload before saving.' using errcode='40001'; end if;
    update public.prompt_chains set name=trim(p_chain->>'name'), description=coalesce(p_chain->>'description',''),studio_version=studio_version+1 where id=cid returning studio_version into current_version;
  end if;
  -- Park old positions so swapping steps also works with unique(chain_id,step_number).
  update public.prompt_chain_steps set step_number=step_number+1000000 where prompt_chain_id=cid;
  for s in select value from jsonb_array_elements(p_chain->'steps') loop
    position:=position+1;
    if length(trim(coalesce(s->>'prompt_template','')))=0 or length(s->>'prompt_template')>20000 then raise exception 'Every step needs a prompt, maximum 20,000 characters'; end if;
    if coalesce(s->>'output_type','text') not in ('text','image') then raise exception 'Invalid output type'; end if;
    if s->>'output_type'='image' and position<>jsonb_array_length(p_chain->'steps') then raise exception 'Image output is supported on the final step only'; end if;
    if (s->>'id')::uuid = any(step_ids) then raise exception 'Duplicate step ID'; end if;
    if exists(select 1 from public.prompt_chain_steps where id=(s->>'id')::uuid and prompt_chain_id is distinct from cid) then raise exception 'Step belongs to another chain'; end if;
    step_ids:=array_append(step_ids,(s->>'id')::uuid);
    insert into public.prompt_chain_steps(id,prompt_chain_id,step_number,prompt_template,title,output_type)
    values((s->>'id')::uuid,cid,position,s->>'prompt_template',left(coalesce(s->>'title',''),100),coalesce(s->>'output_type','text'))
    on conflict(id) do update set step_number=excluded.step_number,prompt_template=excluded.prompt_template,title=excluded.title,output_type=excluded.output_type;
  end loop;
  delete from public.prompt_chain_steps where prompt_chain_id=cid and not(id=any(step_ids));
  return jsonb_build_object('id',cid,'studio_version',current_version);
end; $$;

create or replace function public.chain_studio_delete(p_chain_id uuid,p_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v integer;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select studio_version into v from public.prompt_chains where id=p_chain_id for update;
  if not found then raise exception 'Chain not found'; end if;
  if v is distinct from p_version then raise exception 'This chain changed. Reload before deleting.' using errcode='40001'; end if;
  delete from public.prompt_chain_mix where prompt_chain_id=p_chain_id;
  delete from public.prompt_chain_steps where prompt_chain_id=p_chain_id;
  delete from public.prompt_chains where id=p_chain_id;
end; $$;

create or replace function public.chain_studio_start_run(p_id uuid,p_chain_id uuid,p_version integer,p_input text,p_had_image boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.prompt_chains%rowtype; snapshot jsonb; request_id uuid; result jsonb;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select * into c from public.prompt_chains where id=p_chain_id for share;
  if not found then raise exception 'Chain not found'; end if;
  if c.studio_version is distinct from p_version then raise exception 'This chain changed. Reload and try again.' using errcode='40001'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by step_number,created_at,id),'[]'::jsonb) into snapshot from public.prompt_chain_steps s where prompt_chain_id=c.id;
  if jsonb_array_length(snapshot)=0 then raise exception 'Add and save at least one step first'; end if;
  if jsonb_array_length(snapshot)>12 then raise exception 'Maximum 12 steps'; end if;
  insert into public.generation_requests(user_id,prompt,status) values(auth.uid(),p_input,'running') returning id into request_id;
  insert into public.chain_studio_runs(id,prompt_chain_id,generation_request_id,user_id,chain_name,chain_version,input_text,had_image,steps_snapshot)
  values(p_id,c.id,request_id,auth.uid(),c.name,c.studio_version,p_input,p_had_image,snapshot) returning to_jsonb(chain_studio_runs.*) into result;
  return result;
end; $$;

create or replace function public.chain_studio_finish_run(p_id uuid,p_outputs jsonb,p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare r public.chain_studio_runs%rowtype; o jsonb; last_output jsonb;
begin
  if not public.chain_studio_is_admin() then raise exception 'Superadmin access required' using errcode='42501'; end if;
  select * into r from public.chain_studio_runs where id=p_id for update;
  if not found or r.user_id<>auth.uid() then raise exception 'Run not found'; end if;
  if r.status<>'running' then raise exception 'Run already finalized'; end if;
  if jsonb_typeof(p_outputs) is distinct from 'array' then raise exception 'Outputs must be an array'; end if;
  update public.chain_studio_runs set outputs=p_outputs,status=case when p_error is null then 'completed' else 'failed' end,error=left(p_error,2000),completed_at=now() where id=p_id;
  update public.generation_requests set status=case when p_error is null then 'completed' else 'failed' end where id=r.generation_request_id;
  for o in select value from jsonb_array_elements(p_outputs) loop
    insert into public.llm_responses(generation_request_id,response_text) values(r.generation_request_id,coalesce(o->>'text','[Image output]'));
  end loop;
  if p_error is null and jsonb_array_length(p_outputs)>0 then
    last_output:=p_outputs->(jsonb_array_length(p_outputs)-1);
    insert into public.ai_generated_media(generation_request_id,media_type,description,media_url)
    values(r.generation_request_id,coalesce(last_output->>'type','text'),coalesce(last_output->>'text',''),case when last_output->>'path' is not null then 'supabase://chain-studio/'||(last_output->>'path') else null end);
  end if;
end; $$;

revoke all on function public.chain_studio_list(uuid),public.chain_studio_save(jsonb),public.chain_studio_delete(uuid,integer),public.chain_studio_start_run(uuid,uuid,integer,text,boolean),public.chain_studio_finish_run(uuid,jsonb,text) from public;
grant execute on function public.chain_studio_list(uuid),public.chain_studio_save(jsonb),public.chain_studio_delete(uuid,integer),public.chain_studio_start_run(uuid,uuid,integer,text,boolean),public.chain_studio_finish_run(uuid,jsonb,text) to authenticated;

-- Private generated images; signed URLs are produced only for authenticated admins.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('chain-studio','chain-studio',false,10485760,array['image/png','image/jpeg','image/webp']) on conflict(id) do nothing;
do $$ begin
  if not exists(select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='chain_studio_admin_images') then
    create policy chain_studio_admin_images on storage.objects for all to authenticated
    using(bucket_id='chain-studio' and public.chain_studio_is_admin())
    with check(bucket_id='chain-studio' and public.chain_studio_is_admin());
  end if;
end $$;
commit;
