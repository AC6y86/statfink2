'use strict';

/**
 * The PFL Cast podcast outlines (/admin/podcast).
 *
 *   podcast/hosts.json                          - the current host lineup (edited on /admin/podcast)
 *   podcast/{season}/data/week{NN}-episode.json - one week's generated outlines + Claude's favorite
 *
 * An episode is an OUTLINE with talking points for Jellypod, which writes the
 * dialogue. scripts/podcast-outlines.js generates five outlines from the
 * week's validated recap digest and picks a favorite.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '../..');
const DEFAULT_ROOT = path.join(REPO, 'podcast');

const MAX_HOSTS = 4;
const ROLES = ['host', 'guest'];

const DEFAULT_HOSTS = [
    { name: 'Peyton Manning', role: 'host', traits: 'Film-study obsessive with a binder; yells "Omaha!" to change subjects; dry, self-deprecating; slips into fake commercial reads; teases his little brother Eli (league owner Eli is a gift).' },
    { name: 'John Madden', role: 'host', traits: '"BOOM!"; huge enthusiasm; states the obvious as deep wisdom; narrates telestrator doodles; loves tough guys; tangents about the Madden Cruiser bus and turkey legs.' }
];

function weekPad(week) { return String(week).padStart(2, '0'); }

function hostsFile(root = DEFAULT_ROOT) { return path.join(root, 'hosts.json'); }
function episodeFile(season, week, root = DEFAULT_ROOT) { return path.join(root, String(season), 'data', `week${weekPad(week)}-episode.json`); }

function writeJsonAtomic(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return file;
}

/** Validate and tidy a host list; throws a readable Error on bad input. */
function normaliseHosts(input) {
    if (!Array.isArray(input)) throw new Error('hosts must be a list');
    const hosts = input
        .map(h => ({
            name: String((h && h.name) || '').replace(/\s+/g, ' ').trim(),
            role: ROLES.includes(h && h.role) ? h.role : 'host',
            traits: String((h && h.traits) || '').replace(/\s+/g, ' ').trim()
        }))
        .filter(h => h.name);
    if (!hosts.length) throw new Error('Add at least one host');
    if (hosts.length > MAX_HOSTS) throw new Error(`At most ${MAX_HOSTS} people on the show`);
    if (!hosts.some(h => h.role === 'host')) throw new Error('At least one person must be a host, not a guest');
    for (const h of hosts) {
        if (h.name.length > 80) throw new Error(`Name too long: ${h.name.slice(0, 40)}…`);
        if (h.traits.length > 600) throw new Error(`Traits for ${h.name} are too long (600 characters max)`);
    }
    const names = hosts.map(h => h.name.toLowerCase());
    if (new Set(names).size !== names.length) throw new Error('The same person is listed twice');
    return hosts;
}

function readHosts(root = DEFAULT_ROOT) {
    try {
        const doc = JSON.parse(fs.readFileSync(hostsFile(root), 'utf8'));
        return { hosts: normaliseHosts(doc.hosts), updatedAt: doc.updatedAt || null };
    } catch (_) {
        return { hosts: DEFAULT_HOSTS.map(h => ({ ...h })), updatedAt: null };
    }
}

function writeHosts(hosts, root = DEFAULT_ROOT) {
    const doc = { hosts: normaliseHosts(hosts), updatedAt: new Date().toISOString() };
    writeJsonAtomic(hostsFile(root), doc);
    return doc;
}

function readEpisode(season, week, root = DEFAULT_ROOT) {
    try { return JSON.parse(fs.readFileSync(episodeFile(season, week, root), 'utf8')); } catch (_) { return null; }
}

function writeEpisode(doc, root = DEFAULT_ROOT) {
    return writeJsonAtomic(episodeFile(doc.season, doc.week, root), doc);
}

/** [{ season, week }] with an episode file, newest first. */
function listEpisodeWeeks(root = DEFAULT_ROOT) {
    const out = [];
    let seasons = [];
    try { seasons = fs.readdirSync(root).filter(d => /^\d{4}$/.test(d)); } catch (_) { return out; }
    for (const s of seasons) {
        let files = [];
        try { files = fs.readdirSync(path.join(root, s, 'data')); } catch (_) { continue; }
        for (const f of files) {
            const m = /^week(\d{2})-episode\.json$/.exec(f);
            if (m) out.push({ season: Number(s), week: Number(m[1]) });
        }
    }
    return out.sort((a, b) => b.season - a.season || b.week - a.week);
}

