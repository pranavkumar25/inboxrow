import { type Auth } from "googleapis";
import { sheetsClient } from "@/lib/google";

function columnLetter(index0: number): string {
  let n = index0 + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Update a key in the Sheet's Config tab (append if missing). */
export async function updateConfigValue(
  auth: Auth.OAuth2Client,
  spreadsheetId: string,
  key: string,
  value: string,
) {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Config!A:B",
  });
  const rows = res.data.values ?? [];
  const rowIndex = rows.findIndex(
    (r) => (r?.[0] ?? "").toString().trim() === key,
  );
  if (rowIndex === -1) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: "Config!A:B",
      valueInputOption: "RAW",
      requestBody: { values: [[key, value]] },
    });
    return;
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `Config!B${rowIndex + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

/** Set a single contact's status in the Sheet's Contacts tab. */
export async function updateContactStatus(
  auth: Auth.OAuth2Client,
  spreadsheetId: string,
  contactId: string,
  status: string,
) {
  const sheets = sheetsClient(auth);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Contacts!A:L",
  });
  const rows = res.data.values ?? [];
  if (!rows.length) return;
  const header = rows[0].map((h) => (h ?? "").toString().trim());
  const idCol = header.indexOf("contactId");
  const statusCol = header.indexOf("status");
  if (idCol === -1 || statusCol === -1) return;
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i]?.[idCol] ?? "").toString() === contactId) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Contacts!${columnLetter(statusCol)}${i + 1}`,
        valueInputOption: "RAW",
        requestBody: { values: [[status]] },
      });
      return;
    }
  }
}
