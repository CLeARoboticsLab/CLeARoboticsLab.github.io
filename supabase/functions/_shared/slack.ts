// Shared Slack messaging helpers
// Used by weekly-report and deadline-reminders Edge Functions

const SLACK_BOT_TOKEN = Deno.env.get("SLACK_BOT_TOKEN")!;

// Look up a Slack user ID from an email address.
// Returns null if the user isn't in the workspace.
export async function slackUserIdForEmail(email: string): Promise<string | null> {
  const res = await fetch(
    `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
    { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } },
  );
  const json = await res.json();
  if (!json.ok) {
    console.log(`slackUserIdForEmail(${email}) error: ${json.error}`);
    return null;
  }
  return json.user.id;
}

// Send a DM to a Slack user ID, opening the conversation if needed.
export async function slackDM(userId: string, blocks: object[], text: string): Promise<boolean> {
  // Open (or reuse) the DM channel — works even if the user has never messaged the bot
  const openRes = await fetch("https://slack.com/api/conversations.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ users: userId }),
  });
  const openJson = await openRes.json();
  if (!openJson.ok) {
    console.log(`conversations.open error for ${userId}:`, openJson.error);
    return false;
  }
  const channelId = openJson.channel.id;

  const postRes = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId, blocks, text }),
  });
  const postJson = await postRes.json();
  if (!postJson.ok) console.log(`chat.postMessage error:`, postJson.error);
  return postJson.ok;
}

// ----------------------------------------------------------------
// Block Kit builders
// ----------------------------------------------------------------

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

export function weeklyReportBlocks(traineeName: string, projects: Project[]): object[] {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "📋 Weekly project status", emoji: true },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `*${traineeName}* · ${today}` }],
    },
    { type: "divider" },
  ];

  if (projects.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No active projects._" } });
    return blocks;
  }

  for (const p of projects) {
    const stages = [...p.project_stages].sort((a, b) => a.sort_order - b.sort_order);
    const history = [...p.stage_history].sort(
      (a, b) => new Date(a.entered_at).getTime() - new Date(b.entered_at).getTime(),
    );
    const currentEntry = history.find((h) => !h.exited_at) ?? history[history.length - 1];
    const currentIndex = currentEntry
      ? stages.findIndex((s) => s.name === currentEntry.stage_name)
      : -1;
    const now = new Date();
    const ageWeeks = Math.round((now.getTime() - new Date(p.created_at).getTime()) / (7 * 86400000));

    // Build a compact stage pipeline string e.g. "~~Ideation~~ → *Writing* → Rebuttal"
    const pipelineStr = stages.map((s, i) => {
      if (i < currentIndex) return `~${s.name}~`;
      if (i === currentIndex) return `*${s.name}*`;
      return s.name;
    }).join(" → ");

    // Current stage timing
    const currentStage = currentIndex >= 0 ? stages[currentIndex] : null;
    let timingStr = "";
    if (currentStage?.target_date) {
      const target = new Date(currentStage.target_date);
      const daysUntil = Math.round((target.getTime() - now.getTime()) / 86400000);
      if (daysUntil < 0) {
        timingStr = ` · :red_circle: overdue by ${Math.abs(daysUntil)}d`;
      } else if (daysUntil <= 7) {
        timingStr = ` · :large_yellow_circle: due in ${daysUntil}d`;
      } else {
        timingStr = ` · :large_green_circle: due ${fmtDate(currentStage.target_date)}`;
      }
    }

    const venue = p.target_venue ? ` · ${p.target_venue}` : "";
    const collab = p.collaborators ? `\nw/ ${p.collaborators}` : "";
    const notes = p.notes ? `\n> ${p.notes}` : "";

    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${p.title}*\n${ageWeeks} wk active${venue}${collab}${timingStr}\n${pipelineStr}${notes}`,
        },
      },
      { type: "divider" },
    );
  }

  return blocks;
}

export function overdueReminderBlocks(opts: {
  traineeName: string;
  projectTitle: string;
  stageName: string;
  dueDate: string;
  daysOverdue: number;
  isPI: boolean;
}): object[] {
  const intro = opts.isPI
    ? `*${opts.traineeName}*'s project has been past its stage deadline for *${opts.daysOverdue} day${opts.daysOverdue === 1 ? "" : "s"}*.`
    : `A stage on one of your projects is past its target date.`;

  const blocks: object[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "⚠️ Stage deadline overdue", emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: intro },
    },
    {
      type: "section",
      fields: [
        ...(opts.isPI ? [{ type: "mrkdwn", text: `*Trainee*\n${opts.traineeName}` }] : []),
        { type: "mrkdwn", text: `*Project*\n${opts.projectTitle}` },
        { type: "mrkdwn", text: `*Stage*\n${opts.stageName}` },
        { type: "mrkdwn", text: `*Was due*\n${fmtDate(opts.dueDate)} — ${opts.daysOverdue}d ago` },
      ],
    },
  ];

  if (!opts.isPI) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: "Please update the stage in the lab tracker once this milestone is reached." }],
    });
  }

  return blocks;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}
