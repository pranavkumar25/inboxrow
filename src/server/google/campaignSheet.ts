import { type Auth } from "googleapis";
import { sheetsClient, scriptClient } from "@/server/google/client";
import { prisma } from "@/server/db";
import { trackingBaseUrl } from "@/server/config";
import { APPS_SCRIPT_CODE, APPS_SCRIPT_MANIFEST } from "@/server/google/appsScriptSource";

type CampaignConfig = {
  id: string;
  fromAlias: string | null;
  fromName: string | null;
  timezone: string;
  sendWindowStart: number;
  sendWindowEnd: number;
  dailyCap: number;
  unsubscribeHtml: string | null;
  subject: string;
  bodyHtml: string;
  status: string;
};

/**
 * Canonical Config tab contents for a campaign. Shared by initial provisioning
 * and by the "re-sync settings" repair so the two never drift.
 */
export function campaignConfigRows(
  campaign: CampaignConfig,
  baseUrl: string,
): string[][] {
  return [
    ["key", "value"],
    ["campaignId", campaign.id],
    ["status", campaign.status === "PAUSED" ? "PAUSED" : "ACTIVE"],
    ["trackingBaseUrl", baseUrl],
    ["ingestUrl", baseUrl ? `${baseUrl}/api/ingest` : ""],
    ["ingestSecret", process.env.INGEST_SECRET ?? ""],
    ["fromAlias", campaign.fromAlias ?? ""],
    ["fromName", campaign.fromName ?? ""],
    ["timezone", campaign.timezone],
    ["sendWindowStart", String(campaign.sendWindowStart)],
    ["sendWindowEnd", String(campaign.sendWindowEnd)],
    ["dailyCap", String(campaign.dailyCap)],
    // Open/click tracking is ON by default so analytics record. It injects a
    // tracking pixel + link redirects, which can hurt inbox placement — set a
    // value to "false" in this Sheet's Config tab to disable it for a campaign.
    ["trackOpens", "true"],
    ["trackClicks", "true"],
    ["unsubscribeHtml", campaign.unsubscribeHtml ?? ""],
    ["defaultSubject", campaign.subject],
    ["defaultBodyHtml", campaign.bodyHtml],
  ];
}

/**
 * Re-sync an already-provisioned campaign's Sheet with the current canonical
 * values: rewrites the Config tab (e.g. to repair a `trackingBaseUrl` /
 * `ingestUrl` stamped while the env pointed at localhost) and re-pushes the
 * latest Apps Script engine so engine fixes (e.g. dropping the default
 * unsubscribe footer) reach campaigns that were provisioned earlier.
 */
export async function resyncCampaignConfig(
  auth: Auth.OAuth2Client,
  campaignId: string,
): Promise<{ baseUrl: string }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error("Campaign not found");
  if (!campaign.spreadsheetId) throw new Error("Campaign is not provisioned yet");

  const baseUrl = trackingBaseUrl();
  const rows = campaignConfigRows(campaign, baseUrl);
  const sheets = sheetsClient(auth);

  // Clear then rewrite so stale keys never linger.
  await sheets.spreadsheets.values.clear({
    spreadsheetId: campaign.spreadsheetId,
    range: "Config!A:B",
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: campaign.spreadsheetId,
    range: "Config!A1",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });

  // Re-push the engine. Triggers + authorization persist across content updates,
  // so sending continues with the latest code and no re-authorization.
  if (campaign.scriptId) {
    const script = scriptClient(auth);
    await script.projects.updateContent({
      scriptId: campaign.scriptId,
      requestBody: {
        files: [
          { name: "appsscript", type: "JSON", source: APPS_SCRIPT_MANIFEST },
          { name: "Code", type: "SERVER_JS", source: APPS_SCRIPT_CODE },
        ],
      },
    });
  }

  return { baseUrl };
}
