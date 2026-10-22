/**
 * Small rendering helpers shared by every area. HTML is built from template
 * strings with esc() on every dynamic value; events are delegated through
 * data-action attributes (no inline handlers, CSP-friendly).
 */

export function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function ago(ts) {
    if (!ts) return 'never';
    const ms = Date.now() - new Date(ts).getTime();
    if (Number.isNaN(ms)) return String(ts);
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
}

export function untilText(epochSec) {
    const ms = epochSec * 1000 - Date.now();
    const abs = Math.abs(ms);
    const h = Math.floor(abs / 3600000);
    const m = Math.floor((abs % 3600000) / 60000);
    const d = Math.floor(h / 24);
    const text = d >= 2 ? `${d}d ${h - d * 24}h` : h >= 1 ? `${h}h ${m}m` : `${m}m`;
    return ms >= 0 ? `in ${text}` : `${text} ago`;
}

export function fmtDate(ts, opts = {}) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts });
}

export function pill(kind, label) {
    return `<span class="pill ${esc(kind)}">${esc(label ?? kind)}</span>`;
}

export function severityOf(status) {
    if (['passed', 'PASS', 'ok', 'success', 'idle'].includes(status)) return 'ok';
    if (['warning', 'WARN', 'SKIPPED', 'warn'].includes(status)) return 'warning';
    if (['failed', 'FAIL', 'ERROR', 'critical', 'error'].includes(status)) return 'critical';
    return 'info';
}

export function checkIcon(status) {
    return status === 'passed' ? '✓' : status === 'warning' ? '!' : '✕';
}

export function checksList(checks) {
    return `<ul class="checks">${(checks || []).map(c =>
        `<li><span class="pill ${severityOf(c.status)}">${esc(c.status)}</span> <strong>${esc(c.name)}</strong>: ${esc(c.message)}</li>`
    ).join('')}</ul>`;
}

export function toast(message, kind = '') {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = `show ${kind}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 3500);
}

/**
 * Two-tap confirmation: the first click arms the button for 5 s, the second
 * runs `fn`. Replaces window.confirm() everywhere.
 */
export function armed(button, fn, armedLabel = 'Tap again to confirm') {
    if (button.classList.contains('armed')) {
        clearTimeout(button._arm);
        button.classList.remove('armed');
        button.textContent = button.dataset.label || button.textContent;
        return fn();
    }
    button.dataset.label = button.textContent;
    button.classList.add('armed');
    button.textContent = armedLabel;
    button._arm = setTimeout(() => {
        button.classList.remove('armed');
        button.textContent = button.dataset.label;
    }, 5000);
    return undefined;
}

/** Run an async action with the button disabled and a busy label. */
export async function busy(button, label, fn) {
    if (!button) return fn();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label;
    try {
        return await fn();
    } finally {
        button.disabled = false;
        button.textContent = original;
    }
}

export function card({ title, meta = '', actions = '', body = '', rows = null, id = '' }) {
    return `
        <section class="card"${id ? ` id="${esc(id)}"` : ''}>
            ${title !== undefined ? `<div class="card-head"><h2>${title}</h2><div class="row">${meta ? `<span class="muted">${meta}</span>` : ''}${actions}</div></div>` : ''}
            ${rows !== null ? rows : `<div class="card-body">${body}</div>`}
        </section>`;
}

/** Minimal markdown for recaps (same rules as server/utils/recapFiles.js). */
export function renderMarkdown(md) {
    // Mirror of server/utils/recapFiles.js markdownToHtml - keep the two in step.
    const inline = s => s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    const out = [];
    let list = null;
    let table = false;
    const closeBlocks = () => {
        if (list) { out.push(`</${list}>`); list = null; }
        if (table) { out.push('</table>'); table = false; }
    };
    for (const rawLine of esc(md).split('\n')) {
        const line = rawLine.trimEnd();
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^[-*]\s+(.*)$/.exec(line);
        const numbered = /^\d+\.\s+(.*)$/.exec(line);
        if (heading) { closeBlocks(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); }
        else if (/^(-{3,}|_{3,}|\*{3,})$/.test(line)) { closeBlocks(); out.push('<hr>'); }
        else if (line.startsWith('&gt;')) { closeBlocks(); out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`); }
        else if (/^\|.*\|$/.test(line)) {
            const cells = line.slice(1, -1).split('|').map(c => c.trim());
            if (cells.every(c => /^:?-+:?$/.test(c))) continue; // separator row
            if (list) { out.push(`</${list}>`); list = null; }
            if (!table) { out.push('<table>'); table = true; out.push(`<tr>${cells.map(c => `<th>${inline(c)}</th>`).join('')}</tr>`); }
            else out.push(`<tr>${cells.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`);
        }
        else if (bullet || numbered) {
            const type = bullet ? 'ul' : 'ol';
            if (table) { out.push('</table>'); table = false; }
            if (list !== type) { if (list) out.push(`</${list}>`); out.push(`<${type}>`); list = type; }
            out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
        }
        else if (line === '') closeBlocks();
        else { closeBlocks(); out.push(`<p>${inline(line)}</p>`); }
    }
    closeBlocks();
    return out.join('\n');
}

/** Bind data-action clicks inside `root` to handlers[action](el, event). */
export function delegate(root, handlers) {
    root.addEventListener('click', event => {
        const el = event.target.closest('[data-action]');
        if (!el || !root.contains(el)) return;
        const fn = handlers[el.dataset.action];
        if (fn) {
            event.preventDefault();
            fn(el, event);
        }
    });
}
