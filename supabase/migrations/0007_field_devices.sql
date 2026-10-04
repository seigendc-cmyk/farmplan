-- Migration 0007: field terminal support (cloud relay).
--  * labour_entries (daily labour capture, feeds cost_entries on the device)
--  * devices registry: every device that joins a farm gets a short, unique code tag so offline-generated codes never collide (H-B-00012)
--  * my_farms / join helpers, add_member / list_members for the owner to enrol staff by email

create or replace function public.default_role_permissions(p_role text)
returns text[] language sql immutable as $$
  select case p_role
    when 'Owner' then array['*']
    when 'Farm Manager' then array[
      'settings.farm.view','settings.season.view','settings.season.manage',
      'production.field.view','production.field.edit','production.seedbed.view','production.seedbed.edit',
      'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
      'production.transplant.view','production.transplant.record','production.harvest.view','production.harvest.record',
      'curing.barn.view','curing.barn.edit','curing.cycle.view','curing.cycle.create','curing.cycle.record','curing.cycle.close',
      'curing.storage.view','curing.storage.edit',
      'contracts.contract.view','contracts.contract.edit',
      'quality.grade.edit','quality.grading.view','quality.grading.record','quality.bale.view','quality.bale.record','marketing.sale.view','marketing.sale.record',
      'resources.inventory.view','resources.inventory.manage','resources.labour.view','resources.labour.record','finance.cost.view']
    when 'Store Clerk' then array['settings.farm.view','resources.inventory.view','resources.inventory.manage']
    when 'Field Recorder' then array[
      'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
      'production.weather.view','production.weather.record','production.transplant.view','production.transplant.record',
      'production.harvest.view','production.harvest.record','curing.barn.view','curing.cycle.view','curing.cycle.record','curing.storage.view','quality.grading.view','quality.bale.view',
      'resources.inventory.view','resources.labour.view','resources.labour.record']
    else array[]::text[] end
$$;

insert into public.role_permissions(tenant_id, role_id, permission)
select r.tenant_id, r.id, p
from public.roles r, lateral unnest(public.default_role_permissions(r.name)) p
where r.is_system and p like 'resources.labour.%'
on conflict do nothing;

create table public.labour_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, farm_id uuid not null, season_id uuid not null, field_id uuid,
  worked_on date not null, worker_name text not null, task text not null, hours numeric(8,2) check (hours >= 0), pay_amount numeric(12,2) not null default 0 check (pay_amount >= 0),
  remarks text, created_by uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz, version integer not null default 1,
  unique (tenant_id, id),
  foreign key (tenant_id, farm_id) references public.farms(tenant_id, id),
  foreign key (tenant_id, season_id) references public.seasons(tenant_id, id),
  foreign key (tenant_id, field_id) references public.fields(tenant_id, id)
);

do $$
declare t record;
begin
  for t in select * from (values ('labour_entries','resources.labour.view','resources.labour.record')) as v(tbl, view_perm, write_perm)
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

-- ---------------------------------------------------------------------------
-- Device registry
-- ---------------------------------------------------------------------------
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  tag text not null check (tag ~ '^[A-Z]{1,3}$'), label text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, tag), unique (tenant_id, user_id, label)
);
alter table public.devices enable row level security;
create policy sel on public.devices for select using (public.has_perm(tenant_id, 'settings.users.manage') or user_id = auth.uid());

create or replace function public.device_tag(n integer) returns text language plpgsql immutable as $$
declare s text := ''; m integer := n;
begin
  -- 1→A … 26→Z, 27→AA … (bijective base 26)
  while m > 0 loop s := chr(65 + (m - 1) % 26) || s; m := (m - 1) / 26; end loop;
  return s;
end $$;

