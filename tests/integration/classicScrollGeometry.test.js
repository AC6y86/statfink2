/**
 * Classic Statfink page (helm/statfink.html + helm/statfink-styles.css)
 * scroll-geometry regression.
 *
 * Bug: on mobile Chrome, touch scrolling bounced / snapped back to the top
 * (Safari was fine). Cause: every visible column (#leaguediv, #teams) was
 * position:absolute, so <body> had no normal-flow content and zero height.
 * Live pre-fix evidence at /statfink/2026/1, 390x844:
 *   body.clientHeight = 0, body.scrollHeight = 0,
 *   documentElement.scrollHeight ~= 1728.
 *
 * This test serves helm/ statically with stubbed JSON for the endpoints the
 * page fetches (no database, no pm2 server) and checks in headless Chrome:
 *   - <body> has real height that matches the document scroll height
 *   - the classic three-column layout (league | team0 | team1) is intact
 *   - mobile emulation keeps the legacy 980px overview (no viewport meta)
 *   - there is no horizontal overflow at desktop or mobile widths
 *   - scroll position is retained after programmatic and touch scrolling
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const puppeteer = require('puppeteer');

const HELM_DIR = path.join(__dirname, '../../helm');
const SEASON = 2026;
const WEEK = 1;
const PAGE_PATH = `/statfink/${SEASON}/${WEEK}`;

// ---------------------------------------------------------------------------
// Stub data: shapes mirror what the real API returns, sized like a real week
// (6 matchups, 19 players per team, 16 NFL games).
// ---------------------------------------------------------------------------
const OWNERS = ['Chris', 'Matt', 'Dan', 'Bruce', 'Joe', 'Pete', 'Mike', 'Eli', 'Bill', 'Ryan', 'Sean', 'Cal'];
const POSITIONS = ['QB', 'RB', 'RB', 'RB', 'RB', 'WR', 'WR', 'WR', 'WR', 'WR', 'TE', 'TE', 'K', 'DST', 'DST', 'RB', 'WR', 'QB', 'TE'];

function makeStarters(teamId) {
    const edgeStatuses = { 0: 'Final/OT', 1: 'OT', 2: 'Halftime', 3: null };
    return POSITIONS.map((position, i) => ({
        player_id: `t${teamId}p${i}`,
        name: position === 'DST' ? 'Kansas City Chiefs' : `Player ${teamId}-${i} Lastname`,
        position,
        team: 'KC',
        opp: '@BUF',
        game_status: Object.prototype.hasOwnProperty.call(edgeStatuses, i) ? edgeStatuses[i] : 'Final',
        is_scoring: i < 13,
        stats: {
            fantasy_points: 10 + i,
            completions: 20, passing_attempts: 30, passing_yards: 250, passing_tds: 2,
            rushing_yards: 45, rushing_tds: 1, receptions: 5, receiving_yards: 60, receiving_tds: 1,
            field_goals_made: 2, extra_points_made: 3,
            sacks: 3, def_interceptions: 1, points_allowed: 17, yards_allowed: 310
        }
    }));
}

function makeMatchups() {
    const matchups = [];
    for (let m = 0; m < 6; m++) {
        const t1 = m * 2 + 1;
        const t2 = m * 2 + 2;
        matchups.push({
            matchup_id: m + 1,
            team1_id: t1, team2_id: t2,
            team1_owner: OWNERS[t1 - 1], team2_owner: OWNERS[t2 - 1],
            team1_name: `${OWNERS[t1 - 1]}'s Team`, team2_name: `${OWNERS[t2 - 1]}'s Team`,
            team1_points: 100 + m, team2_points: 90 + m,
            is_playoff: false
        });
    }
    return matchups;
}

function makeGames() {
    const teams = ['KC', 'BUF', 'PHI', 'DAL', 'SF', 'SEA', 'GB', 'CHI', 'DET', 'MIN', 'NYG', 'WAS', 'MIA', 'NE', 'NYJ', 'BAL',
        'CIN', 'CLE', 'PIT', 'HOU', 'IND', 'JAX', 'TEN', 'DEN', 'LV', 'LAC', 'LAR', 'ARI', 'ATL', 'CAR', 'NO', 'TB'];
    const games = [];
    for (let g = 0; g < 16; g++) {
        games.push({
            game_id: `g${g}`, away_team: teams[g * 2], home_team: teams[g * 2 + 1],
            away_score: 20, home_score: 17, status: 'Final', game_time: '1:00p', game_time_epoch: 1757869200
        });
    }
    return games;
}

function buildStubApp() {
    const app = express();
    const matchups = makeMatchups();
    app.get('/api/league/settings', (req, res) =>
        res.json({ success: true, data: { current_week: WEEK, season_year: SEASON, theme: 'plain' } }));
    app.get('/api/league/sync-status', (req, res) =>
        res.json({ success: true, data: { last_sync_time: null } }));
    // /game/:id must be registered before /:week/:season or it would match as week="game".
    app.get('/api/matchups/game/:id', (req, res) => {
        const matchup = matchups.find(m => m.matchup_id === parseInt(req.params.id, 10));
        if (!matchup) return res.status(404).json({ success: false });
        res.json({
            success: true,
            data: { matchup, team1: { starters: makeStarters(matchup.team1_id) }, team2: { starters: makeStarters(matchup.team2_id) } }
        });
    });
    app.get('/api/matchups/:week/:season', (req, res) => res.json({ success: true, data: matchups }));
    app.get('/api/nfl-games/:week/:season', (req, res) => res.json({ success: true, data: makeGames() }));
    app.get('/statfink/:year/:week', (req, res) => res.sendFile(path.join(HELM_DIR, 'statfink.html')));
    app.use(express.static(HELM_DIR));
    return app;
}

// Geometry snapshot evaluated inside the page.
function readGeometry() {
    const rect = sel => {
        const r = document.querySelector(sel).getBoundingClientRect();
        return { left: r.left + window.scrollX, top: r.top + window.scrollY, right: r.right + window.scrollX, bottom: r.bottom + window.scrollY, width: r.width, height: r.height };
    };
    const pos = sel => getComputedStyle(document.querySelector(sel)).position;
    return {
        bodyClientHeight: document.body.clientHeight,
        bodyScrollHeight: document.body.scrollHeight,
        bodyOffsetHeight: document.body.offsetHeight,
        docClientHeight: document.documentElement.clientHeight,
        docScrollHeight: document.documentElement.scrollHeight,
        docScrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        league: rect('#leaguediv'), teams: rect('#teams'), team0: rect('#team0div'), team1: rect('#team1div'),
        leaguePosition: pos('#leaguediv'), teamsPosition: pos('#teams'),
        playerRows: document.querySelectorAll('#team0 .playername').length,
        matchupRows: document.querySelectorAll('#leaguetable tbody tr[data-matchup-id]').length
    };
}

// Poll until window.scrollY holds still for two consecutive reads (lets any fling finish).
async function settledScrollY(page, { interval = 100, maxWait = 3000 } = {}) {
    let previous = await page.evaluate(() => window.scrollY);
    for (let waited = 0; waited < maxWait; waited += interval) {
        await new Promise(resolve => setTimeout(resolve, interval));
        const current = await page.evaluate(() => window.scrollY);
        if (current === previous) return current;
        previous = current;
    }
    return previous;
}

const DESKTOP = { width: 1280, height: 700 };
// iPhone 14/15-class viewport; isMobile + no <meta viewport> = legacy 980px layout overview.
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true };

function expectNormalFlowGeometry(g) {
    const contentBottom = Math.max(g.league.bottom, g.teams.bottom);
    // The body must own the content: real height that wraps the tallest column.
    // (Pre-fix: body.clientHeight === body.scrollHeight === 0.)
    expect(g.bodyScrollHeight).toBeGreaterThan(0);
    expect(g.bodyClientHeight).toBeGreaterThan(0);
    expect(Math.abs(g.bodyOffsetHeight - contentBottom)).toBeLessThanOrEqual(1);
    // The document scrolls exactly as far as the body's own content (or the
    // viewport, whichever is taller) - no scroll range owned by nothing.
    expect(Math.abs(g.docScrollHeight - Math.max(g.bodyScrollHeight, g.docClientHeight))).toBeLessThanOrEqual(1);
    // Columns are in normal flow (no absolutely positioned page columns).
    expect(g.leaguePosition).not.toBe('absolute');
    expect(g.teamsPosition).not.toBe('absolute');
}

function expectClassicThreeColumns(g) {
    // League column at x=5, teams block at x=260, team1 to the right of team0, all top-aligned.
    expect(g.league.left).toBeCloseTo(5, 0);
    expect(g.teams.left).toBeCloseTo(260, 0);
    expect(g.team1.left).toBeGreaterThanOrEqual(g.team0.right);
    expect(g.league.top).toBeCloseTo(0, 0);
    expect(g.teams.top).toBeCloseTo(0, 0);
    expect(Math.abs(g.team0.top - g.team1.top)).toBeLessThanOrEqual(1);
    expect(g.league.width).toBeGreaterThanOrEqual(250);
    expect(g.playerRows).toBe(19);
    expect(g.matchupRows).toBe(12);
    // No horizontal overflow.
    expect(g.docScrollWidth).toBeLessThanOrEqual(g.innerWidth);
}

describe('Classic Statfink page scroll geometry (mobile Chrome bounce regression)', () => {
    let server;
    let baseUrl;
    let browser;
    let page;

    beforeAll(async () => {
        const chromePath = puppeteer.executablePath();
        if (!fs.existsSync(chromePath)) {
            throw new Error(`Puppeteer's Chrome is not installed at ${chromePath}; run: npx puppeteer browsers install chrome`);
        }
        await new Promise(resolve => {
            server = buildStubApp().listen(0, '127.0.0.1', resolve);
        });
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        page = await browser.newPage();
    }, 30000);

    afterAll(async () => {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (server) await new Promise(resolve => server.close(resolve));
    });

    async function load(viewport) {
        await page.setViewport(viewport);
        await page.goto(baseUrl + PAGE_PATH, { waitUntil: 'networkidle0' });
        await page.waitForSelector('#team0 .totalsrow');
        await page.waitForSelector('#leaguetable tbody tr[data-matchup-id]');
        return page.evaluate(readGeometry);
    }

    test('desktop: body has real normal-flow height and the three columns are intact', async () => {
        const g = await load(DESKTOP);
        expectClassicThreeColumns(g);
        expectNormalFlowGeometry(g);
    }, 30000);

    test('Final/OT is complete, only live players are bold, and grid status sorting shares the classifier', async () => {
        await load(DESKTOP);
        const result = await page.evaluate(() => {
            const rawStatuses = [
                'Final', 'Final/OT', ' final overtime ', 'Completed',
                'scheduled', 'Q4 01:02', 'OT', 'Halftime', '', null, undefined
            ];
            const classifications = rawStatuses.map(status => classifyGameStatus(status));
            const rosterRows = Array.from(document.querySelectorAll('#team0 .playername')).slice(0, 4).map(cell => ({
                bold: cell.classList.contains('playernameinprogress'),
                status: cell.parentElement.querySelector('.status').textContent.trim()
            }));

            displayNFLGames([
                { away_team: 'FINALOT', home_team: 'A', away_score: 1, home_score: 2, status: 'Final/OT' },
                { away_team: 'UNKNOWN', home_team: 'B', away_score: 0, home_score: 0, status: null },
                { away_team: 'LATER', home_team: 'C', away_score: 0, home_score: 0, status: 'Scheduled', game_time_epoch: 200 },
                { away_team: 'LIVE', home_team: 'D', away_score: 3, home_score: 4, status: 'OT' },
                { away_team: 'DONE', home_team: 'E', away_score: 5, home_score: 6, status: 'Completed' },
                { away_team: 'SOONER', home_team: 'F', away_score: 0, home_score: 0, status: ' scheduled ', game_time_epoch: 100 }
            ]);
            const gridOrder = Array.from(document.querySelectorAll('#nfltable tr[id$="r0"]')).flatMap(row =>
                Array.from(row.children).filter((cell, index) => index % 2 === 0).map(cell => cell.textContent)
            );
            return { classifications, rosterRows, gridOrder };
        });

        expect(result.classifications).toEqual([
            'final', 'final', 'final', 'final',
            'scheduled', 'live', 'live', 'live', 'unknown', 'unknown', 'unknown'
        ]);
        expect(result.rosterRows).toEqual([
            { bold: false, status: 'Final/OT' },
            { bold: true, status: 'OT' },
            { bold: true, status: 'Halftime' },
            { bold: false, status: 'Final' }
        ]);
        expect(result.gridOrder).toEqual(['LIVE', 'SOONER', 'LATER', 'FINALOT', 'DONE', 'UNKNOWN']);
    }, 30000);

    test('mobile Chrome (390x844): legacy 980px overview is preserved and body has real height', async () => {
        const g = await load(MOBILE);
        // No viewport meta tag: mobile Chrome lays the page out at 980px and zooms out.
        expect(g.innerWidth).toBe(980);
        expectClassicThreeColumns(g);
        expectNormalFlowGeometry(g);
        // The page is a tall document, as on the live site (~1700px).
        expect(g.docScrollHeight).toBeGreaterThan(g.teams.height - 1);
    }, 30000);

    test('scroll position is retained after programmatic and touch scrolling', async () => {
        const g = await load(DESKTOP);
        // Content must be taller than the viewport for this test to mean anything.
        expect(g.docScrollHeight).toBeGreaterThan(g.innerHeight);
        const maxScroll = g.docScrollHeight - g.innerHeight;
        const target = Math.min(300, maxScroll);

        await page.evaluate(y => window.scrollTo(0, y), target);
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(target, 0);
        // The body itself moved with the page (its box is the scrolled content).
        expect(await page.evaluate(() => document.body.getBoundingClientRect().top)).toBeCloseTo(-target, 0);
        expect(await page.evaluate(() => document.body.getBoundingClientRect().height)).toBeGreaterThan(g.innerHeight);

        // Touch-drag upward (finger moves up => page scrolls down) on a touch-enabled page.
        // hasTouch must be set before navigation (changing it triggers a reload).
        await load({ ...DESKTOP, hasTouch: true });
        await page.touchscreen.touchStart(640, 500);
        for (let y = 480; y >= 300; y -= 20) {
            await page.touchscreen.touchMove(640, y);
        }
        await page.touchscreen.touchEnd();
        const afterTouch = await settledScrollY(page);
        expect(afterTouch).toBeGreaterThan(0);
        // ...and it stays there (no snap back to the top).
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(await page.evaluate(() => window.scrollY)).toBeCloseTo(afterTouch, 0);
    }, 30000);
});
