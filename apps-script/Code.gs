/**
 * Gmail Campaigns — bound Apps Script sending engine.
 *
 * Lives inside the per-campaign Google Sheet that the web app provisions into
 * the sender's Drive. Reads contacts + config from the sheet, sends
 * personalized mail on a time-driven trigger (using the sender's OWN Gmail
 * quota), threads follow-ups, detects replies, and posts events back to the
 * web app's ingest endpoint.
 *
 * Tabs:
 *   Config    — key | value
 *   Sequence  — stepOrder | delayDays | condition | subject | bodyHtml
 *   Contacts  — contactId | email | firstName | lastName | company | fieldsJson
 *               | status | currentStep | threadId | lastSentAt | nextSendAt | error
 */

var SHEET = { CONFIG: 'Config', SEQUENCE: 'Sequence', CONTACTS: 'Contacts' };
var TERMINAL = ['REPLIED', 'BOUNCED', 'UNSUBSCRIBED', 'COMPLETED', 'FAILED'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Campaign')
    .addItem('Authorize + install triggers', 'authorize')
    .addItem('Send now (process queue)', 'processQueue')
    .addItem('Check replies', 'checkReplies')
    .addToUi();
}

/** First-run: forces OAuth consent for Gmail + triggers, then schedules them. */
function authorize() {
  GmailApp.getAliases();
  installTriggers();
  SpreadsheetApp.getActiveSpreadsheet().toast('Authorized. Sending is now live.', 'Campaign', 5);
}

function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processQueue').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('checkReplies').timeBased().everyMinutes(5).create();
}

