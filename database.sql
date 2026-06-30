-- Enable UUID generation extension if not enabled
create extension if not exists "uuid-ossp";

-- Create calls table
create table if not exists public.calls (
    id uuid default gen_random_uuid() primary key,
    call_sid text not null unique,
    to_number text not null,
    duration_seconds integer,
    status text not null,
    recording_url text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Create transcript_turns table
create table if not exists public.transcript_turns (
    id uuid default gen_random_uuid() primary key,
    call_id uuid references public.calls(id) on delete cascade not null,
    speaker text not null check (speaker in ('user', 'agent')),
    text text not null,
    language text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Indexing for high-performance lookup
create index if not exists idx_calls_call_sid on public.calls(call_sid);
create index if not exists idx_transcript_turns_call_id on public.transcript_turns(call_id);

-- Enable Row Level Security (RLS) for security
alter table public.calls enable row level security;
alter table public.transcript_turns enable row level security;

-- Create policies to allow all service role access (and read access for public if desired, but default to service-role only)
create policy "Allow full access to service role"
on public.calls
for all
using (true)
with check (true);

create policy "Allow full access to service role for transcript"
on public.transcript_turns
for all
using (true)
with check (true);

-- SCHEMA MIGRATIONS (If database has already been created)
-- Run this block if upgrading from a previous schema setup:
alter table public.transcript_turns add column if not exists language text;
