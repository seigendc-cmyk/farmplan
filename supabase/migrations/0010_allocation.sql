-- Migration 0010: shared-cost allocation rules.
-- Costs not tied to a field (curing, grading, overhead…) are spread over fields on the device using one basis per category.

create table public.allocation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null,
  category text not null check (category in ('seed','fertilizer','chemicals','labour','machinery','fuel','irrigation','transport','curing','storage','grading','baling','marketing','overhead')),
  basis text not null check (basis in ('none','area','green_kg','sold_kg')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id), foreign key (tenant_id, farm_id) references public.farms(tenant_id, id)
);
create unique index one_rule_per_category on public.allocation_rules(tenant_id, farm_id, category) where deleted_at is null;

do $$
declare t record;
begin
  for t in select * from (values ('allocation_rules','finance.budget.view','finance.budget.edit')) as v(tbl, view_perm, write_perm)
  loop
    execute format('alter table public.%I enable row level security', t.tbl);
    execute format('create trigger touch before update on public.%I for each row execute function public.tg_touch()', t.tbl);
    execute format('create trigger lock_tenant before update on public.%I for each row execute function public.tg_lock_tenant()', t.tbl);
    execute format('create trigger audit after insert or update or delete on public.%I for each row execute function public.tg_audit()', t.tbl);
    execute format('create policy sel on public.%I for select using (public.has_perm(tenant_id, %L))', t.tbl, t.view_perm);
    execute format('create policy ins on public.%I for insert with check (public.has_perm(tenant_id, %L))', t.tbl, t.write_perm);
    execute format('create policy upd on public.%I for update using (public.has_perm(tenant_id, %L)) with check (public.has_perm(tenant_id, %L))', t.tbl, t.write_perm, t.write_perm);
    execute format('create policy del on public.%I for delete using (public.has_perm(tenant_id, %L))', t.tbl, t.write_perm);
    execute format('create index on public.%I (tenant_id, updated_at)', t.tbl);
  end loop;
end $$;
