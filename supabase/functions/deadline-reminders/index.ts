import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { slackUserIdForEmail, slackDM, overdueReminderBlocks } from "../_shared/slack.ts";

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
    { data: profiles },
    { data: projects },
    { data: collaborators },
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
  const piProfile = profiles?.find((p: any) => p.role === "pi");
  const piUser = users?.find((u: any) => u.id === piProfile?.id);

  const now = new Date();
  const results: string[] = [];

  // Full membership of each project = owner + collaborators, treated equally.
  const nameById = new Map((profiles ?? []).map((p: any) => [p.id, p.full_name]));
  const collabsByProject = new Map<string, string[]>();
  for (const c of collaborators ?? []) {
    const arr = collabsByProject.get(c.project_id) ?? [];
    arr.push(c.profile_id);
    collabsByProject.set(c.project_id, arr);
  }
  const memberIds = (project: any): string[] =>
    [...new Set([project.owner_id, ...(collabsByProject.get(project.id) ?? [])])];
  // Names of everyone on the project except `exceptId`.
  const coMemberNames = (project: any, exceptId: string): string[] =>
    memberIds(project)
      .filter((id) => id !== exceptId)
      .map((id) => nameById.get(id))
      .filter(Boolean) as string[];

  for (const project of projects ?? []) {
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
    if (targetDate >= now) continue;

    const daysOverdue = Math.floor(
      (now.getTime() - targetDate.getTime()) / 86400000,
    );

    const ownerProfile = profiles?.find((p: any) => p.id === project.owner_id);
    const ownerUser = users?.find((u: any) => u.id === project.owner_id);
    if (!ownerUser?.email || !ownerProfile) continue;

    // ── Reminders to everyone on the project: every 2 days ───
    // The owner and every collaborator are nudged equally; each recipient's
    // message names the rest of the team, and each is de-duplicated
    // independently in reminder_log via a per-recipient reminder_type.
    const recipients: { profile: any; user: any; type: string }[] = [];
    for (const id of memberIds(project)) {
      const prof = profiles?.find((p: any) => p.id === id);
      const usr = users?.find((u: any) => u.id === id);
      if (!prof || !usr) continue;
      // Keep the owner's existing reminder_type for continuity; others are per-id.
      const type = id === project.owner_id ? "overdue_trainee" : `overdue_collaborator:${id}`;
      recipients.push({ profile: prof, user: usr, type });
    }

    for (const r of recipients) {
      if (!r.user?.email) continue;

      const { data: lastRow } = await supabase
        .from("reminder_log")
        .select("sent_at")
        .eq("project_id", project.id)
        .eq("reminder_type", r.type)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const daysSince = lastRow
        ? (now.getTime() - new Date(lastRow.sent_at).getTime()) / 86400000
        : Infinity;
      if (daysSince < 2) continue;

      const slackId = await slackUserIdForEmail(r.user.email);
      if (!slackId) continue;

      const blocks = overdueReminderBlocks({
        traineeName: ownerProfile.full_name,
        projectTitle: project.title,
        stageName: currentStage.name,
        dueDate: currentStage.target_date,
        daysOverdue,
        isPI: false,
        coMembers: coMemberNames(project, r.profile.id),
      });
      const ok = await slackDM(slackId, blocks,
        `Reminder: "${project.title}" stage is ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`);
      if (ok) {
        await supabase.from("reminder_log")
          .insert({ project_id: project.id, reminder_type: r.type });
        results.push(`Reminder → ${r.profile.full_name}: ${project.title}`);
      }
    }

    // ── PI notice: once a week after 7+ days overdue ─────────
    if (daysOverdue >= 7 && piUser?.email) {
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
        const piSlackId = await slackUserIdForEmail(piUser.email);
        if (piSlackId) {
          const blocks = overdueReminderBlocks({
            traineeName: ownerProfile.full_name,
            projectTitle: project.title,
            stageName: currentStage.name,
            dueDate: currentStage.target_date,
            daysOverdue,
            isPI: true,
            coMembers: coMemberNames(project, piProfile?.id ?? ""),
          });
          const ok = await slackDM(piSlackId, blocks,
            `FYI: "${project.title}" (${ownerProfile.full_name}) is ${daysOverdue} days overdue`);
          if (ok) {
            await supabase.from("reminder_log")
              .insert({ project_id: project.id, reminder_type: "overdue_pi" });
            results.push(`PI notice → ${ownerProfile.full_name}: ${project.title} (${daysOverdue}d overdue)`);
          }
        }
      }
    }
  }

  console.log("Deadline reminder results:", results);
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
