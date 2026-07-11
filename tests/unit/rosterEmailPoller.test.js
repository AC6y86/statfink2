/**
 * Tests for the Gmail roster-email poller - quote stripping, Gmail payload
 * body extraction, fetch-window behavior, and failure/alert state machine.
 * googleapis and axios are mocked; last_check/token/credentials paths point
 * at tmp fixtures. No network, no real Gmail, no real server.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('axios');
jest.mock('googleapis', () => {
    const gmailMock = { users: { messages: { list: jest.fn(), get: jest.fn() } } };
    return {
        __gmailMock: gmailMock,
        google: {
            auth: {
                OAuth2: jest.fn().mockImplementation(() => ({
                    setCredentials: jest.fn(),
                    on: jest.fn()
                }))
            },
            gmail: jest.fn(() => gmailMock)
        }
    };
});

const axios = require('axios');
const { __gmailMock: gmail } = require('googleapis');
const poller = require('../../scripts/roster-email-poller');

const b64 = s => Buffer.from(s, 'utf-8').toString('base64');

function useTmpPaths({ withAuthFiles = true } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-'));
    poller.paths.credentials = path.join(dir, 'credentials.json');
    poller.paths.token = path.join(dir, 'token.json');
    poller.paths.lastCheck = path.join(dir, 'last_check.json');
    if (withAuthFiles) {
        fs.writeFileSync(poller.paths.credentials, JSON.stringify({
            installed: { client_id: 'id', client_secret: 'secret', redirect_uris: ['http://localhost'] }
        }));
        fs.writeFileSync(poller.paths.token, JSON.stringify({ access_token: 'tok', refresh_token: 'ref' }));
    }
    return dir;
}

/** One Gmail API message with a plain-text body. */
function gmailMessage(id, { from = 'chris@example.com', subject = 'move', body = 'drop X add Y' } = {}) {
    return {
        data: {
            id,
            threadId: `t-${id}`,
            payload: {
                mimeType: 'text/plain',
                headers: [
                    { name: 'From', value: from },
                    { name: 'Subject', value: subject },
                    { name: 'Date', value: 'Fri, 12 Jun 2026 12:00:00 -0500' }
                ],
                body: { data: b64(body) }
            }
        }
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    useTmpPaths();
    poller.state.consecutiveFailures = 0;
    poller.state.authAlertSent = false;
    poller.state.failureAlertSent = false;
    gmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });
    axios.post.mockResolvedValue({ data: { success: true, queued: false, reason: 'duplicate' } });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    console.log.mockRestore();
    console.error.mockRestore();
});

describe('extractLatestMessage (quote/forward stripping)', () => {
    test('strips "On ... wrote:" reply threads', () => {
        const body = 'Yes confirmed, drop Tank Dell for Joe Flacco.\n\nOn Tue, Jun 9, Joe wrote:\n> Did you want to make that move?\n> I will drop somebody else entirely';
        expect(poller.extractLatestMessage(body)).toBe('Yes confirmed, drop Tank Dell for Joe Flacco.');
    });

    test('strips Outlook "-----Original Message-----" blocks', () => {
        const body = 'Do the move please.\n\n----- Original Message -----\nFrom: Joe\ndrop everyone';
        expect(poller.extractLatestMessage(body)).toBe('Do the move please.');
    });

    test('strips forwarded message blocks', () => {
        const body = 'See below, approve it.\n\n---------- Forwarded message ---------\nFrom: someone';
        expect(poller.extractLatestMessage(body)).toBe('See below, approve it.');
    });

    test('strips "From: ... Sent:" (Outlook desktop) headers', () => {
        const body = 'Add Flacco drop Dell.\nFrom: Joe Paley\nSent: Tuesday\nold stuff';
        expect(poller.extractLatestMessage(body)).toBe('Add Flacco drop Dell.');
    });

    test('strips "> " quoted lines', () => {
        const body = 'Confirmed.\n\n> earlier message line one\n> line two';
        expect(poller.extractLatestMessage(body)).toBe('Confirmed.');
    });

    test('uses the EARLIEST quote marker when several are present', () => {
        const body = 'Real content.\nOn Monday Joe wrote:\nquoted\n----- Original Message -----\nolder';
        expect(poller.extractLatestMessage(body)).toBe('Real content.');
    });

    test('leaves a plain email untouched', () => {
        const body = 'Drop Tank Dell and pick up Joe Flacco. Thanks!';
        expect(poller.extractLatestMessage(body)).toBe(body);
    });
});

