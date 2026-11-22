/**
 * PFL Admin shell: path-based router (/admin/<area>), sidebar badges, header
 * context, 60 s refresh while visible, Tailscale hand-off banner.
 *
 * Areas export { title, render(view, ctx), refresh?(), actions?() } and
 * receive ctx = { settings, teams, teamName(id), navigate(area, sub) }.
 */

import { getData, api } from './api.js';
import { esc, ago, toast } from './ui.js';
import * as thisweek from './areas/thisweek.js';
import * as status from './areas/status.js';
import * as moves from './areas/moves.js';
import * as data from './areas/data.js';
import * as recaps from './areas/recaps.js';
import * as podcast from './areas/podcast.js';
import * as settings from './areas/settings.js';

const AREAS = { thisweek, status, moves, data, recaps, podcast, settings };
const LEGACY_HASH = { sync: 'data', status: 'status', traffic: 'settings', players: 'moves', rosters: 'moves',
    database: 'data', tests: 'data', recaps: 'recaps', settings: 'settings' };
const REFRESH_MS = 60000;

const ctx = {
    settings: null,
    teams: [],
    teamName(id) {
        const t = this.teams.find(x => String(x.team_id) === String(id));
        return t ? (t.team_name || t.owner_name || `Team ${id}`) : `Team ${id}`;
    },
    navigate(area, sub) {
        history.pushState({}, '', `/admin/${area}${sub ? `?tab=${encodeURIComponent(sub)}` : ''}`);
        route();
    }
};

let current = null;
let currentName = null;

function areaFromLocation() {
    const m = location.pathname.match(/^\/admin(?:\/([a-z]+))?\/?$/);
    let name = m && m[1];
    if (!name || name === 'dashboard' || name === 'm') {
        const hash = location.hash.replace('#', '');
        name = LEGACY_HASH[hash] || 'thisweek';
    }
    return AREAS[name] ? name : 'thisweek';
}

async function loadContext() {
    try {
        const [s, t] = await Promise.all([getData('/api/league/settings'), getData('/api/teams')]);
        ctx.settings = s || {};
        ctx.teams = Array.isArray(t) ? t : (t && t.teams) || [];
        document.getElementById('brand-season').textContent = `${ctx.settings.season_year || '?'} season · week ${ctx.settings.current_week || '?'}`;
    } catch (error) {
        document.getElementById('brand-season').textContent = 'settings unavailable';
    }
}

async function loadBadges() {
    try {
        const [pending, alerts] = await Promise.all([
            getData('/api/admin/pending-moves').catch(() => null),
            getData('/api/admin/health/alerts?unacknowledged=true').catch(() => null)
        ]);
        const items = (pending && pending.items || []).filter(i => ['pending', 'needs_review', 'failed'].includes(i.status)); // failed executions still need you
        const unacked = alerts ? (alerts.actionableCount ?? alerts.unacknowledgedCount ?? (alerts.alerts || []).length) : 0;
        const critical = (alerts && alerts.alerts || []).filter(a => a.severity === 'critical').length;
        setBadge('moves', items.length);
        setBadge('thisweek', items.length + critical);
        setBadge('status', unacked);
        window.__pflBadges = { pending: items.length, unacked, critical };
    } catch (_) { /* badges are decoration */ }
}

function setBadge(area, count) {
    const el = document.querySelector(`[data-badge="${area}"]`);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle('hidden', !count);
}

async function loadFooter() {
    try {
        const s = await getData('/api/admin/status');
        const w = s && s.live && s.live.latest;
        const overallDot = document.getElementById('foot-verify-dot');
        const liveDot = document.getElementById('foot-live-dot');
        overallDot.className = `dot ${s.overall}`;
        const stale = (s.jobs || []).filter(j => j.reason === 'stale').length;
        document.getElementById('foot-verify').textContent = `Verification ${s.overall}${stale ? ` · ${stale} job${stale === 1 ? '' : 's'} not running` : ''}`;
        const openAlerts = (s.alerts && s.alerts.unacknowledged) || 0;
        const newShapes = (s.logErrors && s.logErrors.summary && s.logErrors.summary.newCount) || 0;
        const clearBtn = document.getElementById('foot-clear-alerts');
        clearBtn.textContent = openAlerts + newShapes ? `Clear all warnings (${openAlerts + newShapes})` : 'Clear all warnings';
        clearBtn.classList.toggle('hidden', !(openAlerts + newShapes));
        if (!w) {
            document.getElementById('foot-live').textContent = 'Live scoring: no watchdog data';
            return;
        }
        const wdJob = (s.jobs || []).find(j => j.job === 'watchdog');
        liveDot.className = `dot ${wdJob && wdJob.reason === 'stale' ? 'critical' : w.severity === 'ok' ? 'ok' : w.severity}`;
        document.getElementById('foot-live').textContent = wdJob && wdJob.reason === 'stale'
            ? `Watchdog silent ${ago(w.ts)}`
            : `Live scoring ${w.status}${w.loopAgeSec != null ? ` · loop ${w.loopAgeSec}s ago` : ''} · checked ${ago(w.ts)}`;
    } catch (_) { /* footer is decoration */ }
}

