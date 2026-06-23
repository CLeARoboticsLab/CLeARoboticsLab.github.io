// Shared email template helpers
// Used by weekly-report and deadline-reminders Edge Functions

export interface Stage {
  name: string;
  sort_order: number;
  target_date: string | null;
}

export interface HistoryEntry {
  stage_name: string;
  entered_at: string;
  exited_at: string | null;
}

export interface Project {
  id: string;
  title: string;
  target_venue: string | null;
  collaborators: string | null;
  notes: string | null;
  created_at: string;
  project_stages: Stage[];
  stage_history: HistoryEntry[];
}

export function generateWeeklyEmailHtml(
  traineeName: string,
  role: string,
  projects: Project[],
): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const cards = projects.map(generateProjectCard).join("");
  const empty = projects.length === 0
    ? '<p style="color:#6B6F66;">No active projects.</p>'
    : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAFAF7;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;font-size:14px;color:#1F2421;">
<div style="max-width:600px;margin:0 auto;padding:28px 16px;">
  <div style="margin-bottom:24px;padding-bottom:14px;border-bottom:2px solid #BF5700;">
    <h1 style="font-family:Georgia,serif;font-size:22px;margin:0 0 4px;color:#1F2421;">Lab project status</h1>
    <p style="margin:0;color:#6B6F66;font-size:13px;">${esc(traineeName)} &middot; ${esc(role)} &middot; ${today}</p>
  </div>
  ${cards}${empty}
  <p style="font-size:11px;color:#9A9D93;margin-top:28px;padding-top:14px;border-top:1px solid #E3E1D9;">
    Automated weekly summary &mdash; lab project tracker
  </p>
</div>
</body>
</html>`;
}

function generateProjectCard(p: Project): string {
  const stages = [...p.project_stages].sort((a, b) => a.sort_order - b.sort_order);
  const history = [...p.stage_history].sort(
    (a, b) => new Date(a.entered_at).getTime() - new Date(b.entered_at).getTime(),
  );
  const currentEntry = history.find((h) => !h.exited_at) ?? history[history.length - 1];
  const currentIndex = currentEntry
    ? stages.findIndex((s) => s.name === currentEntry.stage_name)
    : -1;
  const now = new Date();
  const ageWeeks = Math.round(
    (now.getTime() - new Date(p.created_at).getTime()) / (7 * 86400000),
  );

  const stageRows = stages
    .map((s, i) => {
      const targetDate = s.target_date ? new Date(s.target_date) : null;
      const isOverdue = targetDate !== null && i === currentIndex && targetDate < now;

      let nameStyle = "color:#6B6F66;text-decoration:line-through;";
      let bullet = "&bull;";
      let bulletColor = "#9A9D93";
      let dateStr = "";
      let dateColor = "#6B6F66";

      if (i < currentIndex) {
        dateStr = targetDate ? `&#10003; ${fmtDate(s.target_date!)}` : "";
      } else if (i === currentIndex) {
        nameStyle = "font-weight:600;color:#BF5700;";
        bullet = "&bull;";
        bulletColor = "#BF5700";
        if (targetDate) {
          dateStr = isOverdue
            ? `&#9888; overdue since ${fmtDate(s.target_date!)}`
            : `by ${fmtDate(s.target_date!)}`;
          dateColor = isOverdue ? "#B23B3B" : "#6B6F66";
        }
      } else {
        nameStyle = "color:#1F2421;";
        bullet = "&#9675;";
        bulletColor = "#9A9D93";
        dateStr = targetDate ? `by ${fmtDate(s.target_date!)}` : "";
      }

      return `<tr>
        <td style="width:14px;padding:4px 6px 4px 0;color:${bulletColor};font-size:11px;vertical-align:top;">${bullet}</td>
        <td style="padding:4px 0;${nameStyle}">${esc(s.name)}</td>
        <td style="padding:4px 0 4px 14px;font-family:monospace;font-size:11px;color:${dateColor};text-align:right;white-space:nowrap;">${dateStr}</td>
      </tr>`;
    })
    .join("");

  const venue = p.target_venue ? ` &middot; Target: ${esc(p.target_venue)}` : "";
  const collab = p.collaborators
    ? `<p style="margin:3px 0 0;font-size:12px;color:#6B6F66;">w/ ${esc(p.collaborators)}</p>`
    : "";
  const notes = p.notes
    ? `<p style="margin:10px 0 0;padding-top:8px;border-top:1px solid #E3E1D9;font-size:12px;color:#6B6F66;">&#128221; ${esc(p.notes)}</p>`
    : "";

  return `<div style="background:#fff;border:1px solid #E3E1D9;border-left:3px solid #BF5700;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
  <h2 style="font-family:Georgia,serif;font-size:15px;margin:0 0 2px;color:#1F2421;">${esc(p.title)}</h2>
  <p style="margin:0;font-size:12px;color:#6B6F66;">${ageWeeks} wk active${venue}</p>
  ${collab}
  <table style="width:100%;margin-top:10px;border-collapse:collapse;">${stageRows}</table>
  ${notes}
</div>`;
}

// ----------------------------------------------------------------
// Overdue reminder email (sent to trainee; also used for PI notice)
// ----------------------------------------------------------------
export function generateReminderEmailHtml(opts: {
  recipientName: string;
  traineeName: string;
  projectTitle: string;
  stageName: string;
  dueDate: string;
  daysOverdue: number;
  isPI: boolean;
}): string {
  const intro = opts.isPI
    ? `A project belonging to ${esc(opts.traineeName)} has been past its stage deadline for ${opts.daysOverdue} day${opts.daysOverdue === 1 ? "" : "s"}.`
    : `A reminder that the current stage of one of your projects is past its target date.`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FAFAF7;font-family:Inter,-apple-system,sans-serif;font-size:14px;color:#1F2421;">
<div style="max-width:540px;margin:0 auto;padding:28px 16px;">
  <div style="background:#fff;border:1px solid #E3E1D9;border-left:4px solid #B23B3B;border-radius:8px;padding:20px 24px;">
    <h2 style="font-family:Georgia,serif;font-size:17px;margin:0 0 10px;color:#B23B3B;">Stage deadline overdue</h2>
    <p style="margin:0 0 16px;">${intro}</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      ${opts.isPI ? `<tr><td style="color:#6B6F66;padding:4px 0;width:90px;">Trainee</td><td style="font-weight:600;">${esc(opts.traineeName)}</td></tr>` : ""}
      <tr><td style="color:#6B6F66;padding:4px 0;width:90px;">Project</td><td style="font-weight:600;">${esc(opts.projectTitle)}</td></tr>
      <tr><td style="color:#6B6F66;padding:4px 0;">Stage</td><td>${esc(opts.stageName)}</td></tr>
      <tr><td style="color:#6B6F66;padding:4px 0;">Was due</td><td style="color:#B23B3B;">${fmtDate(opts.dueDate)} &mdash; ${opts.daysOverdue} day${opts.daysOverdue === 1 ? "" : "s"} ago</td></tr>
    </table>
    ${!opts.isPI ? '<p style="margin:14px 0 0;font-size:12px;color:#6B6F66;">Please update the stage in the lab tracker once this milestone is reached.</p>' : ""}
  </div>
  <p style="font-size:11px;color:#9A9D93;margin-top:14px;">Automated reminder &mdash; lab project tracker</p>
</div>
</body>
</html>`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] ?? c),
  );
}
