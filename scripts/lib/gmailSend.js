/**
 * Shared Gmail sender for cron scripts (nightly tests, weekly validation).
 *
 * Uses the roster_moves Gmail OAuth credentials/token. Sending requires the
 * gmail.send scope - if the token predates that scope, re-run:
 *   node roster_moves/authSetup.js
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const REPO = path.join(__dirname, '../..');

async function sendGmail({ to, subject, body }) {
    const credentials = JSON.parse(fs.readFileSync(path.join(REPO, 'roster_moves/credentials.json')));
    const token = JSON.parse(fs.readFileSync(path.join(REPO, 'roster_moves/token.json')));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(token);
    const gmail = google.gmail({ version: 'v1', auth });

    const message = [
        `To: ${to}`,
        `Subject: ${subject}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        body
    ].join('\r\n');

    const raw = Buffer.from(message).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
}

module.exports = { sendGmail };
