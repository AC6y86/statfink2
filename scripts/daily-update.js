#!/usr/bin/env node
const axios = require('axios');
const { sendGmail } = require('./lib/gmailSend');

const NOTIFY_EMAIL = 'joe.paley@gmail.com';

// The daily update's validation includes the Week Advance Deadline check: the
// weekly update is manual, and an unadvanced week silently loses the next
// week's stats once it kicks off. When that check fails, email loudly.
async function emailAdvanceReminder(check) {
    const subject = 'statfink2: ADVANCE THE WEEK before kickoff';
    const body = [
        'The daily update flagged the week-advance deadline:',
        '',
        check.message,
        '',
        'Run the weekly update from the admin dashboard',
        '(or: node scripts/weekly-update-check.js) to advance the week.',
        'Live updates only poll the current week - until you advance,',
        "the new week's stats are not collected."
    ].join('\n');

    await sendGmail({ to: NOTIFY_EMAIL, subject, body });
    console.log(`[${new Date().toISOString()}] Week-advance reminder emailed to ${NOTIFY_EMAIL}`);
}

async function runDailyUpdate() {
    try {
        console.log(`[${new Date().toISOString()}] Starting daily update...`);

        const response = await axios.post('http://localhost:8000/api/internal/scheduler/daily', {}, {
            headers: {
                'Content-Type': 'application/json',
                'X-Internal-Token': 'statfink-internal-cron'
            },
            timeout: 300000 // 5 minute timeout
        });

        console.log(`[${new Date().toISOString()}] Daily update completed:`, response.data);

        const checks = response.data?.data?.results?.validation?.checks || [];
        const deadline = checks.find(c => c.name === 'Week Advance Deadline' && c.status === 'failed');
        if (deadline) {
            try {
                await emailAdvanceReminder(deadline);
            } catch (emailError) {
                console.error(`[${new Date().toISOString()}] Failed to email week-advance reminder:`, emailError.message);
            }
        }

        process.exit(0);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Daily update failed:`, error.message);
        if (error.response) {
            console.error(`Response status: ${error.response.status}`);
            console.error(`Response data:`, error.response.data);
        }
        process.exit(1);
    }
}

runDailyUpdate();
