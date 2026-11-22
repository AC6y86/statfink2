// The PFL Cast web player (peninsulafootball.com/podcast).
// Progressive enhancement: each episode ships a plain <audio controls>; this
// replaces the controls with a custom player (play/pause, seek bar with
// buffered + played fill, back 15 / forward 30, speed, elapsed/remaining),
// keeps only one episode playing at a time, remembers where you stopped, and
// fills in the phone lock screen via the Media Session API.

const SPEEDS = [1, 1.25, 1.5, 2];
const players = [];

function fmt(sec) {
    if (!Number.isFinite(sec) || sec < 0) return '0:00';
    const s = Math.floor(sec % 60);
    const m = Math.floor(sec / 60) % 60;
    const h = Math.floor(sec / 3600);
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}

const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* private mode */ } }
};

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">15</text></svg>';
const ICON_FWD = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" fill="currentColor"/><text x="12" y="16.5" font-size="6.5" text-anchor="middle" fill="currentColor" font-family="sans-serif" font-weight="700">30</text></svg>';

function build(box) {
    const audio = box.querySelector('audio');
    if (!audio) return;
    const title = box.dataset.title || 'The PFL Cast';
    const key = `pflcast:pos:${box.dataset.file || audio.currentSrc}`;
    audio.removeAttribute('controls');
    audio.preload = 'metadata';

    const ui = document.createElement('div');
    ui.className = 'pl';
    ui.innerHTML = `
        <button class="pl-play" type="button" aria-label="Play ${title.replace(/"/g, '&quot;')}">${ICON_PLAY}</button>
        <div class="pl-main">
            <div class="pl-bar">
                <div class="pl-track"><div class="pl-buf"></div><div class="pl-fill"></div><div class="pl-knob"></div></div>
                <input class="pl-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek">
            </div>
            <div class="pl-row">
                <span class="pl-time"><span class="pl-cur">0:00</span> / <span class="pl-dur">--:--</span></span>
                <span class="pl-btns">
                    <button class="pl-skip" type="button" data-skip="-15" aria-label="Back 15 seconds">${ICON_BACK}</button>
                    <button class="pl-skip" type="button" data-skip="30" aria-label="Forward 30 seconds">${ICON_FWD}</button>
                    <button class="pl-speed" type="button" aria-label="Playback speed">1×</button>
                </span>
            </div>
        </div>`;
    audio.after(ui);

    const $ = s => ui.querySelector(s);
    const play = $('.pl-play');
    const seek = $('.pl-seek');
    const fill = $('.pl-fill');
    const knob = $('.pl-knob');
    const buf = $('.pl-buf');
    const cur = $('.pl-cur');
    const dur = $('.pl-dur');
    const speed = $('.pl-speed');
    let dragging = false;

    const pct = () => (audio.duration ? audio.currentTime / audio.duration : 0);
    function paint(p = pct()) {
        const w = `${(p * 100).toFixed(2)}%`;
        fill.style.width = w;
        knob.style.left = w;
        if (!dragging) seek.value = Math.round(p * 1000);
        cur.textContent = fmt(dragging ? p * audio.duration : audio.currentTime);
        dur.textContent = audio.duration ? fmt(audio.duration) : '--:--';
    }
    function paintBuffered() {
        if (!audio.duration || !audio.buffered.length) return;
        buf.style.width = `${(audio.buffered.end(audio.buffered.length - 1) / audio.duration) * 100}%`;
    }
    function setPlaying(on) {
        play.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
        play.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} ${title}`);
        box.classList.toggle('is-playing', on);
        const card = box.closest('.ep');
        if (card) card.classList.toggle('is-playing', on);
    }

    play.addEventListener('click', () => (audio.paused ? audio.play() : audio.pause()));
    ui.querySelectorAll('.pl-skip').forEach(b => b.addEventListener('click', () => {
        audio.currentTime = Math.min(Math.max(0, audio.currentTime + Number(b.dataset.skip)), audio.duration || Infinity);
        paint();
    }));
    speed.addEventListener('click', () => {
        const next = SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length] || 1;
        audio.playbackRate = next;
        speed.textContent = `${next}×`;
        store.set('pflcast:speed', String(next));
    });
    seek.addEventListener('input', () => { dragging = true; paint(seek.value / 1000); });
    seek.addEventListener('change', () => {
        dragging = false;
        if (audio.duration) audio.currentTime = (seek.value / 1000) * audio.duration;
        paint();
    });

    audio.addEventListener('loadedmetadata', () => {
        const saved = Number(store.get(key));
        if (saved > 5 && saved < audio.duration - 10) audio.currentTime = saved;
        const sp = Number(store.get('pflcast:speed'));
        if (SPEEDS.includes(sp)) { audio.playbackRate = sp; speed.textContent = `${sp}×`; }
        paint();
    });
    audio.addEventListener('timeupdate', () => {
        paint();
        if (Math.floor(audio.currentTime) % 5 === 0) store.set(key, String(Math.floor(audio.currentTime)));
    });
    audio.addEventListener('progress', paintBuffered);
    audio.addEventListener('play', () => {
        players.forEach(p => { if (p !== audio && !p.paused) p.pause(); });
        setPlaying(true);
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({ title, artist: 'The PFL Cast', album: 'Peninsula Football League' });
            navigator.mediaSession.setActionHandler('play', () => audio.play());
            navigator.mediaSession.setActionHandler('pause', () => audio.pause());
            navigator.mediaSession.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
            navigator.mediaSession.setActionHandler('seekforward', () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30); });
        }
    });
    audio.addEventListener('pause', () => { setPlaying(false); store.set(key, String(Math.floor(audio.currentTime))); });
    audio.addEventListener('ended', () => { setPlaying(false); store.del(key); paint(0); });
    audio.addEventListener('waiting', () => box.classList.add('is-loading'));
    audio.addEventListener('playing', () => box.classList.remove('is-loading'));
    audio.addEventListener('error', () => { box.classList.remove('is-loading'); setPlaying(false); });

    players.push(audio);
    if (audio.readyState >= 1) audio.dispatchEvent(new Event('loadedmetadata'));
}

document.querySelectorAll('.player').forEach(build);

// Space bar plays/pauses the episode in view (unless typing somewhere).
document.addEventListener('keydown', e => {
    if (e.code !== 'Space' || /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
    const active = players.find(p => !p.paused) || players[0];
    if (!active) return;
    e.preventDefault();
    if (active.paused) active.play(); else active.pause();
});

// Share buttons: the phone share sheet where there is one, else copy the link.
document.addEventListener('click', async e => {
    const btn = e.target.closest('[data-share]');
    if (!btn) return;
    const url = btn.dataset.share;
    const title = btn.dataset.shareTitle || 'The PFL Cast';
    if (navigator.share) {
        try { await navigator.share({ title: `The PFL Cast: ${title}`, url }); return; } catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); } catch (_) {
        const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    const label = btn.textContent;
    btn.textContent = '✓ Link copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = label; btn.classList.remove('copied'); }, 2000);
});
