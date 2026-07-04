create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  owner_user_id uuid not null
);

create table workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  role text not null check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

create table traveler_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  created_by_user_id uuid not null,
  first_name text not null,
  middle_name text,
  last_name text not null,
  date_of_birth date not null,
  gender text,
  nationality text not null,
  email text not null,
  phone text,
  preferred_seat text not null default 'no preference',
  baggage_preference text not null default 'personal item',
  default_cabin text not null default 'economy',
  invoice_company text,
  billing_tax_id text,
  billing_address text,
  billing_email text,
  payment_preference text not null default 'browser saved card',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table traveler_documents (
  id uuid primary key default gen_random_uuid(),
  traveler_profile_id uuid not null references traveler_profiles(id) on delete cascade,
  document_type text not null,
  issuing_country text not null,
  encrypted_document_number text not null,
  document_number_last4 text not null,
  expiry_date date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table loyalty_programs (
  id uuid primary key default gen_random_uuid(),
  traveler_profile_id uuid not null references traveler_profiles(id) on delete cascade,
  airline_or_program_name text not null,
  encrypted_member_number text not null,
  member_number_last4 text not null,
  created_at timestamptz not null default now()
);

create table billing_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  company_name text not null,
  tax_id text,
  billing_address text,
  billing_email text,
  created_at timestamptz not null default now()
);

create table trips (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  traveler_profile_id uuid not null references traveler_profiles(id) on delete cascade,
  created_by_user_id uuid not null,
  airline text,
  seller text,
  origin_airport text,
  destination_airport text,
  departure_at timestamptz,
  return_at timestamptz,
  booking_reference text,
  ticket_number text,
  price_amount numeric(12,2),
  price_currency text,
  baggage_summary text,
  booking_url text,
  status text not null default 'booked' check (status in ('draft', 'booked', 'cancelled', 'completed')),
  invoice_status text not null default 'missing' check (invoice_status in ('missing', 'received', 'not_required')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table trip_warnings (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  warning_type text not null,
  severity text not null check (severity in ('low', 'medium', 'high')),
  message text not null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table extension_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null,
  event_type text not null,
  site_host text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
