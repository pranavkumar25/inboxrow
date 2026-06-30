"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import {
  ArrowUpTrayIcon,
  PlusIcon,
  TrashIcon,
  CheckIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  RocketLaunchIcon,
  ArrowPathIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";
import { RichTextEditor } from "@/components/RichTextEditor";
import { Button, Card, cn } from "@/components/ui";

type Role = "ignore" | "email" | "firstName" | "lastName" | "company" | "custom";
type Condition = "NO_REPLY" | "NO_OPEN" | "ALWAYS";
type ComposeMode = "single" | "perRecipient";
type Followup = {
  delayDays: number;
  condition: Condition;
  subject: string;
  bodyHtml: string;
  // Per-recipient mode: pull this follow-up's body from a CSV column instead of
  // typing one shared body. "" = use the typed bodyHtml above.
  bodyColumn: string;
};

const STEPS = ["Details", "Contacts", "Compose", "Follow-ups", "Review"];

function guessRole(header: string): Role {
  const h = header.toLowerCase();
  if (/e-?mail/.test(h)) return "email";
  if (/first.?name|fname|given/.test(h)) return "firstName";
  if (/last.?name|lname|surname/.test(h)) return "lastName";
  if (/company|organi[sz]ation|\borg\b|account/.test(h)) return "company";
  return "custom";
}

// ── Per-recipient column detection + merge rendering ───────────────────────
// A header looks like a subject / body column when it (loosely) says so. Body
// detection is limited to "body" so LinkedIn *_message columns aren't mistaken
// for the email body.
const looksLikeSubject = (h: string) => /subject/i.test(h);
const looksLikeBody = (h: string) => /body/i.test(h);

// Trailing number in a header, so email_1_body sorts before email_2_body (0 if none).
const seqIndex = (h: string) => {
  const m = h.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};

// Normalize a key so {{first_name}}, {{firstName}} and {{First Name}} all match.
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const ROLE_ALIASES: Record<"email" | "firstName" | "lastName" | "company", string[]> = {
  email: ["email", "emailaddress"],
  firstName: ["firstname", "first", "fname", "givenname"],
  lastName: ["lastname", "last", "lname", "surname"],
  company: ["company", "companyname", "organization", "organisation", "account"],
};

/**
 * Build a normalized {{token}} → value lookup for one CSV row. Every raw header
 * is addressable, and the mapped role columns also answer to their common
 * aliases so a body that says {{first_name}} resolves a `firstName` column.
 */
function rowLookup(
  row: Record<string, string>,
  headers: string[],
  mapping: Record<string, Role>,
): Record<string, string> {
  const lut: Record<string, string> = {};
  for (const h of headers) {
    const v = (row[h] ?? "").toString();
    if (v) lut[normKey(h)] = v;
  }
  for (const h of headers) {
    const role = mapping[h];
    if (!role || role === "ignore" || role === "custom") continue;
    const v = (row[h] ?? "").toString();
    if (!v) continue;
    for (const a of ROLE_ALIASES[role]) lut[a] = v;
  }
  return lut;
}

/** Fill {{tokens}} in a per-row template from its normalized lookup. */
function renderRow(template: string, lut: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const v = lut[normKey(key)];
    return v != null ? v : "";
  });
}

// ── Timezone + send-window scheduling ──────────────────────────────────────
const FALLBACK_TZ = [
  "UTC", "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Sao_Paulo", "Europe/London", "Europe/Berlin",
  "Europe/Paris", "Europe/Moscow", "Asia/Dubai", "Asia/Kolkata",
  "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo", "Australia/Sydney",
  "Pacific/Auckland",
];