/**
 * Numbers in an outline that do not appear anywhere in the digest. Light-touch
 * facts: this is a hint for the reader, never a gate (a host's own career
 * stat or a running time legitimately is not in the digest).
 */
function numbersNotInDigest(markdown, digest) {
    // Segment timings (~2:00) are not stats: drop them before looking for numbers.
    const found = String(markdown || '').replace(/\d+:\d{2}/g, ' ').match(/\d+(?:\.\d+)?(?:-\d+){0,2}/g) || [];
    const ignore = new Set(['0', '1', '2', '3', '4', '5', '10', '11', '12']);
    const seen = new Set();
    const missing = [];
    for (const n of found) {
        if (seen.has(n) || ignore.has(n)) continue;
        seen.add(n);
        if (!String(digest || '').includes(n)) missing.push(n);
    }
    return missing;
}


// ---------- Published episodes (peninsulafootball.com/podcast) ----------
//   podcast/audio/{season}-week{NN}-{id}.{ext}  - the audio (gitignored; the repo is public)
//   podcast/audio/.uploads/{uploadId}.part       - chunked uploads in progress
//   podcast/published.json                       - { episodes: [{ season, week, title, description, file, mime, bytes, publishedAt }] }

const crypto = require('crypto');

const AUDIO_TYPES = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg' };
const MAX_AUDIO_BYTES = 400 * 1024 * 1024;
const UPLOAD_ID_RE = /^[0-9a-f]{24}$/;
const AUDIO_FILE_RE = /^\d{4}-week\d{2}-[0-9a-f]{8}\.(mp3|m4a|aac|wav|ogg|opus)$/;

function audioDir(root = DEFAULT_ROOT) { return path.join(root, 'audio'); }
function uploadDir(root = DEFAULT_ROOT) { return path.join(audioDir(root), '.uploads'); }
function publishedFile(root = DEFAULT_ROOT) { return path.join(root, 'published.json'); }

function audioExt(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
    const ext = m ? m[1].toLowerCase() : '';
    return AUDIO_TYPES[ext] ? ext : null;
}

/** Start a chunked upload; also clears uploads abandoned for more than a day. */
function startUpload(root = DEFAULT_ROOT) {
    const dir = uploadDir(root);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of fs.readdirSync(dir)) {
        try { if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(path.join(dir, f)); } catch (_) { /* gone */ }
    }
    const id = crypto.randomBytes(12).toString('hex');
    fs.writeFileSync(path.join(dir, `${id}.part`), Buffer.alloc(0));
    return id;
}

function uploadPath(id, root = DEFAULT_ROOT) {
    if (!UPLOAD_ID_RE.test(String(id))) throw new Error('Invalid upload id');
    return path.join(uploadDir(root), `${id}.part`);
}

/**
 * Append one chunk at `offset`. A chunk the server already has (a retried
 * request) is acknowledged without writing it twice; a gap is refused.
 */
function appendChunk(id, offset, buf, root = DEFAULT_ROOT) {
    const file = uploadPath(id, root);
    let size;
    try { size = fs.statSync(file).size; } catch (_) { throw new Error('Upload not found - start again'); }
    const off = Number(offset);
    if (!Number.isInteger(off) || off < 0) throw new Error('Invalid offset');
    if (off + buf.length <= size) return size; // already have it
    if (off !== size) throw new Error(`Expected offset ${size}, got ${off}`);
    if (size + buf.length > MAX_AUDIO_BYTES) throw new Error(`Audio is larger than ${MAX_AUDIO_BYTES / 1024 / 1024} MB`);
    fs.appendFileSync(file, buf);
    return size + buf.length;
}

function readPublished(root = DEFAULT_ROOT) {
    try {
        const doc = JSON.parse(fs.readFileSync(publishedFile(root), 'utf8'));
        return Array.isArray(doc.episodes) ? doc.episodes : [];
    } catch (_) { return []; }
}

function sortEpisodes(list) { return [...list].sort((a, b) => b.season - a.season || b.week - a.week); }

