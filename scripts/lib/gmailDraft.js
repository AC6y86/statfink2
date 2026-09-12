/**
 * Create a Gmail draft in the league mailer account
 * (peninsula.football.mailer@gmail.com) using the roster_moves OAuth
 * credentials/token. Used by the admin Recaps tab: the chosen weekly recap
 * becomes a draft, and the commissioner adds recipients and sends it from
 * Gmail himself.
 *
 * Drafts require the gmail.compose scope. If the token predates it, re-run:
 *   node roster_moves/authSetup.js
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const REPO = path.join(__dirname, '../..');

async function createGmailDraft({ subject, text, html }) {
    const credentials = JSON.parse(fs.readFileSync(path.join(REPO, 'roster_moves/credentials.json')));
    const token = JSON.parse(fs.readFileSync(path.join(REPO, 'roster_moves/token.json')));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    auth.setCredentials(token);
    const gmail = google.gmail({ version: 'v1', auth });

    const boundary = 'statfink2-recap-boundary';
    const encodedSubject = `=?utf-8?B?${Buffer.from(subject).toString('base64')}?=`;
    // No To: header on purpose - recipients are added in Gmail before sending
    const message = [
        `Subject: ${encodedSubject}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        text,
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        html,
        `--${boundary}--`
    ].join('\r\n');

    const raw = Buffer.from(message).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const res = await gmail.users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw } }
    });
    return { draftId: res.data.id, messageId: res.data.message?.id || null };
}

module.exports = { createGmailDraft };
