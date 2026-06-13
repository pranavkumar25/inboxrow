import { type Auth } from "googleapis";
import { sheetsClient, scriptClient } from "@/lib/google";
import { prisma } from "@/lib/db";
import { APPS_SCRIPT_CODE, APPS_SCRIPT_MANIFEST } from "@/lib/appsScriptSource";

export type ProvisionResult = {
  spreadsheetId: string;
  scriptId: string;
  spreadsheetUrl: string;
};

/**
 * Provision a campaign into the sender's Drive:
 *   1. create a Google Sheet (Config / Sequence / Contacts tabs)
 *   2. write config + sequence + contacts
 *   3. create a bound Apps Script and push the sending engine
 *   4. persist ids + flip the campaign to ACTIVE
 *
 * The sender still authorizes the script once (Sheet menu → Campaign →
 * Authorize) before sending begins.
 */
export async function provisionCampaign(
  auth: Auth.OAuth2Client,
  campaignId: string,
): Promise<ProvisionResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: {
      steps: { orderBy: { stepOrder: "asc" } },
      contacts: true,
    },
  });
  if (!campaign) throw new Error("Campaign not found");

  const sheets = sheetsClient(auth);
  const script = scriptClient(auth);

  // 1) Spreadsheet with three tabs.
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: `Campaign — ${campaign.name}` },
      sheets: [
        { properties: { title: "Config" } },
        { properties: { title: "Sequence" } },
        { properties: { title: "Contacts" } },
      ],
    },
  });
  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Failed to create spreadsheet");
  const spreadsheetUrl =
    created.data.spreadsheetUrl ??
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;

  // 2) Write Config / Sequence / Contacts.
  const base = process.env.TRACKING_BASE_URL ?? process.env.AUTH_URL ?? "";
  const configRows: string[][] = [
    ["key", "value"],
    ["campaignId", campaign.id],
    ["status", "ACTIVE"],
    ["trackingBaseUrl", base],
    ["ingestUrl", base ? `${base}/api/ingest` : ""],
    ["ingestSecret", process.env.INGEST_SECRET ?? ""],
    ["fromAlias", campaign.fromAlias ?? ""],
    ["fromName", campaign.fromName ?? ""],
    ["timezone", campaign.timezone],
    ["sendWindowStart", String(campaign.sendWindowStart)],
    ["sendWindowEnd", String(campaign.sendWindowEnd)],
    ["dailyCap", String(campaign.dailyCap)],
    ["unsubscribeHtml", campaign.unsubscribeHtml ?? ""],
    ["defaultSubject", campaign.subject],
    ["defaultBodyHtml", campaign.bodyHtml],
  ];

  const sequenceRows: (string | number)[][] = [
    ["stepOrder", "delayDays", "condition", "subject", "bodyHtml"],
    [0, 0, "ALWAYS", campaign.subject, campaign.bodyHtml], // initial email
    ...campaign.steps.map((s) => [
      s.stepOrder,
      s.delayDays,
      s.condition,
      s.subject ?? "",
      s.bodyHtml ?? "",
    ]),
  ];

  const contactRows: (string | number)[][] = [
    [
      "contactId", "email", "firstName", "lastName", "company", "fieldsJson",
      "status", "currentStep", "threadId", "lastSentAt", "nextSendAt", "error",
    ],
    ...campaign.contacts.map((c) => [
      c.id,
      c.email,
      c.firstName ?? "",
      c.lastName ?? "",
      c.company ?? "",
      c.fields ? JSON.stringify(c.fields) : "",
      "QUEUED",
      0,
      "",
      "",
      "",
      "",
    ]),
  ];

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data: [
        { range: "Config!A1", values: configRows },
        { range: "Sequence!A1", values: sequenceRows },
        { range: "Contacts!A1", values: contactRows },
      ],
    },
  });

  // 3) Bound Apps Script + push the engine.
  const project = await script.projects.create({
    requestBody: {
      title: `Campaign Script — ${campaign.name}`,
      parentId: spreadsheetId,
    },
  });
  const scriptId = project.data.scriptId;
  if (!scriptId) throw new Error("Failed to create Apps Script project");

  await script.projects.updateContent({
    scriptId,
    requestBody: {
      files: [
        { name: "appsscript", type: "JSON", source: APPS_SCRIPT_MANIFEST },
        { name: "Code", type: "SERVER_JS", source: APPS_SCRIPT_CODE },
      ],
    },
  });

  // 4) Persist + activate.
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { spreadsheetId, scriptId, status: "ACTIVE" },
  });

  return { spreadsheetId, scriptId, spreadsheetUrl };
}
