"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Papa from "papaparse";
import { RichTextEditor } from "@/components/RichTextEditor";

type Role = "ignore" | "email" | "firstName" | "lastName" | "company" | "custom";
type Condition = "NO_REPLY" | "NO_OPEN" | "ALWAYS";
type Followup = {
  delayDays: number;
  condition: Condition;
  subject: string;
  bodyHtml: string;
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

const input =
  "w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:border-neutral-900 focus:outline-none";
const label = "block text-sm font-medium text-neutral-700";

export function NewCampaignWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 0 — details
  const [name, setName] = useState("");
  const [fromName, setFromName] = useState("");
  const [fromAlias, setFromAlias] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const [sendWindowStart, setSendWindowStart] = useState(9);
  const [sendWindowEnd, setSendWindowEnd] = useState(17);
  const [dailyCap, setDailyCap] = useState(500);

  // Step 1 — contacts
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvRows, setCsvRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, Role>>({});

  // Step 2 — compose
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");

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
    [csvRows, mapping, emailMapped],
  );

  const canNext =
    (step === 0 && name.trim().length > 0) ||
    (step === 1 && emailMapped && contactCount > 0) ||
    (step === 2 && subject.trim() && bodyHtml.trim()) ||
    step === 3 ||
    step === 4;

  async function submit() {
    setSubmitting(true);
    setError(null);
    const payload = {
      name,
      fromName: fromName || null,
      fromAlias: fromAlias || null,
      timezone,
      sendWindowStart,
      sendWindowEnd,
      dailyCap,
      subject,
      bodyHtml,
      steps: followups.map((f) => ({
        delayDays: f.delayDays,
        condition: f.condition,
        subject: f.subject || null,
        bodyHtml: f.bodyHtml || null,
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
        setSubmitting(false);
        return;
      }
      const c = await res.json();
      router.push(`/campaigns/${c.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create campaign.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mt-6">
      {/* Stepper */}
      <ol className="mb-6 flex flex-wrap gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={`rounded-full px-3 py-1 font-medium ${
              i === step
                ? "bg-neutral-900 text-white"
                : i < step
                  ? "bg-green-100 text-green-700"
                  : "bg-neutral-100 text-neutral-500"
            }`}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      <div className="rounded-xl border border-neutral-200 bg-white p-6">
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <label className={label}>Campaign name</label>
              <input
                className={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Q3 outreach — getpickcel.com"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={label}>From name</label>
                <input
                  className={input}
                  value={fromName}
                  onChange={(e) => setFromName(e.target.value)}
                  placeholder="Pranav from Pickcel"
                />
              </div>
              <div>
                <label className={label}>Send-as alias</label>
                <input
                  className={input}
                  value={fromAlias}
                  onChange={(e) => setFromAlias(e.target.value)}
                  placeholder="you@getpickcel.com"
                />
              </div>
            </div>
            <div>
              <label className={label}>Timezone</label>
              <input
                className={input}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className={label}>Send from (hour)</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  className={input}
                  value={sendWindowStart}
                  onChange={(e) => setSendWindowStart(Number(e.target.value))}
                />
              </div>
              <div>
                <label className={label}>Send until (hour)</label>
                <input
                  type="number"
                  min={1}
                  max={24}
                  className={input}
                  value={sendWindowEnd}
                  onChange={(e) => setSendWindowEnd(Number(e.target.value))}
                />
              </div>
              <div>
                <label className={label}>Daily cap</label>
                <input
                  type="number"
                  min={1}
                  className={input}
                  value={dailyCap}
                  onChange={(e) => setDailyCap(Number(e.target.value))}
                />
              </div>
            </div>
            <p className="text-xs text-neutral-500">
              Workspace sends ~1,500/day via Apps Script — the script also stops
              automatically when your Gmail quota is exhausted.
            </p>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <label className={label}>Upload contacts (CSV)</label>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                className="mt-1 text-sm"
              />
            </div>
            {csvHeaders.length > 0 && (
              <>
                <p className="text-sm text-neutral-500">
                  {csvRows.length} rows · map each column. An{" "}
                  <strong>email</strong> column is required.
                </p>
                <div className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
                  {csvHeaders.map((h) => (
                    <div
                      key={h}
                      className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-neutral-700">{h}</span>
                      <select
                        className="rounded-md border border-neutral-300 px-2 py-1 text-sm"
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
                {!emailMapped && (
                  <p className="text-sm text-red-600">
                    Map one column to <strong>Email</strong> to continue.
                  </p>
                )}
                {emailMapped && (
                  <p className="text-sm text-green-700">
                    {contactCount} valid contacts (deduplicated by email on save).
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className={label}>Subject</label>
              <input
                className={input}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Quick question, {{firstName}}"
              />
              {mergeFields.length > 0 ? (
                <p className="mt-1 text-xs text-neutral-500">
                  Tags: {mergeFields.map((f) => `{{${f}}}`).join(", ")}
                </p>
              ) : (
                <p className="mt-1 text-xs text-neutral-500">
                  Upload contacts first to detect merge fields.
                </p>
              )}
            </div>
            <div>
              <label className={label}>Body</label>
              <div className="mt-1">
                <RichTextEditor
                  value={bodyHtml}
                  onChange={setBodyHtml}
                  mergeFields={mergeFields}
                  placeholder="Hi {{firstName}}, I noticed {{company}} ..."
                />
              </div>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-neutral-500">
              Follow-ups reply within the same thread. They&apos;re skipped
              automatically for contacts who already replied.
            </p>
            {followups.map((f, i) => (
              <div
                key={i}
                className="space-y-3 rounded-lg border border-neutral-200 p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Follow-up {i + 1}</span>
                  <button
                    onClick={() =>
                      setFollowups((fs) => fs.filter((_, j) => j !== i))
                    }
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={label}>Days after previous</label>
                    <input
                      type="number"
                      min={0}
                      className={input}
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
                      className={input}
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
                    className={input}
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
                <div>
                  <label className={label}>Body</label>
                  <textarea
                    className={`${input} min-h-[120px] font-mono`}
                    value={f.bodyHtml}
                    onChange={(e) =>
                      setFollowups((fs) =>
                        fs.map((x, j) =>
                          j === i ? { ...x, bodyHtml: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder={"Just bumping this up, {{firstName}}."}
                  />
                </div>
              </div>
            ))}
            <button
              onClick={() =>
                setFollowups((fs) => [
                  ...fs,
                  { delayDays: 3, condition: "NO_REPLY", subject: "", bodyHtml: "" },
                ])
              }
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50"
            >
              + Add follow-up
            </button>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-sm">
            <Row k="Name" v={name} />
            <Row k="From" v={`${fromName || "(default)"} <${fromAlias || "default"}>`} />
            <Row k="Contacts" v={`${contactCount}`} />
            <Row k="Window" v={`${sendWindowStart}:00–${sendWindowEnd}:00 ${timezone}, cap ${dailyCap}/day`} />
            <Row k="Sequence" v={`Initial + ${followups.length} follow-up(s)`} />
            <Row k="Subject" v={subject} />
            {error && <p className="text-red-600">{error}</p>}
            <p className="text-xs text-neutral-500">
              Creating saves a draft. You&apos;ll provision the Sheet + script on
              the next screen.
            </p>
          </div>
        )}

        {/* Nav */}
        <div className="mt-6 flex justify-between">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:opacity-40"
          >
            Back
          </button>
          {step < STEPS.length - 1 ? (
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canNext}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
            >
              Next
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={submitting}
              className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create campaign"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between border-b border-neutral-100 pb-2">
      <span className="text-neutral-500">{k}</span>
      <span className="font-medium text-neutral-900">{v}</span>
    </div>
  );
}