async function route() {
    const name = areaFromLocation();
    const mod = AREAS[name];
    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.area === name));
    const view = document.getElementById('view');
    const actions = document.getElementById('page-actions');
    if (current && current.destroy) current.destroy();
    current = mod;
    currentName = name;
    document.getElementById('page-title').textContent = mod.title;
    document.getElementById('page-context').textContent = '';
    document.title = `${mod.title} · PFL Admin`;
    actions.innerHTML = mod.actions ? mod.actions(ctx) : '';
    view.innerHTML = '<p class="quiet">Loading…</p>';
    try {
        await mod.render(view, ctx, { tab: new URLSearchParams(location.search).get('tab') });
    } catch (error) {
        view.innerHTML = `<p class="err">Failed to load ${esc(mod.title)}: ${esc(error.message)}</p>`;
    }
    // Hash links and browser history must land on their section after rendering.
    // Resetting to the top here used to undo the details link's native scroll.
    const headerHeight = document.querySelector('.topbar')?.getBoundingClientRect().height || 0;
    document.documentElement.style.scrollPaddingTop = `${headerHeight + 12}px`;
    let target = null;
    try {
        target = location.hash.length > 1
            ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
    } catch (_) { /* A malformed fragment falls back to the top. */ }
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' });
    else window.scrollTo(0, 0);
}

export function setContext(text) {
    document.getElementById('page-context').textContent = text || '';
}

async function refreshAll() {
    await Promise.all([loadContext(), loadBadges(), loadFooter()]);
    if (current && current.refresh) {
        try { await current.refresh(); } catch (_) { /* area handles its own errors */ }
    }
}

async function tailnetHandoff() {
    try {
        const info = await getData('/api/admin/context');
        if (!info || info.via !== 'session' || !info.tailnetUrl) return;
        if (location.hostname === new URL(info.tailnetUrl).hostname) return;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        await fetch(`${info.tailnetUrl}/tailnet-ping`, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        const link = document.getElementById('tailnet-link');
        link.href = info.tailnetUrl + location.pathname + location.search;
        document.getElementById('tailnet-banner').classList.remove('hidden');
    } catch (_) { /* not on the tailnet, or no tailnet configured */ }
}

/** Clear every open alert and every never-seen log error shape (POST /api/admin/warnings/clear). Used by the sidebar button. */
export async function clearAllAlerts(button) {
    if (button) button.disabled = true;
    try {
        const r = await api.post('/api/admin/warnings/clear', {});
        const d = (r && r.data) || r || {};
        toast(`Cleared ${d.alertsAcknowledged || 0} alert(s) and ${d.logShapesAcknowledged || 0} log error shape(s)`, 'success');
        await refreshAll();
    } catch (error) {
        toast(`Clear failed: ${error.message}`, 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

// Header/action buttons and nav clicks are delegated here
document.addEventListener('click', event => {
    const nav = event.target.closest('.nav-item');
    if (nav) {
        event.preventDefault();
        history.pushState({}, '', nav.getAttribute('href'));
        route();
        return;
    }
    if (event.target.closest('#foot-clear-alerts')) {
        event.preventDefault();
        clearAllAlerts(event.target.closest('#foot-clear-alerts'));
        return;
    }
    const act = event.target.closest('#page-actions [data-action]');
    if (act && current && current.onAction) {
        event.preventDefault();
        current.onAction(act.dataset.action, act, ctx);
    }
});
window.addEventListener('popstate', route);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshAll();
});
setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, REFRESH_MS);

(async () => {
    await loadContext();
    await route();
    loadBadges();
    loadFooter();
    tailnetHandoff();
})();

export { ctx, toast, api };
