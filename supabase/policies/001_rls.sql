alter table workspaces enable row level security;
alter table workspace_members enable row level security;
alter table traveler_profiles enable row level security;
alter table traveler_documents enable row level security;
alter table loyalty_programs enable row level security;
alter table billing_profiles enable row level security;
alter table trips enable row level security;
alter table trip_warnings enable row level security;
alter table extension_events enable row level security;

create or replace function is_workspace_member(target_workspace_id uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1
    from workspace_members
    where workspace_id = target_workspace_id
      and user_id = auth.uid()
  );
$$;

create or replace function workspace_role(target_workspace_id uuid)
returns text
language sql
security definer
set search_path = public
as $$
  select role
  from workspace_members
  where workspace_id = target_workspace_id
    and user_id = auth.uid()
  limit 1;
$$;

create policy "members can read workspace"
on workspaces for select
using (is_workspace_member(id));

create policy "owners can update workspace"
on workspaces for update
using (workspace_role(id) = 'owner');

create policy "members can read membership"
on workspace_members for select
using (is_workspace_member(workspace_id));

create policy "owners and admins manage members"
on workspace_members for all
using (workspace_role(workspace_id) in ('owner', 'admin'))
with check (workspace_role(workspace_id) in ('owner', 'admin'));

create policy "members read travelers"
on traveler_profiles for select
using (is_workspace_member(workspace_id));

create policy "owners and admins manage travelers"
on traveler_profiles for all
using (workspace_role(workspace_id) in ('owner', 'admin'))
with check (workspace_role(workspace_id) in ('owner', 'admin'));

create policy "members read own trips"
on trips for select
using (is_workspace_member(workspace_id));

create policy "members create trips"
on trips for insert
with check (is_workspace_member(workspace_id));

create policy "owners and admins manage trips"
on trips for update
using (workspace_role(workspace_id) in ('owner', 'admin'));

create policy "trip warning workspace access"
on trip_warnings for select
using (
  exists (
    select 1 from trips
    where trips.id = trip_warnings.trip_id
      and is_workspace_member(trips.workspace_id)
  )
);
