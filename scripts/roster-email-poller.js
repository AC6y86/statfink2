#!/usr/bin/env node
/**
 * Gmail poller for email-driven roster moves.
 *
 * Every 2 minutes: fetch new emails from the commissioner's Gmail (read-only),
 * strip quoted/forwarded thread content, and POST each to the server's
 * internal ingest endpoint. The SERVER does all the smart work (Claude parse,
 * validation dry-run, pending queue) and is authoritative for dedup, so
 * re-sending an email here is always harmless.
 *
 * Auth: roster_moves/credentials.json + token.json (gmail.readonly).
 * Token setup/refresh is interactive - run `node roster_moves/authSetup.js`.
 * This process never prompts; an expired token raises a critical health alert.
 */
const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { google } = require('googleapis');

const ROSTER_MOVES_DIR = path.join(__dirname, '../roster_moves');

// Overridable so tests can point at fixture files
const paths = {
    credentials: path.join(ROSTER_MOVES_DIR, 'credentials.json'),
    token: path.join(ROSTER_MOVES_DIR, 'token.json'),
    lastCheck: path.join(ROSTER_MOVES_DIR, 'last_check.json')
};

const BASE_URL = process.env.STATFINK_BASE_URL || 'http://localhost:8000';
const INTERNAL_TOKEN = 'statfink-internal-cron';
const POLL_INTERVAL_MS = 120000; // 2 minutes
const FAILURE_ALERT_THRESHOLD = 5;

const state = {
    consecutiveFailures: 0,
    authAlertSent: false,
    failureAlertSent: false
};