describe('extractBody (Gmail payload decoding)', () => {
    test('decodes a single-part text/plain payload', () => {
        const payload = { mimeType: 'text/plain', body: { data: b64('hello move') } };
        expect(poller.extractBody(payload)).toBe('hello move');
    });

    test('prefers text/plain from multipart/alternative', () => {
        const payload = {
            mimeType: 'multipart/alternative',
            parts: [
                { mimeType: 'text/html', body: { data: b64('<p>html version</p>') } },
                { mimeType: 'text/plain', body: { data: b64('plain version') } }
            ]
        };
        expect(poller.extractBody(payload)).toBe('plain version');
    });

    test('finds text/plain in nested multipart parts', () => {
        const payload = {
            mimeType: 'multipart/mixed',
            parts: [{
                mimeType: 'multipart/alternative',
                parts: [{ mimeType: 'text/plain', body: { data: b64('nested plain') } }]
            }]
        };
        expect(poller.extractBody(payload)).toBe('nested plain');
    });

    test('falls back to HTML and converts it to text', () => {
        const payload = {
            mimeType: 'multipart/alternative',
            parts: [{
                mimeType: 'text/html',
                body: { data: b64('<style>p{}</style><p>Drop Dell &amp; add Flacco</p><br/>thanks') }
            }]
        };
        const text = poller.extractBody(payload);
        expect(text).toContain('Drop Dell & add Flacco');
        expect(text).not.toMatch(/<[a-z]/i);
    });
});

describe('fetchRecentEmails', () => {
    test('uses newer_than:2d on first run (no last-check file)', async () => {
        await poller.fetchRecentEmails(gmail);
        expect(gmail.users.messages.list).toHaveBeenCalledWith(
            expect.objectContaining({ q: 'in:inbox newer_than:2d' })
        );
    });

    test('uses after:<date> once a last check is recorded', async () => {
        fs.writeFileSync(poller.paths.lastCheck, JSON.stringify({ lastCheck: '2026-06-12T15:00:00Z' }));
        await poller.fetchRecentEmails(gmail);
        const q = gmail.users.messages.list.mock.calls[0][0].q;
        expect(q).toMatch(/^in:inbox after:2026\/6\/\d+$/);
    });

    test('extracts headers, strips quotes, caps body at 5000 chars', async () => {
        gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
        gmail.users.messages.get.mockResolvedValue(gmailMessage('m1', {
            body: 'x'.repeat(6000) + '\nOn Tue Joe wrote:\n> old'
        }));

        const [email] = await poller.fetchRecentEmails(gmail);
        expect(email.gmailMessageId).toBe('m1');
        expect(email.from).toBe('chris@example.com');
        expect(email.subject).toBe('move');
        expect(email.body.length).toBe(5000);
        expect(email.body).not.toContain('wrote:');
    });
});

describe('poll behavior', () => {
    test('advances the fetch window only when every submission succeeds', async () => {
        gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: 'm1' }, { id: 'm2' }] } });
        gmail.users.messages.get
            .mockResolvedValueOnce(gmailMessage('m1'))
            .mockResolvedValueOnce(gmailMessage('m2'));
        // m1 submits fine, m2 fails -> window must NOT advance
        axios.post
            .mockResolvedValueOnce({ data: { queued: true, items: [{ id: 'pm-1' }], summary: 'ok' } })
            .mockRejectedValueOnce(new Error('server 500'));

        await poller.poll();
        expect(fs.existsSync(poller.paths.lastCheck)).toBe(false);

        // Next cycle everything succeeds -> window advances
        gmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });
        await poller.poll();
        expect(fs.existsSync(poller.paths.lastCheck)).toBe(true);
    });

    test('auth failure raises exactly one critical alert across repeated polls', async () => {
        gmail.users.messages.list.mockRejectedValue(new Error('invalid_grant: token expired'));

        await poller.poll();
        await poller.poll();

        const alerts = axios.post.mock.calls.filter(([url]) => url.includes('/health/alert'));
        expect(alerts.length).toBe(1);
        expect(alerts[0][1].severity).toBe('critical');
        expect(alerts[0][1].message).toContain('authSetup.js');
    });

    test('5 consecutive non-auth failures raise one critical alert', async () => {
        gmail.users.messages.list.mockRejectedValue(new Error('ECONNRESET'));

        for (let i = 0; i < 6; i++) await poller.poll();

        const alerts = axios.post.mock.calls.filter(([url]) => url.includes('/health/alert'));
        expect(alerts.length).toBe(1);
        expect(alerts[0][1].message).toContain('failed 5 times in a row');
    });

    test('successful poll after an alert posts a recovery notice and resets state', async () => {
        gmail.users.messages.list.mockRejectedValue(new Error('invalid_grant'));
        await poller.poll();
        expect(poller.state.authAlertSent).toBe(true);

        gmail.users.messages.list.mockResolvedValue({ data: { messages: [] } });
        await poller.poll();

        const recovery = axios.post.mock.calls.filter(([url, body]) =>
            url.includes('/health/alert') && body.severity === 'info');
        expect(recovery.length).toBe(1);
        expect(recovery[0][1].message).toContain('recovered');
        expect(poller.state.authAlertSent).toBe(false);
        expect(poller.state.consecutiveFailures).toBe(0);
    });

    test('emails with empty bodies are skipped, not submitted', async () => {
        gmail.users.messages.list.mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
        gmail.users.messages.get.mockResolvedValue(gmailMessage('m1', { body: '' }));

        await poller.poll();

        const submissions = axios.post.mock.calls.filter(([url]) => url.includes('/roster-email'));
        expect(submissions.length).toBe(0);
    });
});
