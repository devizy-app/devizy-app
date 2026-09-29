-- ============================================================
--  Devizy — Schéma Supabase (étape 2 / S3)
--  Tables + sécurité par ligne (RLS) + compteur de devis serveur
--  À exécuter dans Supabase : SQL Editor > New query > Run
-- ============================================================

-- ─────────────────────────────────────────────
-- 1. PROFILS  (une ligne par utilisateur = 1 artisan)
-- ─────────────────────────────────────────────
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  prenom        text    default '',
  nom           text    default '',
  entreprise    text    default '',
  siret         text    default '',
  email         text    default '',
  telephone     text    default '',
  metier        text    default 'Climatisation',
  taux_horaire  numeric default 65,
  adresse       text    default '',
  tva           text    default '10',
  rcpro         text    default '',
  assureur      text    default '',
  decennale     text    default '',
  couverture    text    default 'France métropolitaine',
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- ─────────────────────────────────────────────
-- 2. CATALOGUE  (prestations, regroupées par métier)
-- ─────────────────────────────────────────────
create table if not exists public.catalogue_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  metier      text not null default 'Climatisation',
  nom         text not null,
  prix        numeric not null default 0,
  cout_achat  numeric not null default 0,
  unite       text not null default 'forfait',
  categorie   text not null default 'Autre',
  created_at  timestamptz default now()
);
create index if not exists idx_catalogue_user on public.catalogue_items(user_id, metier);

-- ─────────────────────────────────────────────
-- 3. DEVIS
-- ─────────────────────────────────────────────
create table if not exists public.quotes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  numero        text not null,
  client        jsonb not null default '{}'::jsonb,
  description   text default '',
  lignes        jsonb not null default '[]'::jsonb,
  montant_ht    numeric default 0,
  montant_tva   numeric default 0,
  montant_ttc   numeric default 0,
  marge         integer,               -- null = marge inconnue (jamais inventée)
  statut        text not null default 'brouillon',  -- brouillon | envoye | signe | refuse
  transcription text default '',
  signature     jsonb,                 -- { image, dateISO, cgvAcceptees }
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_quotes_user on public.quotes(user_id, created_at desc);

-- ─────────────────────────────────────────────
-- 4. COMPTEUR DE DEVIS  (séquence par utilisateur ET par année)
--    Empêche les doublons de numéro entre appareils.
-- ─────────────────────────────────────────────
create table if not exists public.quote_counters (
  user_id  uuid not null references auth.users(id) on delete cascade,
  annee    integer not null,
  n        integer not null default 0,
  primary key (user_id, annee)
);

-- RPC atomique : renvoie le prochain numéro de séquence pour l'année donnée.
-- Appelée depuis l'app via supabase.rpc('next_quote_number', { p_annee: 2026 }).
create or replace function public.next_quote_number(p_annee integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  insert into public.quote_counters (user_id, annee, n)
  values (auth.uid(), p_annee, 1)
  on conflict (user_id, annee)
  do update set n = public.quote_counters.n + 1
  returning n into v_n;
  return v_n;
end;
$$;

-- ─────────────────────────────────────────────
-- 5. updated_at automatique
-- ─────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_quotes_touch on public.quotes;
create trigger trg_quotes_touch before update on public.quotes
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────
-- 6. Création automatique du profil à l'inscription
--    (déclenché au premier login via magic link)
-- ─────────────────────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- 7. SÉCURITÉ PAR LIGNE (RLS)
--    Chaque artisan ne voit et ne modifie QUE ses propres données.
-- ─────────────────────────────────────────────
alter table public.profiles        enable row level security;
alter table public.catalogue_items enable row level security;
alter table public.quotes          enable row level security;
alter table public.quote_counters  enable row level security;

-- profiles : accès limité à sa propre ligne
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert with check (id = auth.uid());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- catalogue_items : toutes opérations réservées au propriétaire
drop policy if exists catalogue_all_own on public.catalogue_items;
create policy catalogue_all_own on public.catalogue_items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- quotes : toutes opérations réservées au propriétaire
drop policy if exists quotes_all_own on public.quotes;
create policy quotes_all_own on public.quotes
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- quote_counters : toutes opérations réservées au propriétaire
drop policy if exists counters_all_own on public.quote_counters;
create policy counters_all_own on public.quote_counters
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================
--  Fin du schéma. Après exécution, vérifiez dans
--  Table Editor que les 4 tables existent et que RLS est activé.
-- ============================================================