function log(msg) {
    console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function recordHealthAlert(severity, message) {
    try {
        await axios.post(`${BASE_URL}/api/internal/health/alert`, {
            severity,
            source: 'email-poller',
            message
        }, {
            headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
            timeout: 10000
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to record health alert:`, error.message);
    }
}

/** Non-interactive OAuth client. Throws if credentials/token are unusable. */
async function buildGmailClient() {
    const credentials = JSON.parse(await fs.readFile(paths.credentials, 'utf8'));
    const token = JSON.parse(await fs.readFile(paths.token, 'utf8'));
    const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
    const auth = new google.auth.OAuth2(client_id, client_secret, (redirect_uris || [])[0]);
    auth.setCredentials(token);
    // Persist refreshed access tokens so restarts don't re-refresh needlessly
    auth.on('tokens', async (tokens) => {
        try {
            const merged = { ...token, ...tokens };
            await fs.writeFile(paths.token, JSON.stringify(merged));
        } catch (e) { /* non-fatal */ }
    });
    return google.gmail({ version: 'v1', auth });
}

async function getLastCheckTime() {
    try {
        const data = JSON.parse(await fs.readFile(paths.lastCheck, 'utf8'));
        return data.lastCheck || null;
    } catch (err) {
        return null;
    }
}

async function saveLastCheckTime() {
    await fs.writeFile(paths.lastCheck, JSON.stringify({ lastCheck: new Date().toISOString() }));
}

/** Recursively pull text/plain (fallback text/html) out of a Gmail payload. */
function extractBody(payload) {
    function walk(part, want) {
        if (!part) return '';
        if (part.mimeType === want && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
            for (const p of part.parts) {
                const found = walk(p, want);
                if (found) return found;
            }
        }
        // Single-part messages have data at the top level regardless of want
        if (!part.parts && part.body?.data && want === 'any') {
            return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        return '';
    }
    let body = walk(payload, 'text/plain') || walk(payload, 'text/html') || walk(payload, 'any');
    // Crude HTML-to-text if only HTML was available
    if (/<[a-z][\s\S]*>/i.test(body)) {
        body = body.replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    }
    return body;
}

/** Keep only the latest message in a thread (strip quoted/forwarded content). */
function extractLatestMessage(body) {
    const quotePatterns = [
        /On .+? wrote:/i,
        /-----\s*Original Message\s*-----/i,
        /----------\s*Forwarded message\s*---------/i,
        /From:\s*[^\n]+\nSent:/i,
        /From:\s*[^\n]+\nDate:/i,
        /_{10,}/,
        /\n>\s+/,
        /wrote:\n/i,
        /\n\s*---+\s*\n/
    ];
    let earliest = body.length;
    for (const pattern of quotePatterns) {
        const match = body.match(pattern);
        if (match && match.index < earliest) earliest = match.index;
    }
    return body.substring(0, earliest).trim();
}

async function fetchRecentEmails(gmail) {
    const lastCheck = await getLastCheckTime();
    let query = 'in:inbox';
    if (lastCheck) {
        // Gmail after: has day granularity; server-side dedup handles overlap
        const d = new Date(lastCheck);
        query += ` after:${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    } else {
        query += ' newer_than:2d';
    }

    const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 50 });
    const messages = res.data.messages || [];
    const emails = [];

    for (const m of messages) {
        const msg = await gmail.users.messages.get({ userId: 'me', id: m.id });
        const headers = msg.data.payload.headers || [];
        const header = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
        const rawBody = extractBody(msg.data.payload);
        emails.push({
            gmailMessageId: msg.data.id,
            threadId: msg.data.threadId,
            from: header('From'),
            subject: header('Subject'),
            date: header('Date'),
            body: extractLatestMessage(rawBody).substring(0, 5000)
        });
    }
    return emails;
}

async function submitEmail(email) {
    const response = await axios.post(`${BASE_URL}/api/internal/roster-email`, email, {
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
        timeout: 180000 // parsing via headless claude can take a couple of minutes
    });
    return response.data;
}

async function poll() {
    try {
        const gmail = await buildGmailClient();
        const emails = await fetchRecentEmails(gmail);

        if (emails.length > 0) {
            log(`Fetched ${emails.length} email(s) to submit`);
        }

        let allOk = true;
        for (const email of emails) {
            if (!email.body) continue;
            try {
                const result = await submitEmail(email);
                if (result.queued) {
                    log(`Queued ${result.items.length} pending move(s) from ${email.from} (${result.summary})`);
                } else if (result.reason !== 'duplicate') {
                    log(`Email from ${email.from} not queued: ${result.reason}`);
                }
            } catch (error) {
                allOk = false;
                console.error(`[${new Date().toISOString()}] Failed to submit email ${email.gmailMessageId}:`, error.message);
            }
        }

        // Advance the fetch window only when every submission succeeded, so
        // failed emails are retried next cycle (server dedups re-sends)
        if (allOk) {
            await saveLastCheckTime();
        }

        if (state.authAlertSent || state.failureAlertSent) {
            await recordHealthAlert('info', 'Email poller recovered');
        }
        state.consecutiveFailures = 0;
        state.authAlertSent = false;
        state.failureAlertSent = false;

    } catch (error) {
        state.consecutiveFailures++;
        const isAuthError = /invalid_grant|invalid_credentials|No refresh token|ENOENT.*token\.json/i.test(error.message);
        console.error(`[${new Date().toISOString()}] Poll failed${isAuthError ? ' (AUTH)' : ''}:`, error.message);

        if (isAuthError && !state.authAlertSent) {
            state.authAlertSent = true;
            await recordHealthAlert('critical',
                `Gmail authentication failed (${error.message}) - run "node roster_moves/authSetup.js" to re-authorize`);
        } else if (!isAuthError && state.consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !state.failureAlertSent) {
            state.failureAlertSent = true;
            await recordHealthAlert('critical',
                `Email poller has failed ${state.consecutiveFailures} times in a row (last error: ${error.message})`);
        }
    }
}

if (require.main === module) {
    log(`Roster email poller starting (server: ${BASE_URL}, interval: ${POLL_INTERVAL_MS / 1000}s)`);
    poll();
    setInterval(poll, POLL_INTERVAL_MS);

    process.on('SIGTERM', () => { log('SIGTERM received, shutting down'); process.exit(0); });
    process.on('SIGINT', () => { log('SIGINT received, shutting down'); process.exit(0); });
}

module.exports = {
    extractBody,
    extractLatestMessage,
    fetchRecentEmails,
    submitEmail,
    buildGmailClient,
    getLastCheckTime,
    saveLastCheckTime,
    recordHealthAlert,
    poll,
    paths,
    state,
    FAILURE_ALERT_THRESHOLD
};
