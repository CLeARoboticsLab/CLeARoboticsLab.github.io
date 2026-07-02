-- ============================================================================
-- Lab project tracker — Row Level Security (RLS) reference + optional hardening
-- ============================================================================
-- Table DDL lives in the live Supabase project (ref jgjhqwkgjmvwmjttjasc); this
-- file documents the ACCESS-CONTROL layer only. Everything here is idempotent.
--
-- SECTION A mirrors the policies currently live in the database (as dumped from
-- pg_policies on 2026-07-02) so the repo has an accurate record.
--
-- SECTION B is OPTIONAL hardening. Apply it ONLY if the intent is that a
-- trainee should not be able to read other people's projects. Today, reads are
-- open to every authenticated user and the "own + collaborated" rule is enforced
-- solely in intranet/app.js — i.e. any logged-in lab member can read every
-- project's notes/deadlines directly via the API. Section B moves that rule into
-- the database.
-- ============================================================================


-- ============================================================================
-- SECTION A — current state (for reference; already present in the live DB)
-- ============================================================================

-- Helper functions used by the policies below. Reconstructed to match observed
-- usage; SECURITY DEFINER so they bypass RLS on the tables they read (which is
-- what keeps the projects <-> project_collaborators policies from recursing).
create or replace function public.is_pi()
  returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles where id = auth.uid() and role = 'pi'
  );
$$;

create or replace function public.is_collaborator(pid uuid)
  returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.project_collaborators
    where project_id = pid and profile_id = auth.uid()
  );
$$;

-- profiles — roster readable by all signed-in users; edit only your own row.
--   SELECT  "profiles viewable by all logged-in users"  USING (auth.uid() is not null)
--   UPDATE  "users can update their own profile"         USING (auth.uid() = id)
-- projects
--   SELECT  "projects viewable by all"                   USING (auth.uid() is not null)
--   INSERT  "projects insertable by owner or pi"         CHECK (owner_id = auth.uid() OR is_pi())
--   UPDATE  "projects editable by owner, collaborator, or pi"
--                                                        USING (owner_id = auth.uid() OR is_pi() OR is_collaborator(id))
--   DELETE  "projects deletable by owner or pi"          USING (owner_id = auth.uid() OR is_pi())
-- project_stages
--   SELECT  "project stages viewable by all"             USING (auth.uid() is not null)
--   ALL     "project stages editable by owner, collaborator, or pi"
--                                                        USING/CHECK (project's owner_id = auth.uid() OR is_pi() OR is_collaborator(project_id))
-- stage_history
--   SELECT  "stage history viewable by all"              USING (auth.uid() is not null)
--   ALL     "stage history editable by owner, collaborator, or pi"   (same predicate as stages)
-- project_collaborators
--   SELECT  "project_collaborators viewable by authenticated"  USING (auth.uid() is not null)
--   ALL     "project_collaborators editable by owner or pi"     USING/CHECK (project's owner_id = auth.uid() OR is_pi())
-- stage_templates / stage_template_items
--   SELECT  viewable by all (auth.uid() is not null);  ALL editable by pi (is_pi())


-- ============================================================================
-- SECTION B — OPTIONAL: enforce "own + collaborated" visibility in the database
-- ----------------------------------------------------------------------------
-- Run this block ONLY if trainees should be unable to read projects that aren't
-- theirs. It is safe for the app: the client already displays only owned +
-- collaborated projects, so scoping the reads to match changes nothing in the
-- UI — it just closes the API-level hole.
--
-- profiles and the two stage_template tables intentionally stay world-readable:
-- the roster and templates are needed everywhere (owner names, collaborator
-- pickers, seeding new projects).
-- ============================================================================

-- projects: replace the blanket read with owner/PI/collaborator scoping.
drop policy if exists "projects viewable by all" on public.projects;
create policy "projects viewable by owner, collaborator, or pi"
  on public.projects for select to authenticated
  using (owner_id = auth.uid() or public.is_pi() or public.is_collaborator(id));

-- project_stages: scope reads to the parent project.
drop policy if exists "project stages viewable by all" on public.project_stages;
create policy "project stages viewable by owner, collaborator, or pi"
  on public.project_stages for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_stages.project_id
      and (p.owner_id = auth.uid() or public.is_pi() or public.is_collaborator(p.id))
  ));

-- stage_history: scope reads to the parent project.
drop policy if exists "stage history viewable by all" on public.stage_history;
create policy "stage history viewable by owner, collaborator, or pi"
  on public.stage_history for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = stage_history.project_id
      and (p.owner_id = auth.uid() or public.is_pi() or public.is_collaborator(p.id))
  ));

-- project_collaborators: you may read a project's membership only if you can
-- see that project (this still lets a trainee read their own membership rows,
-- because being a collaborator makes the project visible to them).
drop policy if exists "project_collaborators viewable by authenticated" on public.project_collaborators;
create policy "project_collaborators viewable by owner, collaborator, or pi"
  on public.project_collaborators for select to authenticated
  using (exists (
    select 1 from public.projects p
    where p.id = project_collaborators.project_id
      and (p.owner_id = auth.uid() or public.is_pi() or public.is_collaborator(p.id))
  ));
