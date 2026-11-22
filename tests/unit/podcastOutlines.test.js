/**
 * The PFL Cast outlines (/admin/podcast): server/utils/podcastStore.js, the
 * prompt builders in scripts/podcast-outlines.js, and the admin routes via
 * supertest with app.locals.podcastEnv pointing at temp dirs. Never runs
 * claude, never touches podcast/, recaps/ or logs/.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../server/utils/podcastStore');
const outlines = require('../../scripts/podcast-outlines');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-test-')); }

describe('podcastStore', () => {
    let dir;
    beforeEach(() => { dir = tmp(); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('readHosts falls back to the default lineup until hosts are saved', () => {
        expect(store.readHosts(dir)).toEqual({ hosts: store.DEFAULT_HOSTS, updatedAt: null });
        const saved = store.writeHosts([{ name: '  Peyton   Manning ', role: 'host', traits: 'Omaha' }, { name: 'Tony Romo', role: 'guest' }], dir);
        expect(saved.hosts).toEqual([{ name: 'Peyton Manning', role: 'host', traits: 'Omaha' }, { name: 'Tony Romo', role: 'guest', traits: '' }]);
        expect(store.readHosts(dir).hosts).toEqual(saved.hosts);
    });

    test('normaliseHosts rejects empty, oversized, guest-only and duplicate lineups', () => {
        expect(() => store.normaliseHosts(null)).toThrow(/list/);
        expect(() => store.normaliseHosts([{ name: ' ' }])).toThrow(/at least one/);
        expect(() => store.normaliseHosts([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }])).toThrow(/At most/);
        expect(() => store.normaliseHosts([{ name: 'A', role: 'guest' }])).toThrow(/host/);
        expect(() => store.normaliseHosts([{ name: 'A' }, { name: 'a' }])).toThrow(/twice/);
        expect(store.normaliseHosts([{ name: 'A', role: 'producer' }])[0].role).toBe('host');
    });

    test('episodes round-trip and list newest first', () => {
        store.writeEpisode({ season: 2026, week: 9, outlines: [] }, dir);
        store.writeEpisode({ season: 2026, week: 10, outlines: [] }, dir);
        expect(store.readEpisode(2026, 10, dir)).toEqual({ season: 2026, week: 10, outlines: [] });
        expect(store.listEpisodeWeeks(dir)).toEqual([{ season: 2026, week: 10 }, { season: 2026, week: 9 }]);
        expect(store.readEpisode(2026, 11, dir)).toBeNull();
    });

    test('numbersNotInDigest flags only numbers absent from the digest', () => {
        const digest = 'Sean 157.5, record 4-6, McCaffrey 41';
        expect(store.numbersNotInDigest('Sean 157.5 and 4-6; McCaffrey 41; Peyton threw for 400 (~2:00)', digest)).toEqual(['400']);
    });
});

describe('podcast prompt', () => {
    test('carries the hosts, the never-say league facts, and the podcast Joe rule instead of the recap one', () => {
        const house = outlines.podcastHouseRules();
        expect(house.rules).toContain(outlines.PODCAST_JOE_RULE);
        expect(house.rules.some(r => /never make him the main character/i.test(r))).toBe(false);
        expect(house.rules.some(r => /appendix/i.test(r))).toBe(false);
        const brief = outlines.sharedBrief({ season: 2026, week: 10, hosts: store.DEFAULT_HOSTS, digest: 'DIGEST', storylines: null, prev: null, house });
        expect(brief).toContain('The PFL Cast');
        expect(brief).toContain('Peyton Manning (host)');
        expect(brief).toMatch(/nobody "started", "benched" or "sat"/);
        expect(brief).toContain('no Week 11 results');
        expect(brief).not.toContain('LAST WEEK');
    });
});

describe('/api/admin/podcast routes', () => {
    const express = require('express');
    const request = require('supertest');
    let dir; let app; let spawned; let env;
    beforeEach(() => {
        dir = tmp();
        spawned = [];
        env = {
            root: path.join(dir, 'podcast'), recapsRoot: path.join(dir, 'recaps'), statusDir: path.join(dir, 'status'),
            validationFile: path.join(dir, 'validation.json'),
            spawnScript: (script, args) => { spawned.push({ script, args }); return { pid: 4242, log: 'x.log' }; }
        };
        app = express();
        app.use(express.json());
        app.locals.podcastEnv = env;
        app.use('/api/admin', require('../../server/routes/admin'));
        app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

    test('saves hosts and lists weeks with a digest or a passing validation', async () => {
        fs.mkdirSync(path.join(env.recapsRoot, '2026', 'data'), { recursive: true });
        fs.writeFileSync(path.join(env.recapsRoot, '2026', 'data', 'week10-digest.md'), '# d');
        fs.writeFileSync(env.validationFile, JSON.stringify({ season: 2026, week: 11, overallStatus: 'PASS' }));
        expect((await request(app).put('/api/admin/podcast/hosts').send({ hosts: [] })).status).toBe(400);
        expect((await request(app).put('/api/admin/podcast/hosts').send({ hosts: [{ name: 'John Madden' }] })).status).toBe(200);
        const res = await request(app).get('/api/admin/podcast');
        expect(res.body.data.hosts).toEqual([{ name: 'John Madden', role: 'host', traits: '' }]);
        expect(res.body.data.weeks.map(w => w.week)).toEqual([11, 10]);
    });

    test('generate is gated on validation, spawns once, and refuses a second run', async () => {
        expect((await request(app).post('/api/admin/podcast/2026/11/generate')).status).toBe(409);
        fs.writeFileSync(env.validationFile, JSON.stringify({ season: 2026, week: 11, overallStatus: 'WARN' }));
        const ok = await request(app).post('/api/admin/podcast/2026/11/generate');
        expect(ok.status).toBe(200);
        expect(spawned).toEqual([{ script: 'podcast-outlines.js', args: ['--season', '2026', '--week', '11'] }]);
        const again = await request(app).post('/api/admin/podcast/2026/11/generate');
        expect(again.status).toBe(409);
        expect(again.body.message).toMatch(/Already writing/);
    });

    test('a running episode whose process is gone reads as failed', async () => {
        store.writeEpisode({ season: 2026, week: 10, status: 'running', outlines: [] }, env.root);
        fs.mkdirSync(env.statusDir, { recursive: true });
        fs.writeFileSync(path.join(env.statusDir, 'podcast-outlines.json'), JSON.stringify({ status: 'running', ts: new Date().toISOString(), season: 2026, week: 10, details: { pid: 999999 } }));
        fs.writeFileSync(path.join(env.root, '2026', 'data', 'week10-players.md'), '## Player notes');
        const res = await request(app).get('/api/admin/podcast/2026/10');
        expect(res.body.data.playerNotes).toBe('## Player notes');
        expect(res.body.data.episode.status).toBe('failed');
        expect(res.body.data.running).toBe(false);
    });
});

describe('/api/admin/podcast choose', () => {
    const express = require('express');
    const request = require('supertest');
    test('records the outline Joe is using and rejects unknown ids', async () => {
        const dir = tmp();
        const root = path.join(dir, 'podcast');
        const app = express();
        app.use(express.json());
        app.locals.podcastEnv = { root, recapsRoot: path.join(dir, 'recaps'), statusDir: path.join(dir, 'status'), validationFile: path.join(dir, 'v.json'), spawnScript: () => ({}) };
        app.use('/api/admin', require('../../server/routes/admin'));
        app.use((err, req, res, next) => res.status(err.statusCode || 500).json({ success: false, message: err.message })); // eslint-disable-line no-unused-vars
        jest.spyOn(console, 'log').mockImplementation(() => {});
        expect((await request(app).post('/api/admin/podcast/2026/10/choose').send({ id: 'o1' })).status).toBe(404);
        store.writeEpisode({ season: 2026, week: 10, status: 'ok', outlines: [{ id: 'o1' }, { id: 'o2' }], favorite: 'o2' }, root);
        expect((await request(app).post('/api/admin/podcast/2026/10/choose').send({ id: 'o9' })).status).toBe(400);
        expect((await request(app).post('/api/admin/podcast/2026/10/choose').send({ id: 'o1' })).status).toBe(200);
        expect(store.readEpisode(2026, 10, root).chosen).toBe('o1');
        fs.rmSync(dir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });
});

describe('published episodes (podcastStore)', () => {
    let dir;
    beforeEach(() => { dir = tmp(); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('chunked upload: retries are idempotent, gaps are refused, publish replaces the week', () => {
        const id = store.startUpload(dir);
        const a = Buffer.alloc(1500, 1);
        const b = Buffer.alloc(700, 2);
        expect(store.appendChunk(id, 0, a, dir)).toBe(1500);
        expect(store.appendChunk(id, 0, a, dir)).toBe(1500); // retried chunk
        expect(() => store.appendChunk(id, 5000, b, dir)).toThrow(/Expected offset 1500/);
        expect(store.appendChunk(id, 1500, b, dir)).toBe(2200);
        expect(() => store.appendChunk('../etc', 0, b, dir)).toThrow(/Invalid upload id/);
        expect(() => store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1', description: 'short', uploadId: id, filename: 'a.mp3' }, dir)).toThrow(/description/);
        expect(() => store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1', description: 'A long enough description', uploadId: id, filename: 'a.exe' }, dir)).toThrow(/Audio must be/);
        const first = store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1', description: 'A long enough description', uploadId: id, filename: 'Episode.MP3' }, dir);
        expect(first).toMatchObject({ season: 2026, week: 10, mime: 'audio/mpeg', bytes: 2200 });
        expect(store.publishedAudioPath(first.file, dir)).toBe(path.join(store.audioDir(dir), first.file));
        expect(store.publishedAudioPath('../../.env', dir)).toBeNull();

        const id2 = store.startUpload(dir);
        store.appendChunk(id2, 0, Buffer.alloc(4096, 3), dir);
        const second = store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1 v2', description: 'A long enough description', uploadId: id2, filename: 'b.m4a' }, dir);
        expect(store.readPublished(dir)).toEqual([second]);
        expect(fs.existsSync(path.join(store.audioDir(dir), first.file))).toBe(false);
        expect(store.updateEpisodeText({ season: 2026, week: 10, title: 'Renamed', description: 'Another long description' }, dir).title).toBe('Renamed');
        expect(store.unpublishEpisode(2026, 10, dir).file).toBe(second.file);
        expect(store.readPublished(dir)).toEqual([]);
    });
});

describe('/podcast_upload and /podcast', () => {
    const express = require('express');
    const session = require('express-session');
    const request = require('supertest');
    const bcrypt = require('bcrypt');
    let dir; let app; let hash;
    beforeAll(async () => { hash = await bcrypt.hash('pfl cast', 4); });
    beforeEach(() => {
        dir = tmp();
        app = express();
        app.use(session({ secret: 't', resave: false, saveUninitialized: false }));
        app.locals.podcastEnv = { root: dir, uploadPasswordHash: hash, validationFile: path.join(dir, 'v.json') };
        fs.writeFileSync(path.join(dir, 'v.json'), JSON.stringify({ season: 2026, week: 10, overallStatus: 'PASS' }));
        app.use('/podcast_upload', require('../../server/routes/podcastUpload'));
        app.use('/podcast', require('../../server/routes/podcastPublic'));
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); jest.restoreAllMocks(); });

    test('needs the uploader password and the upload header; then uploads, publishes and serves the episode', async () => {
        const agent = request.agent(app);
        expect((await agent.get('/podcast_upload')).text).toContain('type="password"');
        expect((await agent.get('/podcast_upload/api/state').set('X-PFL-Upload', '1')).status).toBe(401);
        expect((await agent.post('/podcast_upload/login').type('form').send({ password: 'wrong' })).status).toBe(401);
        expect((await agent.post('/podcast_upload/login').type('form').send({ password: 'pfl cast' })).status).toBe(303);
        expect((await agent.get('/podcast_upload')).text).toContain('upload-form');
        expect((await agent.get('/podcast_upload/api/state')).status).toBe(403); // no header
        const state = await agent.get('/podcast_upload/api/state').set('X-PFL-Upload', '1');
        expect(state.body.data).toMatchObject({ season: 2026, defaultWeek: 10, published: [] });

        const { uploadId } = (await agent.post('/podcast_upload/api/uploads').set('X-PFL-Upload', '1')).body.data;
        const audio = Buffer.alloc(3000, 7);
        const put = await agent.put(`/podcast_upload/api/uploads/${uploadId}?offset=0`).set('X-PFL-Upload', '1').set('Content-Type', 'application/octet-stream').send(audio);
        expect(put.body.data.received).toBe(3000);
        const pub = await agent.post('/podcast_upload/api/episodes/2026/10').set('X-PFL-Upload', '1')
            .send({ uploadId, filename: 'ep1.mp3', title: 'Episode 1: <Points>', description: 'Madden & Peyton argue.\n\nPoints or wins?' });
        expect(pub.status).toBe(200);
        const file = pub.body.data.episode.file;

        const pageRes = await request(app).get('/podcast');
        expect(pageRes.text).toContain('Episode 1: &lt;Points&gt;');
        expect(pageRes.text).toContain('Madden &amp; Peyton argue.</p>');
        expect(pageRes.text).toContain(`data-file="${file}"`);
        expect(pageRes.text).toContain('/js/podcast-player.js');
        const ranged = await request(app).get(`/podcast/audio/${file}`).set('Range', 'bytes=0-99');
        expect(ranged.status).toBe(206);
        expect(ranged.headers['content-type']).toBe('audio/mpeg');
        expect((await request(app).get('/podcast/audio/..%2F..%2Fv.json')).status).toBe(404);

        const epPage = await request(app).get('/podcast/2026/week10');
        expect(epPage.status).toBe(200);
        expect(epPage.text).toContain('<h1 class="ep-title">Episode 1: &lt;Points&gt;</h1>');
        expect(epPage.text).toContain('<meta property="og:url" content="https://peninsulafootball.com/podcast/2026/week10">');
        expect(epPage.text).toContain('og:audio');
        expect(epPage.text).toContain('data-share="https://peninsulafootball.com/podcast/2026/week10"');
        expect(pageRes.text).toContain('href="/podcast/2026/week10"');

        expect((await agent.delete('/podcast_upload/api/episodes/2026/10').set('X-PFL-Upload', '1')).status).toBe(200);
        expect((await request(app).get('/podcast')).text).toContain('Episode 1 is in the studio');
        expect((await request(app).get('/podcast/2026/week10')).status).toBe(404);
        expect((await agent.post('/podcast_upload/logout')).status).toBe(303);
        expect((await agent.get('/podcast_upload/api/state').set('X-PFL-Upload', '1')).status).toBe(401);
    });

    test('the uploader is closed when no password is configured', async () => {
        app.locals.podcastEnv.uploadPasswordHash = '';
        expect((await request(app).get('/podcast_upload')).status).toBe(503);
        expect((await request(app).post('/podcast_upload/login').type('form').send({ password: '' })).status).toBe(401);
    });
});

describe('cover art', () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
    let dir;
    beforeEach(() => { dir = tmp(); });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
    const upload = buf => { const id = store.startUpload(dir); store.appendChunk(id, 0, buf, dir); return id; };

    test('show cover: only real images, replacing removes the old file', () => {
        expect(() => store.setShowCover(upload(Buffer.alloc(300, 0)), 'x.png', dir)).toThrow(/not a JPG, PNG or WebP/);
        expect(() => store.setShowCover(upload(PNG), 'x.gif', dir)).toThrow(/JPG, PNG or WebP/);
        const first = store.setShowCover(upload(PNG), 'Cover.PNG', dir);
        expect(first).toMatch(/^show-[0-9a-f]{8}\.png$/);
        expect(store.coverPath(first, dir)).toBeTruthy();
        const second = store.setShowCover(upload(PNG), 'c.png', dir);
        expect(store.coverPath(first, dir)).toBeNull();
        expect(fs.existsSync(path.join(store.audioDir(dir), 'covers', first))).toBe(false);
        expect(store.removeShowCover(dir)).toBe(second);
        expect(store.readShow(dir).cover).toBeNull();
    });

    test('episode cover: set on publish, kept on audio replace, removable, deleted on unpublish', () => {
        const audio = () => upload(Buffer.alloc(2048, 5));
        const ep = store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description', uploadId: audio(), filename: 'a.mp3', coverUploadId: upload(PNG), coverFilename: 'e.png' }, dir);
        expect(ep.cover).toMatch(/^2026-week10-[0-9a-f]{8}\.png$/);
        const again = store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description', uploadId: audio(), filename: 'b.mp3' }, dir);
        expect(again.cover).toBe(ep.cover);
        const cast = store.publishEpisode({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description', uploadId: audio(), filename: 'c.mp3', hosts: 'Peyton Manning, John Madden', guests: '' }, dir);
        expect(cast.cast).toEqual({ hosts: ['Peyton Manning', 'John Madden'], guests: [] });
        expect(store.updateEpisodeText({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description' }, dir).cast).toEqual(cast.cast);
        expect(store.updateEpisodeText({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description', hosts: 'Al Michaels & Cris Collinsworth', guests: 'Tony Romo' }, dir).cast).toEqual({ hosts: ['Al Michaels', 'Cris Collinsworth'], guests: ['Tony Romo'] });
        const edited = store.updateEpisodeText({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description', removeCover: true }, dir);
        expect(edited.cover).toBeNull();
        expect(store.coverPath(ep.cover, dir)).toBeNull();
        const withCover = store.updateEpisodeText({ season: 2026, week: 10, title: 'Ep 1', description: 'Long enough description', coverUploadId: upload(PNG), coverFilename: 'n.png' }, dir);
        store.unpublishEpisode(2026, 10, dir);
        expect(fs.existsSync(path.join(store.audioDir(dir), 'covers', withCover.cover))).toBe(false);
    });

    test('public pages use the episode cover, else the show cover, and set og:image', () => {
        const pub = require('../../server/routes/podcastPublic');
        const e = { season: 2026, week: 10, title: 'Ep', description: 'Desc here', file: '2026-week10-aaaaaaaa.mp3', bytes: 1, mime: 'audio/mpeg', cover: null };
        const plain = pub.renderPage([e], null);
        expect(plain).toContain('<svg viewBox="0 0 120 120"');
        expect(plain).not.toContain('og:image');
        const show = pub.renderPage([e], 'show-11111111.png', { '2026-10': { hosts: ['Peyton Manning', 'John Madden'], guests: ['Tony Romo'] } });
        expect(show).toContain('<b>Peyton Manning &amp; John Madden</b> · <span>Guest: Tony Romo</span>');
        expect(show).toContain('class="hero-art" src="/podcast/cover/show-11111111.png"');
        expect(show).toContain('<span class="wk">WK 10</span>');
        expect(show).toContain('og:image" content="https://peninsulafootball.com/podcast/cover/show-11111111.png"');
        const own = pub.renderEpisodePage([{ ...e, cover: '2026-week10-22222222.jpg' }], { ...e, cover: '2026-week10-22222222.jpg' }, 'show-11111111.png', null);
        expect(own).toContain('og:image" content="https://peninsulafootball.com/podcast/cover/2026-week10-22222222.jpg"');
    });
});

describe('podcast emails', () => {
    test('listEmails reads the subject line and body, newest first', () => {
        const dir = tmp();
        fs.mkdirSync(path.join(dir, 'emails'));
        fs.writeFileSync(path.join(dir, 'emails', '2026-11-22-launch.md'), 'Subject: BOOM! On the air\n\nHey **everybody**.\n');
        fs.writeFileSync(path.join(dir, 'emails', '2026-12-01-ep2.md'), 'No subject line here\n');
        fs.writeFileSync(path.join(dir, 'emails', 'Bad Name.md'), 'Subject: ignored\n\nx');
        const list = store.listEmails(dir);
        expect(list.map(e => e.slug)).toEqual(['2026-12-01-ep2', '2026-11-22-launch']);
        expect(list[1]).toMatchObject({ subject: 'BOOM! On the air', markdown: 'Hey **everybody**.' });
        expect(list[0].subject).toBe('2026-12-01-ep2');
        fs.rmSync(dir, { recursive: true, force: true });
    });
});

describe('player color (research step)', () => {
    test('research prompt demands sources, this season, no invented facts and no fantasy points', () => {
        const p = outlines.researchPrompt({ season: 2026, week: 10, digest: 'DIGEST', storylines: null });
        expect(p).toMatch(/6-8 players/);
        expect(p).toMatch(/Every fact needs a source/);
        expect(p).toMatch(/Never fill a gap from memory/);
        expect(p).toMatch(/2026 season, Week 10/);
        expect(p).toMatch(/Do not restate or contradict PFL fantasy points/);
        expect(p).toContain('DIGEST');
    });

    test('brief carries the notes as the only player-fact source, and the old shape without them', () => {
        const base = { season: 2026, week: 10, hosts: store.DEFAULT_HOSTS, digest: 'D', storylines: null, prev: null, house: { rules: [], taste: '' } };
        const withNotes = outlines.sharedBrief({ ...base, playerNotes: '## Puka Nacua (WR, LAR)\n- **Who they are:** ... [https://x]' });
        expect(withNotes).toContain('PLAYER NOTES (researched on the web');
        expect(withNotes).toContain('## Puka Nacua');
        expect(withNotes).toMatch(/Get into the players themselves/);
        expect(withNotes).toMatch(/or the player notes \(real NFL game details\)/);
        const without = outlines.sharedBrief(base);
        expect(without).not.toContain('PLAYER NOTES (');
        expect(without).toMatch(/Every number must come from the digest below\. /);
    });

    test('outline format asks for Player color; judge disqualifies invented player facts', () => {
        expect(outlines.outlinePrompt('B', { title: 't', premise: 'p', runningBit: 'r' }, store.DEFAULT_HOSTS)).toContain('**Player color**');
        expect(outlines.judgePrompt('B', [{ id: 'o1', title: 't', markdown: 'm' }], 10)).toMatch(/an invented player fact .* can never be the favorite/);
    });

    test('researchPlayers reuses saved notes without calling claude', async () => {
        const file = outlines.playersFile(2099, 3);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '# Player notes\n## Someone\n- note [https://x]\n');
        try {
            const r = await outlines.researchPlayers({ season: 2099, week: 3, digest: 'D', storylines: null, model: 'none' });
            expect(r).toMatchObject({ reused: true, error: null, costUsd: 0 });
            expect(r.notes).toContain('## Someone');
        } finally {
            fs.rmSync(path.join(store.DEFAULT_ROOT, '2099'), { recursive: true, force: true });
        }
    });
});