/** Move a finished upload into place and list it for the week (replacing an earlier one). */
function publishEpisode({ season, week, title, description, uploadId, filename, coverUploadId = null, coverFilename = null, removeCover = false }, root = DEFAULT_ROOT) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const d = String(description || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length < 3 || t.length > 160) throw new Error('Give the episode a title (3-160 characters)');
    if (d.length < 10 || d.length > 4000) throw new Error('Write a description (10-4000 characters)');
    const ext = audioExt(filename);
    if (!ext) throw new Error(`Audio must be one of: ${Object.keys(AUDIO_TYPES).join(', ')}`);
    const part = uploadPath(uploadId, root);
    let bytes;
    try { bytes = fs.statSync(part).size; } catch (_) { throw new Error('Upload not found - start again'); }
    if (bytes < 1024) throw new Error('The audio file is empty');
    const cover = coverUploadId ? finishCoverUpload(coverUploadId, coverFilename, `${season}-week${weekPad(week)}`, root) : null;
    const file = `${season}-week${weekPad(week)}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    fs.mkdirSync(audioDir(root), { recursive: true });
    fs.renameSync(part, path.join(audioDir(root), file));
    const episodes = readPublished(root);
    const old = episodes.find(e => e.season === season && e.week === week);
    const keptCover = cover || (!removeCover && old && old.cover) || null;
    const entry = { season, week, title: t, description: d, file, mime: AUDIO_TYPES[ext], bytes, cover: keptCover, publishedAt: new Date().toISOString() };
    const next = sortEpisodes([...episodes.filter(e => e !== old), entry]);
    writeJsonAtomic(publishedFile(root), { episodes: next });
    if (old && old.file !== file) { try { fs.unlinkSync(path.join(audioDir(root), old.file)); } catch (_) { /* already gone */ } }
    if (old && old.cover && old.cover !== keptCover) removeCoverFile(old.cover, root);
    return entry;
}

/** Edit the title/description of a published episode without re-uploading. */
function updateEpisodeText({ season, week, title, description, coverUploadId = null, coverFilename = null, removeCover = false }, root = DEFAULT_ROOT) {
    const episodes = readPublished(root);
    const ep = episodes.find(e => e.season === season && e.week === week);
    if (!ep) throw new Error('No published episode for that week');
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    const d = String(description || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length < 3 || t.length > 160) throw new Error('Give the episode a title (3-160 characters)');
    if (d.length < 10 || d.length > 4000) throw new Error('Write a description (10-4000 characters)');
    const oldCover = ep.cover || null;
    if (coverUploadId) ep.cover = finishCoverUpload(coverUploadId, coverFilename, `${season}-week${weekPad(week)}`, root);
    else if (removeCover) ep.cover = null;
    ep.title = t;
    ep.description = d;
    ep.editedAt = new Date().toISOString();
    writeJsonAtomic(publishedFile(root), { episodes: sortEpisodes(episodes) });
    if (oldCover && oldCover !== ep.cover) removeCoverFile(oldCover, root);
    return ep;
}

function unpublishEpisode(season, week, root = DEFAULT_ROOT) {
    const episodes = readPublished(root);
    const ep = episodes.find(e => e.season === season && e.week === week);
    if (!ep) return null;
    writeJsonAtomic(publishedFile(root), { episodes: episodes.filter(e => e !== ep) });
    try { fs.unlinkSync(path.join(audioDir(root), ep.file)); } catch (_) { /* already gone */ }
    removeCoverFile(ep.cover, root);
    return ep;
}


// ---------- Cover art ----------
//   podcast/audio/covers/{show|2026-week10}-{id}.{ext}
//   podcast/show.json  - { cover, updatedAt }  (the show's own cover)

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const COVER_FILE_RE = /^(show|\d{4}-week\d{2})-[0-9a-f]{8}\.(jpg|jpeg|png|webp)$/;

function coverDir(root = DEFAULT_ROOT) { return path.join(audioDir(root), 'covers'); }
function showFile(root = DEFAULT_ROOT) { return path.join(root, 'show.json'); }

function imageExt(filename) {
    const m = /\.([a-z0-9]+)$/i.exec(String(filename || ''));
    const ext = m ? m[1].toLowerCase() : '';
    return IMAGE_TYPES[ext] ? ext : null;
}

/** True when the bytes really are a JPEG, PNG or WebP (not just named like one). */
function looksLikeImage(file) {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    try { fs.readSync(fd, b, 0, 12, 0); } finally { fs.closeSync(fd); }
    return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
        || b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        || (b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP');
}

/** Move a finished image upload into covers/ as `{prefix}-{id}.{ext}`; returns the file name. */
function finishCoverUpload(uploadId, filename, prefix, root = DEFAULT_ROOT) {
    const ext = imageExt(filename);
    if (!ext) throw new Error('Cover must be a JPG, PNG or WebP image');
    const part = uploadPath(uploadId, root);
    let bytes;
    try { bytes = fs.statSync(part).size; } catch (_) { throw new Error('Cover upload not found - start again'); }
    if (bytes > MAX_IMAGE_BYTES) throw new Error(`Cover is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    if (bytes < 100 || !looksLikeImage(part)) throw new Error('That file is not a JPG, PNG or WebP image');
    const file = `${prefix}-${crypto.randomBytes(4).toString('hex')}.${ext === 'jpeg' ? 'jpg' : ext}`;
    fs.mkdirSync(coverDir(root), { recursive: true });
    fs.renameSync(part, path.join(coverDir(root), file));
    return file;
}

