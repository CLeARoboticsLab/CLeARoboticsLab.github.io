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
  ] = await Promise.all([
    supabase.auth.admin.listUsers(),
    supabase.from("profiles").select("*"),
    supabase
      .from("projects")
      .select("*, project_stages(*), stage_history(*)")
      .eq("status", "active"),
  ]);

  const users = usersResult.data?.users;
  if (usersResult.error) console.log("listUsers error:", usersResult.error);
  if (profilesError) console.log("profiles error:", profilesError);
  if (projectsError) console.log("projects error:", projectsError);

  const trainees = (profiles ?? []).filter((p) => p.role !== "pi");
  const piProfile = (profiles ?? []).find((p) => p.role === "pi");
  const piUser = users?.find((u) => u.id === piProfile?.id);
  const piSlackId = piUser?.email ? await slackUserIdForEmail(piUser.email) : null;
  const results: string[] = [];

  for (const trainee of trainees) {
    const traineeUser = users?.find((u) => u.id === trainee.id);
    if (!traineeUser?.email) {
      console.log(`${trainee.full_name}: no auth email, skipping`);
      continue;
    }

    const traineeProjects = (projects ?? [])
      .filter((p) => p.owner_id === trainee.id)
      .map((p) => ({
        ...p,
        project_stages: (p.project_stages ?? []).sort(
          (a: any, b: any) => a.sort_order - b.sort_order,
        ),
        stage_history: (p.stage_history ?? []).sort(
          (a: any, b: any) =>
            new Date(a.entered_at).getTime() - new Date(b.entered_at).getTime(),
        ),
      }));

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
