/**
 * Settings: league settings (week, season, theme), system health, DB stats.
 */

import { getData, api } from '../api.js';
import { esc, pill, card, toast, armed, busy, delegate, fmtDate } from '../ui.js';
import { setContext } from '../main.js';

export const title = 'Settings';

let root = null;
let ctxRef = null;

export async function render(view, ctx) {
    ctxRef = ctx;
    root = document.createElement('div');
    root.className = 'stack';
    view.replaceChildren(root);
    delegate(root, {
        save: el => armed(el, () => save(el), 'Tap again to save')
    });
    await refresh();
}

export async function refresh() {
    if (!root) return;
    const [settings, health, tables] = await Promise.all([
        getData('/api/league/settings').catch(() => ({})),
        fetch('/health', { credentials: 'same-origin' }).then(r => r.json()).catch(() => null),
        getData('/api/database/tables').catch(() => null)
    ]);
    setContext(`${settings.league_name || ''}`);
    const t = health && health.tank01_stats || {};
    const tank = health ? health.services?.tank01 : null;
    const bigTables = tables ? Object.entries(tables).map(([n, v]) => [n, v.rowCount]).sort((a, b) => b[1] - a[1]).slice(0, 6) : [];
    root.innerHTML = `
        <div class="grid-2">
            ${card({ title: 'League', body: `
                <div class="grid-2" style="gap:12px">
                    <label class="field">Current week<input class="input" id="s-week" type="number" min="1" max="18" value="${esc(settings.current_week ?? '')}"></label>
                    <label class="field">Season<input class="input" id="s-season" type="number" min="2020" max="2030" value="${esc(settings.season_year ?? '')}"></label>
                    <label class="field">Theme<select class="input" id="s-theme">${['plain', 'christmas'].map(th => `<option value="${th}" ${(settings.theme || 'plain') === th ? 'selected' : ''}>${th}</option>`).join('')}</select></label>
                    <label class="field">League name<input class="input" id="s-name" value="${esc(settings.league_name ?? '')}"></label>
                </div>
                <div class="note warning">Changing the week by hand skips standings and roster copying. The normal path is the weekly update on the Sync tab (or Advance week on This week).</div>
                <div class="row end"><button class="btn primary" data-action="save">Save settings</button></div>
                <div class="muted">Max teams ${esc(settings.max_teams ?? '?')} · roster size ${esc(settings.roster_size ?? '?')} · scoring ${esc(settings.scoring_type ?? '?')} · last daily update ${fmtDate(settings.last_daily_update)} · last live update ${fmtDate(settings.last_live_update)}</div>` })}
            <div class="stack">
                ${card({ title: `System ${health ? pill(health.status === 'healthy' ? 'ok' : 'critical', health.status) : pill('critical', 'unreachable')}`, body: health ? `
                    <div>Database ${pill(health.services?.database === 'connected' ? 'ok' : 'critical', health.services?.database || '?')} · Tank01 ${pill(tank === 'healthy' ? 'ok' : tank === 'initialized' ? 'warning' : 'critical', tank || 'not configured')}</div>
                    <div class="grid-3" style="gap:12px">
                        <div class="stat"><b>${esc(t.daily_requests ?? '—')}</b><span>Tank01 requests today</span></div>
                        <div class="stat"><b>${esc(t.requests ?? '—')}</b><span>since start</span></div>
                        <div class="stat"><b>${esc(t.cache_size ?? '—')}</b><span>cached responses</span></div>
                    </div>
                    <div class="muted">version ${esc(health.version || '')} · checked ${fmtDate(health.timestamp)}</div>` : '<span class="err">/health did not answer</span>' })}
                ${card({ title: 'Database', body: bigTables.length ? `<div class="grid-3" style="gap:12px">${bigTables.map(([n, c]) => `<div class="stat"><b>${Number(c).toLocaleString()}</b><span>${esc(n)}</span></div>`).join('')}</div>` : '<span class="quiet">Table counts unavailable</span>' })}
            </div>
        </div>`;
}

async function save(button) {
    const week = Number(root.querySelector('#s-week').value);
    const season = Number(root.querySelector('#s-season').value);
    const theme = root.querySelector('#s-theme').value;
    const name = root.querySelector('#s-name').value.trim();
    const updates = {};
    if (week) updates.current_week = week;
    if (season) updates.season_year = season;
    if (theme) updates.theme = theme;
    if (name) updates.league_name = name;
    await busy(button, 'Saving…', async () => {
        try {
            const body = await api.put('/api/league/settings', updates);
            toast(body.message || 'Settings saved', 'success');
            location.reload();
        } catch (error) {
            toast(`Save failed: ${error.message}`, 'error');
        }
    });
}
