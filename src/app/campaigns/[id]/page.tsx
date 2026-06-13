import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth-helpers";
import { prisma } from "@/lib/db";
import { Header } from "@/components/Header";
import { ProvisionButton } from "./ProvisionButton";
import { CampaignActions } from "./CampaignActions";
import { EventsChart, type ChartPoint } from "./EventsChart";

export const dynamic = "force-dynamic";

function pct(n: number, d: number) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

const STATUS_BADGE: Record<string, string> = {
  QUEUED: "bg-neutral-100 text-neutral-600",
  SENT: "bg-blue-100 text-blue-700",
  OPENED: "bg-indigo-100 text-indigo-700",
  CLICKED: "bg-violet-100 text-violet-700",
  REPLIED: "bg-green-100 text-green-700",
  BOUNCED: "bg-red-100 text-red-700",
  UNSUBSCRIBED: "bg-neutral-200 text-neutral-600",
  FAILED: "bg-red-100 text-red-700",
};

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="text-xs text-neutral-500">{sub}</div>}
    </div>
  );
}

export default async function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  const campaign = await prisma.campaign.findFirst({
    where: { id, userId: user.id },
    include: { steps: { orderBy: { stepOrder: "asc" } } },
  });
  if (!campaign) notFound();

  const [total, sent, replied, contacts, openedRows, clickedRows] =
    await Promise.all([
      prisma.contact.count({ where: { campaignId: id } }),
      prisma.contact.count({ where: { campaignId: id, status: { not: "QUEUED" } } }),
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
    ]);
  const opened = openedRows.filter((r) => r.contactId).length;
  const clicked = clickedRows.filter((r) => r.contactId).length;

  // Activity over the last 30 days, aggregated per day for the chart.
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recentEvents = await prisma.event.findMany({
    where: { campaignId: id, createdAt: { gte: since } },
    select: { createdAt: true, type: true },
    orderBy: { createdAt: "asc" },
  });
  const byDay = new Map<string, ChartPoint>();
  for (const e of recentEvents) {
    const day = e.createdAt.toISOString().slice(0, 10);
    const p =
      byDay.get(day) ?? { date: day, SENT: 0, OPEN: 0, CLICK: 0, REPLY: 0 };
    if (e.type === "SENT" || e.type === "OPEN" || e.type === "CLICK" || e.type === "REPLY") {
      p[e.type] += 1;
    }
    byDay.set(day, p);
  }
  const chartData = Array.from(byDay.values());

  const sheetUrl = campaign.spreadsheetId
    ? `https://docs.google.com/spreadsheets/d/${campaign.spreadsheetId}`
    : null;

  return (
    <>
      <Header />
      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">
              {campaign.name}
            </h1>
            <p className="mt-1 text-sm text-neutral-500">
              {campaign.status} · {total} contacts ·{" "}
              {campaign.steps.length + 1}-step sequence ·{" "}
              {campaign.fromAlias ? `from ${campaign.fromAlias}` : "from default"}
            </p>
          </div>
          <CampaignActions campaignId={campaign.id} status={campaign.status} />
        </div>

        {/* Analytics */}
        <section className="grid grid-cols-2 gap-4 md:grid-cols-5">
          <Stat label="Sent" value={`${sent}`} sub={`of ${total}`} />
          <Stat label="Open rate" value={`${pct(opened, sent)}%`} sub={`${opened} opened`} />
          <Stat label="Click rate" value={`${pct(clicked, sent)}%`} sub={`${clicked} clicked`} />
          <Stat label="Reply rate" value={`${pct(replied, sent)}%`} sub={`${replied} replied`} />
          <Stat label="Queued" value={`${total - sent}`} />
        </section>

        {/* Activity chart */}
        <section className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-semibold">Activity (last 30 days)</h2>
          <div className="mt-3">
            <EventsChart data={chartData} />
          </div>
        </section>

        {/* Provisioning */}
        <section className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-semibold">Sending engine</h2>
          {sheetUrl ? (
            <div className="mt-3 space-y-2 text-sm">
              <p className="text-green-700">✓ Provisioned to your Drive.</p>
              <a
                href={sheetUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-block rounded-lg border border-neutral-300 px-3 py-1.5 font-medium hover:bg-neutral-50"
              >
                Open the campaign Sheet ↗
              </a>
              <div className="rounded-lg bg-amber-50 p-3 text-amber-800">
                <strong>One-time per sender:</strong> open the Sheet → menu{" "}
                <span className="font-mono">Campaign → Authorize + install
                triggers</span>{" "}
                to grant Gmail access and start sending on your quota.
              </div>
            </div>
          ) : (
            <div className="mt-3 space-y-3 text-sm">
              <p className="text-neutral-500">
                Create the Google Sheet + bound Apps Script in your Drive, loaded
                with these contacts and sequence.
              </p>
              <ProvisionButton campaignId={campaign.id} />
            </div>
          )}
        </section>

        {/* Sequence */}
        <section className="rounded-xl border border-neutral-200 bg-white p-6">
          <h2 className="text-sm font-semibold">Sequence</h2>
          <ol className="mt-3 space-y-2 text-sm">
            <li className="flex gap-3">
              <span className="font-mono text-neutral-400">0</span>
              <div>
                <div className="font-medium">Initial email</div>
                <div className="text-neutral-500">{campaign.subject}</div>
              </div>
            </li>
            {campaign.steps.map((s) => (
              <li key={s.id} className="flex gap-3">
                <span className="font-mono text-neutral-400">{s.stepOrder}</span>
                <div>
                  <div className="font-medium">
                    Follow-up · +{s.delayDays}d ·{" "}
                    <span className="text-neutral-500">{s.condition}</span>
                  </div>
                  <div className="text-neutral-500">
                    {s.subject || "(replies in the same thread)"}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Contacts */}
        <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white">
          <div className="border-b border-neutral-100 px-4 py-3 text-sm font-semibold">
            Contacts {total > contacts.length && `(showing ${contacts.length} of ${total})`}
          </div>
          <table className="w-full text-sm">
            <thead className="bg-neutral-50 text-left text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Step</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td className="px-4 py-2">{c.email}</td>
                  <td className="px-4 py-2 text-neutral-600">
                    {[c.firstName, c.lastName].filter(Boolean).join(" ")}
                  </td>
                  <td className="px-4 py-2 text-neutral-600">{c.company}</td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        STATUS_BADGE[c.status] ?? "bg-neutral-100"
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-neutral-500">{c.currentStep}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </>
  );
}
