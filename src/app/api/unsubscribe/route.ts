import { prisma } from "@/lib/db";
import { getGoogleClientForUser } from "@/lib/google";
import { updateContactStatus } from "@/lib/sheetSync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function page(message: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Unsubscribe</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center">
<div style="max-width:420px;text-align:center;color:#333">
<h1 style="font-size:18px">${message}</h1>
<p style="color:#888;font-size:14px">You can close this tab.</p>
</div></body></html>`;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const campaignId = searchParams.get("c");
  const contactId = searchParams.get("u");

  if (campaignId && contactId) {
    try {
      const contact = await prisma.contact.findFirst({
        where: { id: contactId, campaignId },
        include: {
          campaign: { select: { userId: true, spreadsheetId: true } },
        },
      });
      if (contact && contact.status !== "UNSUBSCRIBED") {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: "UNSUBSCRIBED" },
        });
        await prisma.event.create({
          data: { campaignId, contactId, type: "UNSUBSCRIBE" },
        });
        // Propagate to the Sheet so the Apps Script stops following up.
        if (contact.campaign.spreadsheetId) {
          try {
            const client = await getGoogleClientForUser(contact.campaign.userId);
            await updateContactStatus(
              client,
              contact.campaign.spreadsheetId,
              contactId,
              "UNSUBSCRIBED",
            );
          } catch {
            // best-effort; checkReplies/processQueue still honor DB-driven suppression on next sync
          }
        }
      }
    } catch {
      // fall through to a friendly page regardless
    }
  }

  return new Response(page("You've been unsubscribed."), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