function removeCoverFile(file, root = DEFAULT_ROOT) {
    if (!file || !COVER_FILE_RE.test(file)) return;
    try { fs.unlinkSync(path.join(coverDir(root), file)); } catch (_) { /* already gone */ }
}

function readShow(root = DEFAULT_ROOT) {
    try { return JSON.parse(fs.readFileSync(showFile(root), 'utf8')); } catch (_) { return { cover: null }; }
}

function setShowCover(uploadId, filename, root = DEFAULT_ROOT) {
    const old = readShow(root);
    const cover = finishCoverUpload(uploadId, filename, 'show', root);
    writeJsonAtomic(showFile(root), { ...old, cover, updatedAt: new Date().toISOString() });
    if (old.cover && old.cover !== cover) removeCoverFile(old.cover, root);
    return cover;
}

function removeShowCover(root = DEFAULT_ROOT) {
    const old = readShow(root);
    if (!old.cover) return null;
    writeJsonAtomic(showFile(root), { ...old, cover: null, updatedAt: new Date().toISOString() });
    removeCoverFile(old.cover, root);
    return old.cover;
}

/** Absolute path of a cover in use (the show's or an episode's), or null. */
function coverPath(file, root = DEFAULT_ROOT) {
    if (!COVER_FILE_RE.test(String(file))) return null;
    const inUse = readShow(root).cover === file || readPublished(root).some(e => e.cover === file);
    return inUse ? path.join(coverDir(root), file) : null;
}

/** Absolute path of a published audio file, or null for anything that is not one. */
function publishedAudioPath(file, root = DEFAULT_ROOT) {
    if (!AUDIO_FILE_RE.test(String(file))) return null;
    if (!readPublished(root).some(e => e.file === file)) return null;
    return path.join(audioDir(root), file);
}

// ---------- Emails (podcast/emails/*.md: "Subject: ..." line, blank line, markdown body) ----------

function listEmails(root = DEFAULT_ROOT) {
    const dir = path.join(root, 'emails');
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^[a-z0-9][a-z0-9-]*\.md$/.test(f)); } catch (_) { return []; }
    return files.map(f => {
        const text = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = /^Subject:\s*(.+)\r?\n\r?\n?/.exec(text);
        return {
            slug: f.replace(/\.md$/, ''),
            subject: m ? m[1].trim() : f.replace(/\.md$/, ''),
            markdown: m ? text.slice(m[0].length).trim() : text.trim(),
            updatedAt: fs.statSync(path.join(dir, f)).mtime.toISOString()
        };
    }).sort((a, b) => b.slug.localeCompare(a.slug));
}

module.exports = {
    DEFAULT_ROOT, DEFAULT_HOSTS, MAX_HOSTS, weekPad,
    hostsFile, episodeFile, normaliseHosts, readHosts, writeHosts,
    readEpisode, writeEpisode, listEpisodeWeeks, numbersNotInDigest,
    AUDIO_TYPES, MAX_AUDIO_BYTES, audioDir, audioExt, startUpload, appendChunk, readPublished,
    publishEpisode, updateEpisodeText, unpublishEpisode, publishedAudioPath,
    listEmails, IMAGE_TYPES, MAX_IMAGE_BYTES, imageExt, readShow, setShowCover, removeShowCover, coverPath
};
