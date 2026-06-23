import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateReminderEmailHtml } from "../_shared/email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") ?? "Lab Tracker <tracker@lab.edu>";
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization");
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

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

  const now = new Date();
  const results: string[] = [];

  for (const project of projects ?? []) {
    // Reconstruct current stage
    const stages = (project.project_stages ?? []).sort(
      (a: any, b: any) => a.sort_order - b.sort_order,
    );
    const history = (project.stage_history ?? []).sort(
      (a: any, b: any) =>
        new Date(a.entered_at).getTime() - new Date(b.entered_at).getTime(),
    );
    const currentEntry =
      history.find((h: any) => !h.exited_at) ?? history[history.length - 1];
    if (!currentEntry) continue;

    const currentIndex = stages.findIndex(
      (s: any) => s.name === currentEntry.stage_name,
    );
    const currentStage = stages[currentIndex];
    if (!currentStage?.target_date) continue;

    const targetDate = new Date(currentStage.target_date);
    if (targetDate >= now) continue; // not overdue — nothing to do

    const daysOverdue = Math.floor(
      (now.getTime() - targetDate.getTime()) / 86400000,
    );

    const ownerProfile = profiles?.find((p: any) => p.id === project.owner_id);
    const ownerUser = users?.find((u: any) => u.id === project.owner_id);
    if (!ownerUser?.email || !ownerProfile) continue;

    // ── Trainee reminder: send every 2 days ──────────────────
    const { data: lastTraineeRow } = await supabase
      .from("reminder_log")
      .select("sent_at")
      .eq("project_id", project.id)
      .eq("reminder_type", "overdue_trainee")
      .order("sent_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const daysSinceTrainee = lastTraineeRow
      ? (now.getTime() - new Date(lastTraineeRow.sent_at).getTime()) / 86400000
      : Infinity;

    if (daysSinceTrainee >= 2) {
      const html = generateReminderEmailHtml({
        recipientName: ownerProfile.full_name,
        traineeName: ownerProfile.full_name,
        projectTitle: project.title,
        stageName: currentStage.name,
        dueDate: currentStage.target_date,
        daysOverdue,
        isPI: false,
      });

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: [ownerUser.email],
          subject: `Reminder: "${project.title}" — stage overdue by ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}`,
          html,
        }),
      });

      if (res.ok) {
        await supabase
          .from("reminder_log")
          .insert({ project_id: project.id, reminder_type: "overdue_trainee" });
        results.push(
          `Trainee reminder → ${ownerProfile.full_name}: ${project.title}`,
        );
      }
    }

    // ── PI notice: once a week after 7+ days overdue ─────────
    if (daysOverdue >= 7 && piEmail && piEmail !== ownerUser.email) {
      const { data: lastPIRow } = await supabase
        .from("reminder_log")
        .select("sent_at")
        .eq("project_id", project.id)
        .eq("reminder_type", "overdue_pi")
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const daysSincePI = lastPIRow
        ? (now.getTime() - new Date(lastPIRow.sent_at).getTime()) / 86400000
        : Infinity;

      if (daysSincePI >= 7) {
        const html = generateReminderEmailHtml({
          recipientName: piProfile?.full_name ?? "PI",
          traineeName: ownerProfile.full_name,
          projectTitle: project.title,
          stageName: currentStage.name,
          dueDate: currentStage.target_date,
          daysOverdue,
          isPI: true,
        });

        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM_EMAIL,
            to: [piEmail],
            subject: `FYI: "${project.title}" (${ownerProfile.full_name}) — ${daysOverdue} days overdue`,
            html,
          }),
        });

        if (res.ok) {
          await supabase
            .from("reminder_log")
            .insert({ project_id: project.id, reminder_type: "overdue_pi" });
          results.push(
            `PI notice → ${ownerProfile.full_name}: ${project.title} (${daysOverdue}d overdue)`,
          );
        }
      }
    }
  }

  console.log("Deadline reminder results:", results);
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