// ── Main queue processing ─────────────────────────────────────────────────
function processQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    var cfg = getConfig_();
    var steps = getSteps_();
    if (!steps.length) return;
    if (String(cfg.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return; // paused / completed

    var tz = cfg.timezone || Session.getScriptTimeZone();
    var now = new Date();
    var hour = Number(Utilities.formatDate(now, tz, 'H'));
    var startH = Number(cfg.sendWindowStart != null ? cfg.sendWindowStart : 9);
    var endH = Number(cfg.sendWindowEnd != null ? cfg.sendWindowEnd : 17);
    if (hour < startH || hour >= endH) return; // outside the sending window

    var dailyCap = Number(cfg.dailyCap || 500);
    var budget = Math.min(dailyCap, MailApp.getRemainingDailyQuota());
    if (budget <= 0) return;

    var sh = sheet_(SHEET.CONTACTS);
    var values = sh.getDataRange().getValues();
    var col = indexHeader_(values[0]);

    for (var r = 1; r < values.length && budget > 0; r++) {
      var row = values[r];
      var email = row[col.email];
      if (!email) continue;
      var status = String(row[col.status] || 'QUEUED').toUpperCase();
      if (TERMINAL.indexOf(status) !== -1) continue;

      var currentStep = Number(row[col.currentStep] || 0);
      var step = stepFor_(steps, currentStep);
      if (!step) { setCell_(sh, r, col.status, 'COMPLETED'); continue; }

      var nextSendAt = row[col.nextSendAt] ? new Date(row[col.nextSendAt]) : now;
      if (nextSendAt > now) continue; // not due yet

      // Follow-up gating
      if (currentStep > 0) {
        if (step.condition === 'NO_REPLY' && status === 'REPLIED') continue;
        if (step.condition === 'NO_OPEN' && status === 'OPENED') {
          advance_(sh, r, col, steps, currentStep, now);
          continue;
        }
      }

      try {
        var sent = sendOne_(cfg, step, row, col, values[0]);
        if (sent.threadId) setCell_(sh, r, col.threadId, sent.threadId);
        setCell_(sh, r, col.lastSentAt, now);
        setCell_(sh, r, col.status, 'SENT');
        setCell_(sh, r, col.error, '');
        postEvent_(cfg, {
          type: 'SENT',
          contactId: row[col.contactId],
          email: email,
          stepOrder: currentStep,
          threadId: sent.threadId,
        });
        advance_(sh, r, col, steps, currentStep, now);
        budget--;
        Utilities.sleep(1200); // gentle pacing between sends
      } catch (err) {
        setCell_(sh, r, col.status, 'FAILED');
        setCell_(sh, r, col.error, String(err));
        postEvent_(cfg, {
          type: 'FAILED', contactId: row[col.contactId],
          email: email, stepOrder: currentStep, error: String(err),
        });
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function sendOne_(cfg, step, row, col, header) {
  var email = String(row[col.email]);
  var data = mergeData_(row, col, header);
  var subject = renderTemplate_(step.subject || cfg.defaultSubject || '', data);
  var html = renderTemplate_(step.bodyHtml || cfg.defaultBodyHtml || '', data);

  var base = cfg.trackingBaseUrl;
  var cid = row[col.contactId];
  // Open/click tracking is opt-in. A tracking pixel and links rewritten through
  // a redirect domain are strong spam/phishing signals — especially for
  // personal-looking Gmail→Gmail mail — so they're only added when enabled.
  if (base && String(cfg.trackClicks) === 'true') {
    html = wrapLinks_(html, base, cfg.campaignId, cid);
  }
  if (base && String(cfg.trackOpens) === 'true') {
    html += openPixel_(base, cfg.campaignId, cid, step.stepOrder);
  }
  // No default unsubscribe footer — only append a block the campaign explicitly
  // provides.
  if (cfg.unsubscribeHtml) {
    html += String(cfg.unsubscribeHtml);
  }

  var plain = stripHtml_(html);
  var options = { htmlBody: html };
  if (cfg.fromName) options.name = String(cfg.fromName);
  if (cfg.fromAlias) options.from = String(cfg.fromAlias); // must be a verified send-as

  // Follow-ups reply into the existing thread.
  var threadId = row[col.threadId];
  if (step.stepOrder > 0 && threadId) {
    var thread = GmailApp.getThreadById(String(threadId));
    if (thread) {
      thread.reply(plain, options);
      return { threadId: String(threadId) };
    }
  }

  // Initial send: send via a draft so Gmail hands us back the actual message —
  // and therefore the thread id — deterministically. Searching for the thread
  // right after sendEmail() is unreliable (the message often isn't indexed yet),
  // which previously left threadId blank and broke reply/bounce detection.
  var sentMsg = GmailApp.createDraft(email, subject, plain, options).send();
  var newThreadId = '';
  try {
    newThreadId = sentMsg.getThread().getId();
  } catch (e) {
    var found = GmailApp.search('in:sent to:' + email + ' newer_than:1d', 0, 1);
    newThreadId = found && found.length ? found[0].getId() : '';
  }
  return { threadId: newThreadId };
}

function advance_(sh, r, col, steps, currentStep, now) {
  var next = nextStepAfter_(steps, currentStep);
  if (!next) {
    setCell_(sh, r, col.status, 'COMPLETED');
    return;
  }
  var nextDate = new Date(now.getTime() + (Number(next.delayDays) || 0) * 86400000);
  setCell_(sh, r, col.currentStep, next.stepOrder);
  setCell_(sh, r, col.nextSendAt, nextDate);
}

// ── Reply detection ───────────────────────────────────────────────────────
function checkReplies() {
  var cfg = getConfig_();
  var sh = sheet_(SHEET.CONTACTS);
  var values = sh.getDataRange().getValues();
  var col = indexHeader_(values[0]);

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var status = String(row[col.status] || '').toUpperCase();
    if (TERMINAL.indexOf(status) !== -1 || status === 'QUEUED') continue;

    var contactEmail = String(row[col.email] || '').toLowerCase();
    if (!contactEmail) continue;

    var threadId = row[col.threadId];
    var thread = threadId ? GmailApp.getThreadById(String(threadId)) : null;

    // Recover a missing thread id (e.g. sent before this fix) by searching the
    // user's sent mail, then backfill it so future runs are cheap.
    if (!thread) {
      var recovered = GmailApp.search('in:sent to:' + contactEmail, 0, 1);
      if (recovered && recovered.length) {
        thread = recovered[0];
        setCell_(sh, r, col.threadId, thread.getId());
      }
    }
    if (!thread) continue;

    var msgs = thread.getMessages();
    var replied = false;
    var bounced = false;
    for (var m = 0; m < msgs.length; m++) {
      var from = msgs[m].getFrom().toLowerCase();
      if (from.indexOf('mailer-daemon') !== -1 || from.indexOf('postmaster') !== -1) {
        bounced = true;
      } else if (from.indexOf(contactEmail) !== -1) {
        replied = true;
        break;
      }
    }
    if (replied) {
      setCell_(sh, r, col.status, 'REPLIED');
      postEvent_(cfg, { type: 'REPLY', contactId: row[col.contactId], email: row[col.email] });
    } else if (bounced) {
      setCell_(sh, r, col.status, 'BOUNCED');
      postEvent_(cfg, { type: 'BOUNCE', contactId: row[col.contactId], email: row[col.email] });
    }
  }
}

// ── Rendering + tracking helpers ──────────────────────────────────────────
function mergeData_(row, col, header) {
  var data = {};
  for (var c = 0; c < header.length; c++) data[String(header[c])] = row[c];
  if (col.fieldsJson != null && row[col.fieldsJson]) {
    try {
      var extra = JSON.parse(row[col.fieldsJson]);
      for (var k in extra) data[k] = extra[k];
    } catch (e) {}
  }
  return data;
}

function renderTemplate_(tpl, data) {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, function (_, key) {
    return data[key] != null ? String(data[key]) : '';
  });
}

function wrapLinks_(html, base, campaignId, contactId) {
  return html.replace(/href="(https?:\/\/[^"]+)"/g, function (_, url) {
    return 'href="' + base + '/api/track/click?c=' + encodeURIComponent(campaignId) +
      '&u=' + encodeURIComponent(contactId) + '&url=' + encodeURIComponent(url) + '"';
  });
}