// All IANA timezones when the runtime supports it, else a curated shortlist.
// Always includes the passed-in current value so the <select> can show it.
function listTimezones(current: string): string[] {
  let zones: string[] = FALLBACK_TZ;
  try {
    const sv = (Intl as unknown as {
      supportedValuesOf?: (key: string) => string[];
    }).supportedValuesOf;
    if (typeof sv === "function") {
      const all = sv("timeZone");
      if (all && all.length) zones = all;
    }
  } catch {
    /* keep the curated fallback */
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

// "9:00 AM", "5:00 PM", "12:00 AM" (midnight, incl. the hour-24 window end).
function hourLabel(h: number): string {
  if (h % 24 === 0) return "12:00 AM";
  if (h === 12) return "12:00 PM";
  const m = h % 12 || 12;
  return `${m}:00 ${h < 12 ? "AM" : "PM"}`;
}

const input =
  "w-full rounded-lg border border-line bg-elevated px-3 py-2 text-sm text-ink placeholder:text-faint transition-colors focus:border-accent-500 focus:outline-none";
const label = "block text-[13px] font-medium text-muted";

export function NewCampaignWizard({
  initial,
}: {
  initial?: { name?: string; subject?: string; bodyHtml?: string };
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<"idle" | "creating" | "provisioning">("idle");
  const [error, setError] = useState<string | null>(null);

  // Step 0 — details
  const [name, setName] = useState(initial?.name ?? "");
  const [fromName, setFromName] = useState("");
  const [fromAlias, setFromAlias] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [sendWindowStart, setSendWindowStart] = useState(9);
  const [sendWindowEnd, setSendWindowEnd] = useState(17);
  const [dailyCap, setDailyCap] = useState(500);

  // Step 1 — contacts
  const [fileName, setFileName] = useState("");
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, Role>>({});

  // Step 2 — compose
  const [composeMode, setComposeMode] = useState<ComposeMode>("single");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? "");
  // Per-recipient mode: which CSV column holds each contact's subject / HTML body.
  const [subjectColumn, setSubjectColumn] = useState("");
  const [bodyColumn, setBodyColumn] = useState("");

  // Step 3 — follow-ups
  const [followups, setFollowups] = useState<Followup[]>([]);

  const mergeFields = useMemo(() => {
    const fields = new Set<string>();
    for (const h of csvHeaders) {
      const role = mapping[h];
      if (!role || role === "ignore") continue;
      fields.add(role === "custom" ? h : role);
    }
    return Array.from(fields);
  }, [csvHeaders, mapping]);

  const emailMapped = csvHeaders.some((h) => mapping[h] === "email");

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = res.meta.fields ?? [];
        const m: Record<string, Role> = {};
        for (const h of headers) m[h] = guessRole(h);
        setCsvHeaders(headers);
        setCsvRows(res.data);
        setMapping(m);

        // Detect a per-recipient email sequence (e.g. email_1_subject,
        // email_1_body, email_2_body …). The first body becomes the initial
        // email; any later body columns are pre-loaded as threaded follow-ups.
        const subjectCols = headers.filter(looksLikeSubject);
        const bodyCols = headers
          .filter(looksLikeBody)
          .sort((a, b) => seqIndex(a) - seqIndex(b));
        const initBody = bodyCols[0] ?? "";
        const initSubject =
          subjectCols.find((s) => seqIndex(s) === seqIndex(initBody)) ??
          subjectCols[0] ??
          "";

        setSubjectColumn(initSubject);
        setBodyColumn(initBody);
        setFollowups(
          bodyCols.slice(1).map((bc) => ({
            delayDays: 3,
            condition: "NO_REPLY" as Condition,
            subject: "",
            bodyHtml: "",
            bodyColumn: bc,
          })),
        );
        setComposeMode(initSubject && initBody ? "perRecipient" : "single");
      },
    });
  }

  function buildContacts() {
    const out: Array<Record<string, unknown>> = [];
    for (const row of csvRows) {
      const c: Record<string, unknown> = {};
      const fields: Record<string, string> = {};
      for (const h of csvHeaders) {
        const role = mapping[h];
        const val = (row[h] ?? "").toString().trim();
        if (!val || !role || role === "ignore") continue;
        if (role === "custom") fields[h] = val;
        else c[role] = val;
      }
      // Per-recipient mode: render each contact's own subject + body (and any
      // per-recipient follow-up bodies) now, so they ship as ready-to-send HTML
      // in fields.__subject / __body / __stepNBody. The campaign template just
      // points at those tokens; the sending engine substitutes them verbatim.
      if (composeMode === "perRecipient" && c.email) {
        const lut = rowLookup(row, csvHeaders, mapping);
        if (subjectColumn) fields.__subject = renderRow(row[subjectColumn] ?? "", lut);
        if (bodyColumn) fields.__body = renderRow(row[bodyColumn] ?? "", lut);
        followups.forEach((f, i) => {
          if (f.bodyColumn) {
            fields[`__step${i + 1}Body`] = renderRow(row[f.bodyColumn] ?? "", lut);
          }
        });
      }
      if (c.email) {
        if (Object.keys(fields).length) c.fields = fields;
        out.push(c);
      }
    }
    return out;
  }

  const contactCount = useMemo(
    () => (emailMapped ? buildContacts().length : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [csvRows, mapping, emailMapped, composeMode, subjectColumn, bodyColumn, followups],
  );

  // First contact with an email — the sample used for live per-recipient previews.
  const firstContact = useMemo(() => {
    if (csvRows.length === 0) return null;
    const emailHeader = csvHeaders.find((h) => mapping[h] === "email") ?? "";
    const row = csvRows.find((r) => (r[emailHeader] ?? "").trim());
    return row ? { row, lut: rowLookup(row, csvHeaders, mapping) } : null;
  }, [csvRows, csvHeaders, mapping]);

  // Render one CSV column's template for that first contact (initial + follow-ups).
  const renderColumn = (column: string) =>
    firstContact && column ? renderRow(firstContact.row[column] ?? "", firstContact.lut) : "";

  const preview = useMemo(() => {
    if (composeMode !== "perRecipient" || !firstContact) return null;
    return {
      subject: subjectColumn ? renderRow(firstContact.row[subjectColumn] ?? "", firstContact.lut) : "",
      body: bodyColumn ? renderRow(firstContact.row[bodyColumn] ?? "", firstContact.lut) : "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeMode, firstContact, subjectColumn, bodyColumn]);

  const timezones = useMemo(() => listTimezones(timezone), [timezone]);

  const composeReady =
    composeMode === "single"
      ? subject.trim() !== "" && bodyHtml.trim() !== ""
      : subjectColumn !== "" && bodyColumn !== "";

  const canNext =
    (step === 0 && name.trim().length > 0) ||
    (step === 1 && emailMapped && contactCount > 0) ||
    (step === 2 && composeReady) ||
    step === 3 ||
    step === 4;

  const submitting = phase !== "idle";

  async function submit() {
    setError(null);
    setPhase("creating");
    const perRecipient = composeMode === "perRecipient";
    const payload = {
      name,
      fromName: fromName || null,
      fromAlias: fromAlias || null,
      timezone,
      sendWindowStart,
      sendWindowEnd,
      dailyCap,
      // In per-recipient mode the campaign template just points at the merge
      // tokens we rendered per contact; the engine substitutes them verbatim.
      subject: perRecipient ? "{{__subject}}" : subject,
      bodyHtml: perRecipient ? "{{__body}}" : bodyHtml,
      steps: followups.map((f, i) => ({
        delayDays: f.delayDays,
        condition: f.condition,
        subject: f.subject || null,
        bodyHtml:
          perRecipient && f.bodyColumn
            ? `{{__step${i + 1}Body}}`
            : f.bodyHtml || null,
      })),
      contacts: buildContacts(),
    };
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        setError(
          typeof b.error === "string"
            ? b.error
            : "Failed to create campaign (check required fields).",
        );
        setPhase("idle");
        return;
      }
      const c = await res.json();

      // Auto-provision so the user doesn't need a separate click. Best-effort:
      // if it fails (e.g. Apps Script API not yet enabled), the detail page
      // surfaces a Provision button to retry.
      setPhase("provisioning");
      try {
        await fetch(`/api/campaigns/${c.id}/provision`, { method: "POST" });
      } catch {
        /* detail page handles the un-provisioned state */
      }
      router.push(`/campaigns/${c.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create campaign.");
      setPhase("idle");
    }
  }

  return (
    <div className="space-y-6">
      {/* Stepper */}
      <ol className="flex items-center">
        {STEPS.map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <li key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-all",
                    active && "bg-accent text-white shadow-glow-sm",
                    done && "bg-accent text-white",
                    !active &&
                      !done &&
                      "border border-line bg-elevated text-faint",
                  )}
                >
                  {done ? (
                    <CheckIcon className="h-3.5 w-3.5" strokeWidth={2.5} />
                  ) : (
                    i + 1
                  )}
                </span>
                <span
                  className={cn(
                    "hidden text-[13px] font-medium sm:inline",
                    active ? "text-ink" : "text-faint",
                  )}
                >
                  {s}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <span
                  className={cn(
                    "mx-2 h-px flex-1 transition-colors",
                    i < step ? "bg-accent-500" : "bg-line",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>

      <Card className="p-6">
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <label className={label}>Campaign name</label>
              <input
                className={cn(input, "mt-1.5")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 outreach"
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label className={label}>From name</label>
                <input
                  className={cn(input, "mt-1.5")}
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="Pranav from Pickcel"
                />
              </div>
              <div>
                <label className={label}>Send-as alias (optional)</label>
                <input
                  className={cn(input, "mt-1.5")}
                  value={fromAlias}
                  onChange={(e) => setFromAlias(e.target.value)}
                  placeholder="you@yourdomain.com"
                />
              </div>
            </div>
            <div>
              <label className={label}>Timezone (controls the send schedule)</label>
              <select
                className={cn(input, "mt-1.5")}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              >
                {timezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={label}>Send from</label>
                <select
                  className={cn(input, "mt-1.5")}
                  value={sendWindowStart}
                  onChange={(e) => setSendWindowStart(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Send until</label>
                <select
                  className={cn(input, "mt-1.5")}
                  value={sendWindowEnd}
                  onChange={(e) => setSendWindowEnd(Number(e.target.value))}
                >
                  {Array.from({ length: 24 }, (_, i) => i + 1).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label}>Daily cap</label>
                <input
                  type="number"
                  min={1}
                  className={cn(input, "mt-1.5 tabular-nums")}
                  value={dailyCap}
                  onChange={(e) => setDailyCap(Number(e.target.value))}
                />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-faint">
              The engine only sends between these hours in the selected
              timezone — e.g. {hourLabel(sendWindowStart)}–
              {hourLabel(sendWindowEnd)} {timezone.replace(/_/g, " ")}.
            </p>
            <p className="text-xs leading-relaxed text-faint">
              Workspace sends ~1,500/day via Apps Script — the script also stops
              automatically when your Gmail quota is exhausted. Open/click
              tracking is off by default so personal-style Gmail-to-Gmail
              outreach stays out of spam.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <label
              className={cn(
                "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center transition-colors hover:border-accent-500/50 hover:bg-accent-soft",
              )}
            >
              <ArrowUpTrayIcon className="h-5 w-5 text-accent-600" strokeWidth={1.75} />
              <span className="text-sm font-medium text-ink">
                {fileName || "Upload contacts (CSV)"}
              </span>
              <span className="text-xs text-faint">
                An email column is required
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                className="hidden"
              />
            </label>

            <p className="text-xs text-faint">
              To send a different subject &amp; body to each person, include
              per-recipient columns (e.g. <code className="font-mono">email_1_subject</code>,{" "}
              <code className="font-mono">email_1_body</code>) and pick them in
              the Compose step.{" "}
              <a
                href="/samples/per-recipient-template.csv"
                download
                className="font-medium text-accent-600 hover:underline"
              >
                Download sample CSV
              </a>
            </p>

            {csvHeaders.length > 0 && (
              <>
                <p className="text-sm text-muted tabular-nums">
                  {csvRows.length} rows · map each column.
                </p>
                <div className="divide-y divide-line/70 overflow-hidden rounded-lg border border-line">
                  {csvHeaders.map((h) => (
                    <div
                      key={h}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="truncate font-mono text-[13px] text-muted">
                        {h}
                      </span>
                      <select
                        className="shrink-0 rounded-md border border-line bg-elevated px-2 py-1 text-[13px] text-ink focus:border-accent-500 focus:outline-none"
                        value={mapping[h] ?? "ignore"}
                        onChange={(e) =>
                          setMapping((m) => ({
                            ...m,
                            [h]: e.target.value as Role,
                          }))
                        }
                      >
                        <option value="ignore">Ignore</option>
                        <option value="email">Email</option>
                        <option value="firstName">First name</option>
                        <option value="lastName">Last name</option>
                        <option value="company">Company</option>
                        <option value="custom">Custom field ({h})</option>
                      </select>
                    </div>
                  ))}
                </div>
                {!emailMapped ? (
                  <p className="flex items-center gap-1.5 text-sm text-amber-700">
                    <ExclamationTriangleIcon className="h-4 w-4" strokeWidth={2} />
                    Map one column to <strong>Email</strong> to continue.
                  </p>
                ) : (
                  <p className="flex items-center gap-1.5 text-sm text-muted">
                    <CheckIcon
                      className="h-4 w-4 text-accent-600"
                      strokeWidth={2.25}
                    />
                    <span className="tabular-nums">{contactCount}</span> valid
                    contacts (deduplicated by email on save).
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            {/* Mode toggle: one shared email vs. per-recipient columns. */}
            <div className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
              {(
                [
                  ["single", "Write one email"],
                  ["perRecipient", "Personalize from CSV"],
                ] as [ComposeMode, string][]
              ).map(([mode, labelText]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setComposeMode(mode)}
                  className={cn(
                    "rounded-[7px] px-3 py-1.5 text-[13px] font-medium transition-colors",
                    composeMode === mode
                      ? "bg-accent text-white shadow-glow-sm"
                      : "text-muted hover:text-ink",
                  )}
                >
                  {labelText}
                </button>
              ))}
            </div>

            {composeMode === "single" ? (
              <>
                <div>
                  <label className={label}>Subject</label>
                  <input
                    className={cn(input, "mt-1.5")}
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    placeholder="Quick question, {{firstName}}"
                  />
                  <p className="mt-1.5 text-xs text-faint">
                    {mergeFields.length > 0
                      ? `Tags: ${mergeFields.map((f) => `{{${f}}}`).join(", ")}`
                      : "Upload contacts first to detect merge fields."}
                  </p>
                </div>
                <div>
                  <label className={label}>Body</label>
                  <div className="mt-1.5">
                    <RichTextEditor
                      value={bodyHtml}
                      onChange={setBodyHtml}
                      mergeFields={mergeFields}
                      placeholder="Hi {{firstName}}, I noticed {{company}} ..."
                    />
                  </div>
                </div>
              </>
            ) : csvHeaders.length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-amber-700">
                <ExclamationTriangleIcon className="h-4 w-4" strokeWidth={2} />
                Upload a CSV in the Contacts step to pick subject &amp; body
                columns.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted">
                  Each recipient gets the subject and body from their own row.
                  HTML tags in the body (<code className="font-mono text-[12px]">&lt;p&gt;</code>,{" "}
                  <code className="font-mono text-[12px]">&lt;br&gt;</code>,{" "}
                  <code className="font-mono text-[12px]">&lt;a&gt;</code>) render as
                  formatting, and tokens like{" "}
                  <code className="font-mono text-[12px]">{"{{first_name}}"}</code> are
                  filled from each row.
                </p>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label className={label}>Subject column</label>
                    <select
                      className={cn(input, "mt-1.5")}
                      value={subjectColumn}
                      onChange={(e) => setSubjectColumn(e.target.value)}
                    >
                      <option value="">Select a column…</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={label}>Body column (HTML)</label>
                    <select
                      className={cn(input, "mt-1.5")}
                      value={bodyColumn}
                      onChange={(e) => setBodyColumn(e.target.value)}
                    >
                      <option value="">Select a column…</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {preview && (
                  <div className="space-y-2 rounded-lg border border-line bg-canvas p-4">
                    <p className="text-xs font-medium uppercase tracking-wide text-faint">
                      Preview · first contact
                    </p>
                    <p className="text-sm">
                      <span className="text-muted">Subject: </span>
                      <span className="font-medium text-ink">
                        {preview.subject || (
                          <span className="text-faint">(empty)</span>
                        )}
                      </span>
                    </p>
                    {preview.body ? (
                      <div
                        className="prose-email max-h-64 overflow-auto rounded-md border border-line bg-surface px-3 py-2 text-ink"
                        dangerouslySetInnerHTML={{ __html: preview.body }}
                      />
                    ) : (
                      <p className="text-sm text-faint">
                        Pick a body column to preview.
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              Follow-ups reply within the same thread and are skipped
              automatically for contacts who already replied.
            </p>
            {followups.map((f, i) => (
              <div
                key={i}
                className="space-y-3 rounded-lg border border-line bg-canvas p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-ink">
                    Follow-up {i + 1}
                  </span>
                  <button
                    onClick={() =>
                      setFollowups((fs) => fs.filter((_, j) => j !== i))
                    }
                    className="inline-flex items-center gap-1 text-xs font-medium text-faint transition-colors hover:text-rose-300"
                  >
                    <TrashIcon className="h-3.5 w-3.5" strokeWidth={2} />
                    Remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Days after previous</label>
                    <input
                      type="number"
                      min={0}
                      className={cn(input, "mt-1.5 tabular-nums")}
                      value={f.delayDays}
                      onChange={(e) =>
                        setFollowups((fs) =>
                          fs.map((x, j) =>
                            j === i
                              ? { ...x, delayDays: Number(e.target.value) }
                              : x,
                          ),
                        )
                      }
                    />
                  </div>
                  <div>
                    <label className={label}>Condition</label>
                    <select
                      className={cn(input, "mt-1.5")}
                      value={f.condition}
                      onChange={(e) =>
                        setFollowups((fs) =>
                          fs.map((x, j) =>
                            j === i
                              ? { ...x, condition: e.target.value as Condition }
                              : x,
                          ),
                        )
                      }
                    >
                      <option value="NO_REPLY">If no reply</option>
                      <option value="NO_OPEN">If not opened</option>
                      <option value="ALWAYS">Always</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className={label}>
                    Subject override (blank = same thread)
                  </label>
                  <input
                    className={cn(input, "mt-1.5")}
                    value={f.subject}
                    onChange={(e) =>
                      setFollowups((fs) =>
                        fs.map((x, j) =>
                          j === i ? { ...x, subject: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
                {composeMode === "perRecipient" ? (
                  <div className="space-y-3">
                    <div>
                      <label className={label}>Body column (HTML, per recipient)</label>
                      <select
                        className={cn(input, "mt-1.5")}
                        value={f.bodyColumn}
                        onChange={(e) =>
                          setFollowups((fs) =>
                            fs.map((x, j) =>
                              j === i ? { ...x, bodyColumn: e.target.value } : x,
                            ),
                          )
                        }
                      >
                        <option value="">Select a column…</option>
                        {csvHeaders.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </div>
                    {f.bodyColumn && (
                      <div className="space-y-1.5 rounded-md border border-line bg-surface p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-faint">
                          Preview · first contact
                        </p>
                        {renderColumn(f.bodyColumn) ? (
                          <div
                            className="prose-email max-h-48 overflow-auto text-ink"
                            dangerouslySetInnerHTML={{ __html: renderColumn(f.bodyColumn) }}
                          />
                        ) : (
                          <p className="text-sm text-faint">
                            Empty for this contact.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    <label className={label}>Body</label>
                    <textarea
                      className={cn(input, "mt-1.5 min-h-[120px] font-mono")}
                      value={f.bodyHtml}
                      onChange={(e) =>
                        setFollowups((fs) =>
                          fs.map((x, j) =>
                            j === i ? { ...x, bodyHtml: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="Just bumping this up, {{firstName}}."
                    />
                  </div>
                )}
              </div>
            ))}
            <Button
              variant="secondary"
              onClick={() =>
                setFollowups((fs) => [
                  ...fs,
                  {
                    delayDays: 3,
                    condition: "NO_REPLY",
                    subject: "",
                    bodyHtml: "",
                    bodyColumn: "",
                  },
                ])
              }
            >
              <PlusIcon className="h-4 w-4" strokeWidth={2.25} />
              Add follow-up
            </Button>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-1">
            <Row k="Name" v={name} />
            <Row
              k="From"
              v={`${fromName || "(default)"} <${fromAlias || "primary address"}>`}
            />
            <Row k="Contacts" v={`${contactCount}`} />
            <Row
              k="Schedule"
              v={`${hourLabel(sendWindowStart)}–${hourLabel(sendWindowEnd)} ${timezone.replace(
                /_/g,
                " ",
              )}, cap ${dailyCap}/day`}
            />
            <Row k="Sequence" v={`Initial + ${followups.length} follow-up(s)`} />
            {composeMode === "single" ? (
              <Row k="Subject" v={subject} />
            ) : (
              <>
                <Row k="Personalization" v="Per recipient, from CSV columns" />
                <Row k="Subject column" v={subjectColumn} />
                <Row k="Body column" v={bodyColumn} />
              </>
            )}
            {error && (
              <p className="flex items-center gap-1.5 pt-3 text-sm text-rose-300">
                <ExclamationTriangleIcon className="h-4 w-4" strokeWidth={2} />
                {error}
              </p>
            )}
            <p className="pt-3 text-xs leading-relaxed text-faint">
              Creating also provisions the Google Sheet + Apps Script in your
              Drive automatically. You then authorize Gmail once from the Sheet.
            </p>
          </div>
        )}

        {/* Nav */}
        <div className="mt-6 flex items-center justify-between border-t border-line pt-5">
          <Button
            variant="ghost"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0 || submitting}
          >
            <ArrowLeftIcon className="h-4 w-4" strokeWidth={2} />
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep((s) => s + 1)} disabled={!canNext}>
              Next
              <ArrowRightIcon className="h-4 w-4" strokeWidth={2} />
            </Button>
          ) : (
            <Button onClick={submit} disabled={submitting}>
              {submitting ? (
                <ArrowPathIcon className="h-4 w-4 animate-spin" strokeWidth={2} />
              ) : (
                <RocketLaunchIcon className="h-4 w-4" strokeWidth={2} />
              )}
              {phase === "creating"
                ? "Creating…"
                : phase === "provisioning"
                  ? "Provisioning…"
                  : "Create & launch"}
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-line/70 py-2.5 text-sm last:border-0">
      <span className="shrink-0 text-muted">{k}</span>
      <span className="truncate text-right font-medium text-ink">{v}</span>
    </div>
  );
}
