-- Migration 0002: let an offline-first device claim a cloud tenant under the id it already uses locally.
-- Identity tables (tenants, roles, role_permissions) are owned by the cloud; devices sync business data only.

create or replace function public.claim_tenant(p_tenant uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_manager uuid; v_clerk uuid; v_field uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if exists (select 1 from tenants where id = p_tenant) then
    if public.is_member(p_tenant) then return p_tenant; end if;
    raise exception 'tenant already claimed';
  end if;
  insert into tenants(id, name, kind) values (p_tenant, p_name, 'farm');
  insert into roles(tenant_id, name, is_system) values (p_tenant,'Owner',true) returning id into v_owner;
  insert into roles(tenant_id, name, is_system) values (p_tenant,'Farm Manager',true) returning id into v_manager;
  insert into roles(tenant_id, name, is_system) values (p_tenant,'Store Clerk',true) returning id into v_clerk;
  insert into roles(tenant_id, name, is_system) values (p_tenant,'Field Recorder',true) returning id into v_field;
  insert into role_permissions(tenant_id, role_id, permission) values (p_tenant, v_owner, '*');
  insert into role_permissions(tenant_id, role_id, permission)
    select p_tenant, v_manager, p from unnest(array[
    'settings.farm.view','settings.season.view','settings.season.manage',
    'production.field.view','production.field.edit','production.seedbed.view','production.seedbed.edit',
    'production.operation.view','production.operation.record','production.weather.view','production.weather.record',
    'resources.inventory.view','resources.inventory.manage','finance.cost.view']) p;
  insert into role_permissions(tenant_id, role_id, permission)
    select p_tenant, v_clerk, p from unnest(array['settings.farm.view','resources.inventory.view','resources.inventory.manage']) p;
  insert into role_permissions(tenant_id, role_id, permission)
    select p_tenant, v_field, p from unnest(array[
    'settings.farm.view','production.field.view','production.seedbed.view','production.operation.view','production.operation.record',
    'production.weather.view','production.weather.record','resources.inventory.view']) p;
  insert into tenant_members(tenant_id, user_id, role_id) values (p_tenant, auth.uid(), v_owner);
  return p_tenant;
end $$;
revoke all on function public.claim_tenant(uuid,text) from public, anon;
grant execute on function public.claim_tenant(uuid,text) to authenticated;
