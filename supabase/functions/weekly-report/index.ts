import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateWeeklyEmailHtml } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Lab Tracker <tracker@lab.edu>";
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

Deno.serve(async (req) => {
  // Only allow requests from our scheduled GitHub Action
  //  const auth = req.headers.get("Authorization");
  //  if (auth !== `Bearer ${CRON_SECRET}`) {
  const auth = req.headers.get("x-cron-secret");
  if (auth !== CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Fetch all auth users (for email addresses), profiles, and projects
  const [
    { data: { users } },
    { data: profiles },
    { data: projects },
  ] = await Promise.all([
    supabase.auth.admin.listUsers(),
    supabase.from("profiles").select("*"),
    supabase
      .from("projects")
      .select("*, project_stages(*), stage_history(*)")
      .eq("status", "active"),
  ]);

  const piProfile = profiles?.find((p) => p.role === "pi");
  const piUser = users?.find((u) => u.id === piProfile?.id);
  const piEmail = piUser?.email ?? null;

  const trainees = (profiles ?? []).filter((p) => p.role !== "pi");
  const results: string[] = [];

  for (const trainee of trainees) {
    const traineeUser = users?.find((u) => u.id === trainee.id);
    if (!traineeUser?.email) continue;

    // Collect and sort this trainee's active projects
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

    if (traineeProjects.length === 0) continue;

    const html = generateWeeklyEmailHtml(
      trainee.full_name,
      trainee.role,
      traineeProjects,
    );

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [traineeUser.email],
        cc: piEmail && piEmail !== traineeUser.email ? [piEmail] : [],
        subject: `Automated tracking update: ${trainee.full_name}`,
        html,
      }),
    });

    const label = `${trainee.full_name} → ${traineeUser.email}`;
    results.push(res.ok ? `✓ ${label}` : `✗ ${label} (HTTP ${res.status})`);
  }

  console.log("Weekly report results:", results);
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
