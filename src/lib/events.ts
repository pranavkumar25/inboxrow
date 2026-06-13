import { Prisma, type ContactStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

const RANK: Record<string, number> = { QUEUED: 0, SENT: 1, OPENED: 2, CLICKED: 3 };
const TERMINAL: ContactStatus[] = ["REPLIED", "BOUNCED", "UNSUBSCRIBED", "FAILED"];

/** Open/click hits from the tracking pixel + wrapped links. */
export async function recordTrackingEvent(opts: {
  campaignId: string;
  contactId: string;
  type: "OPEN" | "CLICK";
  stepOrder?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const contact = await prisma.contact.findFirst({
    where: { id: opts.contactId, campaignId: opts.campaignId },
  });
  if (!contact) return;

  await prisma.event.create({
    data: {
      campaignId: opts.campaignId,
      contactId: opts.contactId,
      type: opts.type,
      stepOrder: opts.stepOrder ?? null,
      metadata: opts.metadata
        ? (opts.metadata as Prisma.InputJsonValue)
        : undefined,
    },
  });

  if (TERMINAL.includes(contact.status)) return;
  const target: ContactStatus = opts.type === "OPEN" ? "OPENED" : "CLICKED";
  if ((RANK[contact.status] ?? 0) < RANK[target]) {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { status: target },
    });
  }
}

/** SENT / REPLY / FAILED events posted back by the Apps Script. */
export async function recordIngestEvent(body: {
  campaignId: string;
  contactId?: string | null;
  type: "SENT" | "REPLY" | "FAILED" | "BOUNCE";
  stepOrder?: number | null;
  threadId?: string | null;
  error?: string | null;
}) {
  await prisma.event.create({
    data: {
      campaignId: body.campaignId,
      contactId: body.contactId ?? null,
      type: body.type,
      stepOrder: body.stepOrder ?? null,
      metadata: body.error ? { error: body.error } : undefined,
    },
  });

  if (!body.contactId) return;
  const contact = await prisma.contact.findFirst({
    where: { id: body.contactId, campaignId: body.campaignId },
  });
  if (!contact) return;

  if (body.type === "REPLY") {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { status: "REPLIED" },
    });
  } else if (body.type === "FAILED") {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { status: "FAILED" },
    });
  } else if (body.type === "BOUNCE") {
    await prisma.contact.update({
      where: { id: contact.id },
      data: { status: "BOUNCED" },
    });
  } else if (body.type === "SENT") {
    if (!TERMINAL.includes(contact.status) && (RANK[contact.status] ?? 0) < RANK.SENT) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: {
          status: "SENT",
          lastSentAt: new Date(),
          threadId: body.threadId ?? contact.threadId,
        },
      });
    } else if (body.threadId && !contact.threadId) {
      await prisma.contact.update({
        where: { id: contact.id },
        data: { threadId: body.threadId },
      });
    }
  }
}
