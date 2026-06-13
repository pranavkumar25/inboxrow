import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyIngestSecret } from "@/lib/crypto";
import { recordIngestEvent } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  campaignId: z.string(),
  contactId: z.string().nullable().optional(),
  type: z.enum(["SENT", "REPLY", "FAILED", "BOUNCE"]),
  email: z.string().optional(),
  stepOrder: z.union([z.number(), z.string()]).nullable().optional(),
  threadId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export async function POST(req: Request) {
  if (!verifyIngestSecret(req.headers.get("x-ingest-secret"))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const d = parsed.data;

  await recordIngestEvent({
    campaignId: d.campaignId,
    contactId: d.contactId ?? null,
    type: d.type,
    stepOrder: d.stepOrder != null ? Number(d.stepOrder) : null,
    threadId: d.threadId ?? null,
    error: d.error ?? null,
  });

  return NextResponse.json({ ok: true });
}
