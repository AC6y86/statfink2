'use strict';

/**
 * Run `claude -p` headlessly and return { exitCode, envelope, error }.
 * Shared by scripts/weekly-recap-run.js and scripts/recap-setup.js.
 */
const { spawn } = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '../..');

function envWithClaude() {
    const home = process.env.HOME || '/home/joepaley';
    const extra = [`${home}/.npm-global/bin`, `${home}/.local/bin`, '/usr/local/bin'];
    const cur = (process.env.PATH || '').split(':');
    return { ...process.env, PATH: [...extra.filter(p => !cur.includes(p)), ...cur].join(':') };
}

function runClaude(claudeArgs, { timeoutMs = 30 * 60 * 1000, cwd = REPO, input = null } = {}) {
    return new Promise((resolve) => {
        // `input` goes over stdin (claude -p reads stdin when no positional prompt
        // is given) - large prompts as argv elements fail with spawn E2BIG.
        const proc = spawn('claude', claudeArgs, { cwd, env: envWithClaude(), stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        if (input !== null) { proc.stdin.on('error', () => {}); proc.stdin.write(input); proc.stdin.end(); }
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });
        proc.on('error', err => { clearTimeout(timer); resolve({ exitCode: null, envelope: null, error: `Failed to spawn claude: ${err.message}` }); });
        proc.on('close', code => {
            clearTimeout(timer);
            if (timedOut) { resolve({ exitCode: code, envelope: null, error: `claude timed out after ${Math.round(timeoutMs / 60000)} minutes` }); return; }
            let envelope = null;
            try { envelope = JSON.parse(stdout); } catch (_) { /* non-JSON output */ }
            resolve({
                exitCode: code, envelope,
                error: code !== 0
                    ? `claude exited ${code}: ${(stderr || stdout).slice(-2000)}`
                    : (envelope && envelope.is_error ? `claude reported error: ${String(envelope.result).slice(-2000)}` : null)
            });
        });
    });
}

module.exports = { runClaude, envWithClaude };
