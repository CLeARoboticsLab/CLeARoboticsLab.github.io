import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { slackUserIdForEmail, slackDM, weeklyReportBlocks } from "../_shared/slack.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

Deno.serve(async (req) => {
  const auth = req.headers.get("x-cron-secret");
  if (auth !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const [
    usersResult,
    { data: profiles, error: profilesError },
    { data: projects, error: projectsError },
    { data: collaborators, error: collaboratorsError },
  ] = await Promise.all([
    supabase.auth.admin.listUsers(),
    supabase.from("profiles").select("*"),
    supabase
      .from("projects")
      .select("*, project_stages(*), stage_history(*)")
      .eq("status", "active"),
    supabase.from("project_collaborators").select("project_id, profile_id"),
  ]);

  const users = usersResult.data?.users;
  if (usersResult.error) console.log("listUsers error:", usersResult.error);
  if (profilesError) console.log("profiles error:", profilesError);
  if (projectsError) console.log("projects error:", projectsError);
  if (collaboratorsError) console.log("collaborators error:", collaboratorsError);

  const trainees = (profiles ?? []).filter((p) => p.role !== "pi");
  const piProfile = (profiles ?? []).find((p) => p.role === "pi");
  const piUser = users?.find((u) => u.id === piProfile?.id);
  const piSlackId = piUser?.email ? await slackUserIdForEmail(piUser.email) : null;
  const results: string[] = [];

  // Full membership of each project = owner + collaborators, treated equally.
  const nameById = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
  const collabsByProject = new Map<string, string[]>();
  for (const c of collaborators ?? []) {
    const arr = collabsByProject.get(c.project_id) ?? [];
    arr.push(c.profile_id);
    collabsByProject.set(c.project_id, arr);
  }
  const coMemberNames = (project: any, exceptId: string): string[] =>
    [...new Set([project.owner_id, ...(collabsByProject.get(project.id) ?? [])])]
      .filter((id) => id !== exceptId)
      .map((id) => nameById.get(id))
      .filter(Boolean) as string[];

  for (const trainee of trainees) {
    const traineeUser = users?.find((u) => u.id === trainee.id);
    if (!traineeUser?.email) {
      console.log(`${trainee.full_name}: no auth email, skipping`);
      continue;
    }

    // Projects this trainee owns plus the ones they collaborate on.
    const collabProjectIds = new Set(
      (collaborators ?? [])
        .filter((c) => c.profile_id === trainee.id)
        .map((c) => c.project_id),
    );
    const traineeProjects = (projects ?? [])
      .filter((p) => p.owner_id === trainee.id || collabProjectIds.has(p.id))
      .map((p) => ({
        ...p,
        _isCollaboration: p.owner_id !== trainee.id,
        _coMembers: coMemberNames(p, trainee.id),
        project_stages: (p.project_stages ?? []).sort(
          (a: any, b: any) => a.sort_order - b.sort_order,
        ),
        stage_history: (p.stage_history ?? []).sort(
          (a: any, b: any) =>
            new Date(a.entered_at).getTime() - new Date(b.entered_at).getTime(),
        ),
      }))
      // Lead (owned) projects first, then collaborations.
      .sort((a, b) => Number(a._isCollaboration) - Number(b._isCollaboration));

    if (traineeProjects.length === 0) {
      console.log(`${trainee.full_name}: no active projects, skipping`);
      continue;
    }

    const slackId = await slackUserIdForEmail(traineeUser.email);
    if (!slackId) {
      results.push(`✗ ${trainee.full_name}: not found in Slack workspace`);
      continue;
    }

    const blocks = weeklyReportBlocks(trainee.full_name, traineeProjects);
    const ok = await slackDM(slackId, blocks, `Weekly project status for ${trainee.full_name}`);
    results.push(ok ? `✓ ${trainee.full_name}` : `✗ ${trainee.full_name}: Slack DM failed`);

    // Also DM the PI a copy
    if (piSlackId && piUser?.id !== trainee.id) {
      await slackDM(piSlackId, blocks, `Weekly project status for ${trainee.full_name}`);
    }
  }

  console.log("Weekly report results:", results);
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