function openPixel_(base, campaignId, contactId, stepOrder) {
  return '<img src="' + base + '/api/track/open?c=' + encodeURIComponent(campaignId) +
    '&u=' + encodeURIComponent(contactId) + '&s=' + encodeURIComponent(stepOrder) +
    '" width="1" height="1" alt="" style="display:none">';
}

function stripHtml_(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function postEvent_(cfg, payload) {
  if (!cfg.ingestUrl) return;
  try {
    UrlFetchApp.fetch(cfg.ingestUrl, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Ingest-Secret': String(cfg.ingestSecret || '') },
      payload: JSON.stringify(Object.assign({ campaignId: cfg.campaignId }, payload)),
      muteHttpExceptions: true,
    });
  } catch (e) {}
}

// ── Sheet plumbing ────────────────────────────────────────────────────────
function getConfig_() {
  var rows = sheet_(SHEET.CONFIG).getDataRange().getValues();
  var cfg = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] !== '' && rows[i][0] != null) cfg[String(rows[i][0]).trim()] = rows[i][1];
  }
  return cfg;
}

function getSteps_() {
  var rows = sheet_(SHEET.SEQUENCE).getDataRange().getValues();
  var steps = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === '' || rows[i][0] == null) continue;
    steps.push({
      stepOrder: Number(rows[i][0]),
      delayDays: Number(rows[i][1] || 0),
      condition: String(rows[i][2] || 'NO_REPLY'),
      subject: rows[i][3] ? String(rows[i][3]) : '',
      bodyHtml: rows[i][4] ? String(rows[i][4]) : '',
    });
  }
  steps.sort(function (a, b) { return a.stepOrder - b.stepOrder; });
  return steps;
}

function stepFor_(steps, n) {
  for (var i = 0; i < steps.length; i++) if (steps[i].stepOrder === n) return steps[i];
  return null;
}

function nextStepAfter_(steps, n) {
  for (var i = 0; i < steps.length; i++) if (steps[i].stepOrder > n) return steps[i];
  return null;
}

function sheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function indexHeader_(header) {
  var idx = {};
  for (var c = 0; c < header.length; c++) idx[String(header[c]).trim()] = c;
  return {
    contactId: idx.contactId, email: idx.email, firstName: idx.firstName,
    lastName: idx.lastName, company: idx.company, fieldsJson: idx.fieldsJson,
    status: idx.status, currentStep: idx.currentStep, threadId: idx.threadId,
    lastSentAt: idx.lastSentAt, nextSendAt: idx.nextSendAt, error: idx.error,
  };
}

function setCell_(sh, rowIndex, colIndex, value) {
  if (colIndex == null) return;
  sh.getRange(rowIndex + 1, colIndex + 1).setValue(value);
}