create or replace function public.register_device(p_tenant uuid, p_label text)
returns text language plpgsql security definer set search_path = public as $$
declare v_tag text; v_n integer;
begin
  if not public.is_member(p_tenant) then raise exception 'not a member of this farm' using errcode = 'insufficient_privilege'; end if;
  if coalesce(trim(p_label), '') = '' then raise exception 'device label is required'; end if;
  perform pg_advisory_xact_lock(hashtext(p_tenant::text));
  select tag into v_tag from devices where tenant_id = p_tenant and user_id = auth.uid() and label = trim(p_label);
  if v_tag is not null then return v_tag; end if;
  select count(*) + 1 into v_n from devices where tenant_id = p_tenant;
  loop
    v_tag := public.device_tag(v_n);
    exit when not exists (select 1 from devices where tenant_id = p_tenant and tag = v_tag);
    v_n := v_n + 1;
  end loop;
  insert into devices(tenant_id, user_id, tag, label) values (p_tenant, auth.uid(), v_tag, trim(p_label));
  return v_tag;
end $$;
revoke all on function public.register_device(uuid, text) from public, anon;
grant execute on function public.register_device(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Joining a farm from a new device, and enrolling staff
-- ---------------------------------------------------------------------------
create or replace function public.my_farms()
returns table (tenant_id uuid, tenant_name text, role_id uuid, role_name text)
language sql stable security definer set search_path = public as $$
  select t.id, t.name, r.id, r.name from tenant_members m join tenants t on t.id = m.tenant_id join roles r on r.id = m.role_id
  where m.user_id = auth.uid() and m.active order by t.name;
$$;
revoke all on function public.my_farms() from public, anon;
grant execute on function public.my_farms() to authenticated;

create or replace function public.add_member(p_tenant uuid, p_email text, p_role text)
returns void language plpgsql security definer set search_path = public, auth as $$
declare v_user uuid; v_role uuid;
begin
  if not public.has_perm(p_tenant, 'settings.users.manage') then raise exception 'permission denied: settings.users.manage' using errcode = 'insufficient_privilege'; end if;
  select id into v_user from auth.users where lower(email) = lower(trim(p_email));
  if v_user is null then raise exception 'No account exists for % — ask them to create one first (portal sign-up or the join screen).', p_email; end if;
  select id into v_role from roles where tenant_id = p_tenant and name = p_role;
  if v_role is null then raise exception 'Unknown role %', p_role; end if;
  insert into tenant_members(tenant_id, user_id, role_id) values (p_tenant, v_user, v_role)
  on conflict (tenant_id, user_id) do update set role_id = excluded.role_id, active = true, updated_at = now();
end $$;
revoke all on function public.add_member(uuid, text, text) from public, anon;
grant execute on function public.add_member(uuid, text, text) to authenticated;

create or replace function public.list_members(p_tenant uuid)
returns table (user_id uuid, email text, role_name text, active boolean, devices text)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.has_perm(p_tenant, 'settings.users.manage') then raise exception 'permission denied: settings.users.manage' using errcode = 'insufficient_privilege'; end if;
  return query select m.user_id, u.email::text, r.name, m.active,
    coalesce((select string_agg(d.tag || ' (' || d.label || ')', ', ' order by d.tag) from devices d where d.tenant_id = m.tenant_id and d.user_id = m.user_id), '')
  from tenant_members m join auth.users u on u.id = m.user_id join roles r on r.id = m.role_id where m.tenant_id = p_tenant order by u.email;
end $$;
revoke all on function public.list_members(uuid) from public, anon;
grant execute on function public.list_members(uuid) to authenticated;

create or replace function public.set_member_active(p_tenant uuid, p_user uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_perm(p_tenant, 'settings.users.manage') then raise exception 'permission denied: settings.users.manage' using errcode = 'insufficient_privilege'; end if;
  if p_user = auth.uid() then raise exception 'You cannot deactivate yourself'; end if;
  update tenant_members set active = p_active, updated_at = now() where tenant_id = p_tenant and user_id = p_user;
end $$;
revoke all on function public.set_member_active(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_member_active(uuid, uuid, boolean) to authenticated;
