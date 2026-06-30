import { notFound } from "next/navigation";
import {
  ArrowTopRightOnSquareIcon,
  KeyIcon,
  ExclamationTriangleIcon,
  UsersIcon,
  ArrowUturnRightIcon,
  EnvelopeIcon,
} from "@heroicons/react/24/outline";
import { requireUser } from "@/server/auth-helpers";
import { prisma } from "@/server/db";
import { configHealth } from "@/server/config";
import {
  Stat,
  Card,
  StatusBadge,
  SectionTitle,
  Banner,
  ButtonLink,
  PageHeader,
} from "@/components/ui";
import { ProvisionButton } from "./ProvisionButton";
import { ResyncButton } from "./ResyncButton";
import { CampaignActions } from "./CampaignActions";
import { EventsChart, type ChartPoint } from "./EventsChart";
import { AutoRefresh } from "./AutoRefresh";

export const dynamic = "force-dynamic";

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

export default async function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  // Activity over the last 30 days, aggregated per day for the chart.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // One parallel batch — the campaign, its aggregates, and the chart events all
  // fetch together rather than in sequential round-trips.
  const [
    campaign,
    total,
    sent,
    replied,
    contacts,
    openedRows,
    clickedRows,
    recentEvents,
  ] = await Promise.all([
    prisma.campaign.findFirst({
      where: { id, userId: user.id },
      include: { steps: { orderBy: { stepOrder: "asc" } } },
    }),
    prisma.contact.count({ where: { campaignId: id } }),
    prisma.contact.count({
      where: { campaignId: id, status: { not: "QUEUED" } },
    }),
    prisma.contact.count({ where: { campaignId: id, status: "REPLIED" } }),
    prisma.contact.findMany({
      where: { campaignId: id },
      orderBy: { createdAt: "asc" },
      take: 100,
    }),
    prisma.event.findMany({
      where: { campaignId: id, type: "OPEN" },
      distinct: ["contactId"],
      select: { contactId: true },
    }),
    prisma.event.findMany({
      where: { campaignId: id, type: "CLICK" },
      distinct: ["contactId"],
      select: { contactId: true },
    }),
    prisma.event.findMany({
      where: { campaignId: id, createdAt: { gte: since } },
      select: { createdAt: true, type: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  if (!campaign) notFound();

  const opened = openedRows.filter((r) => r.contactId).length;
  const clicked = clickedRows.filter((r) => r.contactId).length;

  const byDay = new Map<string, ChartPoint>();
  for (const e of recentEvents) {
    const day = e.createdAt.toISOString().slice(0, 10);
    const p =
      byDay.get(day) ?? { date: day, SENT: 0, OPEN: 0, CLICK: 0, REPLY: 0 };
    if (
      e.type === "SENT" ||
      e.type === "OPEN" ||
      e.type === "CLICK" ||
      e.type === "REPLY"
    ) {
      p[e.type] += 1;
    }
    byDay.set(day, p);
  }
  const chartData = Array.from(byDay.values());

  const provisioned = Boolean(campaign.spreadsheetId);
  const sheetUrl = campaign.spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${campaign.spreadsheetId}`
    : null;
  const health = configHealth();

  return (
    <div className="space-y-6">
      {/* Keep metrics live without a manual reload. */}
      <AutoRefresh />
      <PageHeader
        title={campaign.name}
        actions={
          <CampaignActions campaignId={campaign.id} status={campaign.status} />
        }
      />

      {/* Meta */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
        <StatusBadge status={campaign.status} />
        <span className="text-line-strong">·</span>
        <span className="tabular-nums">{total.toLocaleString()} contacts</span>
        <span className="text-line-strong">·</span>
        <span>{campaign.steps.length + 1}-step sequence</span>
        <span className="text-line-strong">·</span>
        <span>
          {campaign.fromAlias
            ? `from ${campaign.fromAlias}`
            : "from your primary address"}
        </span>
      </div>

      {/* Config health */}
      {!health.ok && (
        <Banner
          icon={ExclamationTriangleIcon}
          tone="strong"
          title="Tracking is not configured — analytics won't update"
          action={
            provisioned ? <ResyncButton campaignId={campaign.id} /> : undefined
          }
        >
          {health.reason}
          {provisioned &&
            " Once the live domain is set, click Re-sync settings to push it into this campaign's Sheet."}
        </Banner>
      )}

      {/* Analytics */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat
          label="Sent"
          value={sent.toLocaleString()}
          sub={`of ${total.toLocaleString()}`}
        />
        <Stat
          label="Open rate"
          value={`${pct(opened, sent)}%`}
          sub={`${opened.toLocaleString()} opened`}
          accent
        />
        <Stat
          label="Click rate"
          value={`${pct(clicked, sent)}%`}
          sub={`${clicked.toLocaleString()} clicked`}
        />
        <Stat
          label="Reply rate"
          value={`${pct(replied, sent)}%`}
          sub={`${replied.toLocaleString()} replied`}
        />
        <Stat label="Queued" value={(total - sent).toLocaleString()} />
      </section>

      {/* Activity chart */}
      <Card className="p-5">
        <SectionTitle>Activity · last 30 days</SectionTitle>
        <div className="mt-4">
          <EventsChart data={chartData} />
        </div>
      </Card>

      {/* Sending engine */}
      <Card className="p-5">
        <SectionTitle>Sending engine</SectionTitle>
        {provisioned ? (
          <div className="mt-4 space-y-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <ButtonLink
                href={sheetUrl!}
                target="_blank"
                rel="noreferrer"
                variant="secondary"
                size="sm"
              >
                <ArrowTopRightOnSquareIcon className="h-4 w-4" strokeWidth={2} />
                Open campaign Sheet
              </ButtonLink>
              {health.ok && <ResyncButton campaignId={campaign.id} />}
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-line bg-elevated p-3">
              <KeyIcon
                className="mt-0.5 h-4 w-4 shrink-0 text-accent-600"
                strokeWidth={2}
              />
              <div className="text-muted">
                <span className="font-medium text-ink">One-time per sender:</span>{" "}
                open the Sheet → menu{" "}
                <span className="rounded bg-canvas px-1.5 py-0.5 font-mono text-[12px] text-ink ring-1 ring-line">
                  Campaign → Authorize + install triggers
                </span>{" "}
                to grant Gmail access. Sending then runs on your quota
                automatically.
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3 text-sm">
            <p className="text-muted">
              Create the Google Sheet + bound Apps Script in your Drive, loaded
              with these contacts and the sequence.
            </p>
            <ProvisionButton campaignId={campaign.id} />
          </div>
        )}
      </Card>

      {/* Sequence */}
      <Card className="p-5">
        <SectionTitle>Sequence</SectionTitle>
        <ol className="mt-4 space-y-3">
          <SequenceRow
            index={0}
            title="Initial email"
            subtitle={campaign.subject}
            icon={EnvelopeIcon}
          />
          {campaign.steps.map((s) => (
            <SequenceRow
              key={s.id}
              index={s.stepOrder}
              title={`Follow-up · +${s.delayDays}d · ${s.condition
                .replace("_", " ")
                .toLowerCase()}`}
              subtitle={s.subject || "(replies in the same thread)"}
              icon={ArrowUturnRightIcon}
            />
          ))}
        </ol>
      </Card>

      {/* Contacts */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <UsersIcon className="h-4 w-4 text-faint" strokeWidth={2} />
          <SectionTitle>
            Contacts{" "}
            {total > contacts.length && (
              <span className="font-normal normal-case tracking-normal text-faint">
                (showing {contacts.length} of {total.toLocaleString()})
              </span>
            )}
          </SectionTitle>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium uppercase tracking-wide text-faint">
                <th className="px-5 py-2.5 font-medium">Email</th>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Company</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Step</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/70">
              {contacts.map((c) => (
                <tr key={c.id} className="transition-colors hover:bg-canvas">
                  <td className="px-5 py-2.5 text-ink">{c.email}</td>
                  <td className="px-4 py-2.5 text-muted">
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{c.company || "—"}</td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-faint">
                    {c.currentStep}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function SequenceRow({
  index,
  title,
  subtitle,
  icon: Icon,
}: {
  index: number;
  title: string;
  subtitle: string;
  icon: typeof EnvelopeIcon;
}) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-elevated text-xs font-semibold tabular-nums text-accent-600">
        {index}
      </span>
      <div className="min-w-0 flex-1 border-b border-line/70 pb-3">
        <div className="flex items-center gap-1.5 text-sm font-medium capitalize text-ink">
          <Icon className="h-3.5 w-3.5 text-faint" strokeWidth={2} />
          {title}
        </div>
        <div className="mt-0.5 truncate text-sm text-muted">{subtitle}</div>
      </div>
    </li>
  );
}
