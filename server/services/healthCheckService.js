const fs = require('fs').promises;
const path = require('path');
const { logInfo, logError, logWarn } = require('../utils/errorHandler');
const ScoringPlayParserService = require('./scoringPlayParserService');
// Canonical NFL team codes (Washington is WAS internally) - single source of
// truth in utils/teamMappings, do not redefine locally
const { CANONICAL_TEAM_CODES } = require('../utils/teamMappings');

const MAX_ALERTS = 200;

// Live-scoring watchdog thresholds (checkLiveScoring / checkFreshness).
// The live loop ticks every 60s; Tank01 live boxscores are cached 30s, so a
// healthy in-progress game is rewritten (last_updated bumped) every minute.
const LIVE = {
    loopHeartbeatSec: 180,          // last_live_update older than this = loop not ticking
    gameStaleSec: 300,              // in-progress nfl_games row not rewritten
    stuckScheduledSec: 20 * 60,     // still 'Scheduled' 0-0 this long after kickoff
    statsStaleSec: 600,             // newest player_stats row older than this while games run
    windowBeforeSec: 4 * 3600,      // "expected activity" = kickoff within [-4h, +15m]
    windowAfterSec: 15 * 60,
    inProgressMaxAgeSec: 24 * 3600, // ignore ancient rows stuck in a non-final status
    diskFreeMinBytes: 2 * 1024 * 1024 * 1024,
    watchdogStaleSec: 15 * 60,      // live-latest.json age (dead-man's switch)
    notifierStaleSec: 30 * 60       // notifier-state.json lastRunAt age
};
const SEVERITY_RANK = { ok: 0, info: 0, warning: 1, critical: 2 };

// SQLite CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS' in UTC with no zone
// marker; Date.parse would read that as local time.
function dbTimestampMs(value) {
    if (!value) return null;
    const s = String(value);
    const ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)
        ? Date.parse(s.replace(' ', 'T') + 'Z')
        : Date.parse(s);
    return Number.isNaN(ms) ? null : ms;
}

/**
 * Health/alert service (2026 reliability hardening, P0-1).
 *
 * - recordAlert() appends to logs/health-alerts.json (no DB table) and mirrors
 *   to the standard log so pm2 logs still show everything.
 * - runValidation() runs read-only data-quality checks against a completed (or
 *   in-progress) week and records alerts for anything that fails.
 */
class HealthCheckService {
    constructor(db, { teamScoreService = null, testRunnerService = null, alertsFile = null, backupDir = null,
        watchdogDir = undefined, dbPath = null } = {}) {
        this.db = db;
        this.teamScoreService = teamScoreService;
        this.testRunnerService = testRunnerService;
        this.alertsFile = alertsFile || path.join(__dirname, '../../logs/health-alerts.json');
        this.backupDir = backupDir || '/home/joepaley/backups';
        // logs/watchdog holds the live-scoring watchdog log + notifier state
        // (scripts/live-watchdog.js, scripts/watchdog-notifier.js). Pass
        // watchdogDir: false to skip their staleness check (tests).
        this.watchdogDir = watchdogDir === undefined ? path.join(__dirname, '../../logs/watchdog') : watchdogDir;
        this.dbPath = path.resolve(dbPath || process.env.DATABASE_PATH || path.join(__dirname, '../../fantasy_football.db'));
        this.scoringPlayParser = new ScoringPlayParserService();
        this.alertSeq = 0;
    }

    // ---------- Alert storage ----------

    async loadAlerts() {
        try {
            const raw = await fs.readFile(this.alertsFile, 'utf8');
            const alerts = JSON.parse(raw);
            return Array.isArray(alerts) ? alerts : [];
        } catch (error) {
            return []; // Missing or corrupt file: start fresh
        }
    }

    async saveAlerts(alerts) {
        await fs.mkdir(path.dirname(this.alertsFile), { recursive: true });
        await fs.writeFile(this.alertsFile, JSON.stringify(alerts, null, 2));
    }

    /**
     * Record an alert. severity: 'info' | 'warning' | 'critical'
     */
    async recordAlert(severity, source, message, details = null) {
        const alert = {
            id: `${Date.now()}-${++this.alertSeq}`,
            timestamp: new Date().toISOString(),
            severity,
            source,
            message,
            details,
            acknowledged: false
        };

        try {
            const alerts = await this.loadAlerts();
            alerts.push(alert);
            await this.saveAlerts(alerts.slice(-MAX_ALERTS));
        } catch (error) {
            logError('Failed to persist health alert', error);
        }

        const logContext = { source, details };
        if (severity === 'critical') {
            logError(`HEALTH ALERT [${source}]: ${message}`, null, logContext);
        } else if (severity === 'warning') {
            logWarn(`HEALTH ALERT [${source}]: ${message}`, logContext);
        } else {
            logInfo(`HEALTH ALERT [${source}]: ${message}`, logContext);
        }

        return alert;
    }

    async getAlerts({ unacknowledgedOnly = false } = {}) {
        const alerts = await this.loadAlerts();
        const filtered = unacknowledgedOnly ? alerts.filter(a => !a.acknowledged) : alerts;
        return filtered.slice().reverse(); // newest first
    }

    /**
     * Acknowledge alerts. ids = array of alert ids, or null/empty to ack all.
     */
    async acknowledgeAlerts(ids = null) {
        const alerts = await this.loadAlerts();
        const idSet = ids && ids.length ? new Set(ids) : null;
        let acked = 0;
        for (const alert of alerts) {
            if (!alert.acknowledged && (!idSet || idSet.has(alert.id))) {
                alert.acknowledged = true;
                acked++;
            }
        }
        await this.saveAlerts(alerts);
        return { acknowledged: acked };
    }

    // ---------- Validation ----------

    /**
     * Run read-only validation checks for a week.
     * mode: 'light' (roster invariant, stats completeness, freshness) used by the
     * daily update; 'full' adds the end-of-week suite, matchup consistency,
     * DST sanity and team-code checks. Records alerts for failures unless
     * recordAlerts=false.
     */
    async runValidation(week, season, { mode = 'full', recordAlerts = true } = {}) {
        const results = {
            week,
            season,
            mode,
            timestamp: new Date().toISOString(),
            checks: [],
            summary: { passed: 0, failed: 0, warnings: 0 }
        };

        const checkRunners = [
            ['Roster Invariant (12x19)', () => this.checkRosterInvariant(week, season)],
            ['Freshness', () => this.checkFreshness(week, season)],
            ['Week Advance Deadline', () => this.checkWeekAdvanceDeadline(week, season)]
        ];

        // The raw missing-stat-rows count is only a standalone check in light
        // mode (daily). In full mode the End-of-Week Suite runs the same query
        // and classifies each player against ESPN (inactive/resting vs actually
        // missing), so the unclassified count would just duplicate it as noise.
        if (mode !== 'full') {
            checkRunners.push(['Stats Completeness', () => this.checkStatsCompleteness(week, season)]);
        }

        if (mode === 'full') {
            checkRunners.push(
                ['Matchup Consistency', () => this.checkMatchupConsistency(week, season)],
                ['DST Sanity', () => this.checkDSTSanity(week, season)],
                ['Team Code Consistency', () => this.checkTeamCodes(week, season)],
                ['End-of-Week Suite', () => this.checkEndOfWeekSuite(week, season)]
            );
        }

        for (const [name, runner] of checkRunners) {
            let check;
            try {
                check = await runner();
            } catch (error) {
                check = {
                    name,
                    status: 'failed',
                    message: `Check threw an error: ${error.message}`
                };
            }
            check.name = check.name || name;
            results.checks.push(check);

            if (check.status === 'passed') results.summary.passed++;
            else if (check.status === 'warning') results.summary.warnings++;
            else results.summary.failed++;
        }

        results.overallStatus = results.summary.failed === 0 ? 'passed' : 'failed';

        if (recordAlerts) {
            for (const check of results.checks) {
                if (check.status === 'failed') {
                    await this.recordAlert('critical', `validation:${check.name}`,
                        `Week ${week}/${season}: ${check.message}`, check.details || null);
                } else if (check.status === 'warning') {
                    await this.recordAlert('warning', `validation:${check.name}`,
                        `Week ${week}/${season}: ${check.message}`, check.details || null);
                }
            }
        }

        logInfo(`Health validation (${mode}) for week ${week}/${season}: ` +
            `${results.summary.passed} passed, ${results.summary.failed} failed, ${results.summary.warnings} warnings`);

        return results;
    }

    /**
     * Check 1: every team has exactly 19 active players.
     */
    async checkRosterInvariant(week, season) {
        let incompleteTeams;
        if (this.teamScoreService) {
            const result = await this.teamScoreService.verifyRosterCompleteness(week, season);
            incompleteTeams = result.incompleteTeams;
        } else {
            incompleteTeams = await this.db.all(`
                SELECT t.team_id, t.team_name, COUNT(wr.player_id) as active_players
                FROM teams t
                LEFT JOIN weekly_rosters wr ON t.team_id = wr.team_id
                    AND wr.week = ? AND wr.season = ? AND wr.roster_position = 'active'
                GROUP BY t.team_id, t.team_name
                HAVING active_players != 19
            `, [week, season]);
        }

        return {
            name: 'Roster Invariant (12x19)',
            status: incompleteTeams.length === 0 ? 'passed' : 'failed',
            message: incompleteTeams.length === 0
                ? 'All 12 teams have exactly 19 active players'
                : `${incompleteTeams.length} team(s) without exactly 19 active players`,
            details: incompleteTeams.map(t => `${t.team_name}: ${t.active_players} active players`)
        };
    }

    /**
     * Check 2 (warn-level): every active rostered player whose NFL team played a
     * completed game has a player_stats row.
     */
    async checkStatsCompleteness(week, season) {
        const missing = await this.db.all(`
            SELECT wr.player_id, wr.player_name, wr.player_position, wr.player_team, wr.team_id
            FROM weekly_rosters wr
            JOIN nfl_games ng ON wr.week = ng.week AND wr.season = ng.season
                AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
            LEFT JOIN player_stats ps ON wr.player_id = ps.player_id
                AND wr.week = ps.week AND wr.season = ps.season
            WHERE wr.season = ? AND wr.week = ?
                AND wr.roster_position = 'active'
                AND ng.status LIKE 'Final%'
                AND ps.stat_id IS NULL
            ORDER BY wr.team_id, wr.player_name
        `, [season, week]);

        return {
            name: 'Stats Completeness',
            status: missing.length === 0 ? 'passed' : 'warning',
            message: missing.length === 0
                ? 'All active players with completed games have stat rows'
                : `${missing.length} active player(s) with completed games have no stat row`,
            details: missing.slice(0, 15).map(p =>
                `${p.player_name} (${p.player_position}, ${p.player_team}) on fantasy team ${p.team_id}`)
        };
    }

    /**
     * Check 5: daily update ran within 26h and newest backup is younger than 48h.
     * Skipped entirely in the offseason (no games scheduled for the week).
     */
    async checkFreshness(week, season) {
        const games = await this.db.get(
            'SELECT COUNT(*) as count FROM nfl_games WHERE week = ? AND season = ?',
            [week, season]
        );

        if (!games || games.count === 0) {
            return {
                name: 'Freshness',
                status: 'passed',
                message: `No games scheduled for week ${week}/${season} (offseason) - freshness checks skipped`
            };
        }

        const issues = [];

        const settings = await this.db.get(
            'SELECT last_daily_update FROM league_settings WHERE league_id = 1'
        );
        if (!settings || !settings.last_daily_update) {
            issues.push('No last_daily_update timestamp recorded');
        } else {
            const ageHours = (Date.now() - new Date(settings.last_daily_update).getTime()) / 3600000;
            if (ageHours > 26) {
                issues.push(`Last daily update was ${ageHours.toFixed(1)}h ago (limit 26h)`);
            }
        }

        try {
            const files = await fs.readdir(this.backupDir);
            const backups = files.filter(f => /^fantasy_football_\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
            if (backups.length === 0) {
                issues.push(`No backups found in ${this.backupDir}`);
            } else {
                const newest = backups[backups.length - 1];
                const stat = await fs.stat(path.join(this.backupDir, newest));
                const ageHours = (Date.now() - stat.mtimeMs) / 3600000;
                if (ageHours > 48) {
                    issues.push(`Newest backup (${newest}) is ${ageHours.toFixed(1)}h old (limit 48h)`);
                }
            }
        } catch (error) {
            issues.push(`Could not read backup directory ${this.backupDir}: ${error.message}`);
        }

        if (this.watchdogDir) {
            issues.push(...await this.watchdogStalenessIssues());
        }

        return {
            name: 'Freshness',
            status: issues.length === 0 ? 'passed' : 'failed',
            message: issues.length === 0
                ? 'Daily update, backups and live watchdog are fresh'
                : issues.join('; '),
            details: issues
        };
    }

    /**
     * Dead-man's switch for the live-scoring watchdog: the watchdog rewrites
     * logs/watchdog/live-latest.json every 2 min and the notifier stamps
     * lastRunAt in notifier-state.json every 5 min. Either going quiet means
     * nobody is watching live scoring, and the daily update emails on it.
     */
    async watchdogStalenessIssues(now = Date.now()) {
        const issues = [];
        const readJson = async file => {
            try {
                return JSON.parse(await fs.readFile(path.join(this.watchdogDir, file), 'utf8'));
            } catch (_) {
                return null;
            }
        };

        const latest = await readJson('live-latest.json');
        if (!latest || !latest.ts) {
            issues.push('Live watchdog has never written logs/watchdog/live-latest.json (is statfink2-watchdog running?)');
        } else {
            const ageMin = (now - Date.parse(latest.ts)) / 60000;
            if (!(ageMin <= LIVE.watchdogStaleSec / 60)) {
                issues.push(`Live watchdog last checked ${ageMin.toFixed(0)}m ago (limit ${LIVE.watchdogStaleSec / 60}m) - statfink2-watchdog may be down`);
            }
        }

        const state = await readJson('notifier-state.json');
        if (!state || !state.lastRunAt) {
            issues.push('Watchdog notifier has never run (logs/watchdog/notifier-state.json missing)');
        } else {
            const ageMin = (now - Date.parse(state.lastRunAt)) / 60000;
            if (!(ageMin <= LIVE.notifierStaleSec / 60)) {
                issues.push(`Watchdog notifier last ran ${ageMin.toFixed(0)}m ago (limit ${LIVE.notifierStaleSec / 60}m) - statfink2-watchdog-notifier cron may be broken`);
            }
        }
        return issues;
    }

    /**
     * Live-scoring health, judged from data freshness against expected
     * activity - never from HTTP success (performLiveGameUpdate returns 200
     * even when every Tank01 call failed). Read-only. Polled every 2 min by
     * scripts/live-watchdog.js via GET /api/internal/health/live, which
     * writes the result as one line of logs/watchdog/live-YYYY-MM-DD.jsonl.
     *
     * status:   ok | idle | stalled | degraded | misconfigured
     * severity: ok | warning | critical (worst failing signal)
     * liveErrors: schedulerService.lastLiveErrors (sub-step errors swallowed
     * by the last live update).
     */
    async checkLiveScoring({ now = Date.now(), liveErrors = null } = {}) {
        const T = LIVE;
        const nowSec = Math.floor(now / 1000);
        const signals = [];
        const fail = (name, severity, detail) => signals.push({ name, ok: false, severity, detail });
        const pass = (name, detail) => signals.push(detail ? { name, ok: true, detail } : { name, ok: true });
        const ageSec = ts => {
            const ms = dbTimestampMs(ts);
            return ms === null ? null : Math.max(0, Math.round((now - ms) / 1000));
        };

        const settings = await this.db.get(
            'SELECT current_week, season_year, last_live_update FROM league_settings WHERE league_id = 1'
        );
        const week = settings ? settings.current_week : null;
        const season = settings ? settings.season_year : null;
        const loopAgeSec = settings ? ageSec(settings.last_live_update) : null;
        const base = { checkedAt: new Date(now).toISOString(), week, season, loopAgeSec };

        if (!week || !season) {
            fail('settings', 'critical', 'league_settings current_week/season_year not set - live updates cannot run');
            return { ...base, status: 'misconfigured', severity: 'critical', expectedGames: 0, gamesInProgress: 0, signals, summary: signals[0].detail };
        }

        // 1. Expected activity: games in the kickoff window or in progress, any
        //    week of the season (the live loop only polls current_week - that
        //    difference is exactly what signal 2 catches).
        const windowGames = await this.db.all(`
            SELECT game_id, week, COALESCE(status, 'Scheduled') AS status,
                   home_score, away_score, game_time_epoch, last_updated
            FROM nfl_games
            WHERE season = ?
              AND COALESCE(status, 'Scheduled') NOT LIKE 'Final%'
              AND game_time_epoch IS NOT NULL
              AND (game_time_epoch BETWEEN ? AND ?
                   OR (COALESCE(status, 'Scheduled') != 'Scheduled' AND game_time_epoch > ?))
            ORDER BY game_time_epoch
        `, [season, nowSec - T.windowBeforeSec, nowSec + T.windowAfterSec, nowSec - T.inProgressMaxAgeSec]);
        const expectedGames = windowGames.length;
        const live = expectedGames > 0;
        pass('expected_activity', live ? `${expectedGames} game(s) in the live window` : 'no games in the live window');

        // 2. Week mismatch (the "forgot to advance the week" failure)
        const wrongWeek = windowGames.filter(g => g.week !== week);
        if (wrongWeek.length) {
            const weeks = [...new Set(wrongWeek.map(g => g.week))].join(',');
            fail('week_match', 'critical',
                `${wrongWeek.length} game(s) live/kicking off in week ${weeks} but current_week is ${week} - ` +
                'ADVANCE THE WEEK (admin dashboard weekly update); their stats are not being collected');
        } else {
            pass('week_match');
        }

        // 3. Loop heartbeat (the loop should tick 24/7; only critical when games are on)
        if (loopAgeSec === null) {
            fail('loop_heartbeat', live ? 'critical' : 'warning', 'last_live_update never recorded');
        } else if (loopAgeSec > T.loopHeartbeatSec) {
            fail('loop_heartbeat', live ? 'critical' : 'warning',
                `last_live_update ${loopAgeSec}s ago (limit ${T.loopHeartbeatSec}s) - statfink2-live-continuous is not ticking`);
        } else {
            pass('loop_heartbeat', `loop ticked ${loopAgeSec}s ago`);
        }

        // 4. Game freshness: current-week games that have kicked off must be
        //    rewritten every poll (in progress) or have left 'Scheduled'.
        const currentWeekGames = windowGames.filter(g => g.week === week);
        const kickedOff = currentWeekGames.filter(g => g.game_time_epoch <= nowSec);
        const inProgress = kickedOff.filter(g => g.status !== 'Scheduled');
        const staleGames = [];
        const stuckGames = [];
        for (const g of kickedOff) {
            const sinceKick = nowSec - g.game_time_epoch;
            if (g.status === 'Scheduled') {
                if (sinceKick > T.stuckScheduledSec && !(g.home_score > 0 || g.away_score > 0)) {
                    stuckGames.push(`${g.game_id} still Scheduled 0-0 ${Math.round(sinceKick / 60)}m after kickoff`);
                }
            } else {
                const a = ageSec(g.last_updated);
                if (a === null || a > T.gameStaleSec) {
                    staleGames.push(`${g.game_id} (${g.status}) last_updated ${a === null ? 'never' : `${a}s ago`}`);
                }
            }
        }
        if (staleGames.length || stuckGames.length) {
            const parts = [];
            if (staleGames.length) {
                parts.push(`${staleGames.length} of ${inProgress.length} in-progress game(s) not updated in ${T.gameStaleSec}s: ${staleGames.slice(0, 3).join('; ')}`);
            }
            parts.push(...stuckGames.slice(0, 3));
            fail('game_freshness', 'critical', parts.join('; '));
        } else {
            pass('game_freshness', kickedOff.length
                ? `${inProgress.length} in progress, all updated within ${T.gameStaleSec}s`
                : 'no current-week game has kicked off');
        }

        // 5. Stats flow: once a game has been running a while, player_stats rows
        //    must be moving (catches boxscore parsing dying while status still updates)
        const matured = inProgress.filter(g => nowSec - g.game_time_epoch > T.statsStaleSec);
        if (matured.length) {
            const row = await this.db.get(
                'SELECT MAX(last_updated) AS newest FROM player_stats WHERE week = ? AND season = ?',
                [week, season]
            );
            const a = row ? ageSec(row.newest) : null;
            if (a === null || a > T.statsStaleSec) {
                fail('stats_flow', 'warning',
                    `newest player_stats row for week ${week} is ${a === null ? 'missing' : `${Math.round(a / 60)}m old`} ` +
                    `with ${matured.length} game(s) in progress (limit ${T.statsStaleSec / 60}m) - boxscore stats are not being written`);
            } else {
                pass('stats_flow', `player_stats written ${a}s ago`);
            }
        } else {
            pass('stats_flow', 'no game in progress long enough to judge');
        }

        // 6. Matchup totals (matchups has no timestamp; consistency is the only proxy)
        if (live) {
            const m = await this.checkMatchupConsistency(week, season);
            if (m.status === 'passed') {
                pass('matchup_totals', m.message);
            } else {
                const detail = m.details && m.details.length ? `: ${m.details.slice(0, 2).join('; ')}` : '';
                fail('matchup_totals', 'warning', m.message + detail);
            }
        } else {
            pass('matchup_totals', 'skipped (idle)');
        }

        // 7. Sub-step errors swallowed by the last live update
        const errs = Array.isArray(liveErrors) ? liveErrors : [];
        if (live && errs.length) {
            fail('live_errors', 'warning', `last live update reported ${errs.length} error(s): ${errs.slice(0, 3).join(' | ')}`);
        } else {
            pass('live_errors', errs.length ? `${errs.length} error(s) on last update while idle` : undefined);
        }

        // 8. Disk: SQLite WAL + unrotated pm2 logs is the likeliest Sunday killer
        try {
            const st = await fs.statfs(path.dirname(this.dbPath));
            const free = Number(st.bavail) * Number(st.bsize);
            const gb = (free / 1024 ** 3).toFixed(1);
            if (free < T.diskFreeMinBytes) {
                fail('disk_free', 'critical',
                    `${gb} GB free on the database volume (limit ${(T.diskFreeMinBytes / 1024 ** 3).toFixed(0)} GB) - SQLite writes will fail; rotate ~/.pm2/logs`);
            } else {
                pass('disk_free', `${gb} GB free`);
            }
        } catch (error) {
            pass('disk_free', `unavailable: ${error.message}`);
        }

        // Roll up
        const failing = signals.filter(s => !s.ok);
        const has = name => failing.some(s => s.name === name);
        let status;
        if (has('week_match')) status = 'misconfigured';
        else if (has('loop_heartbeat') || has('game_freshness')) status = 'stalled';
        else if (failing.length) status = 'degraded';
        else status = live ? 'ok' : 'idle';
        const severity = failing.reduce(
            (worst, s) => (SEVERITY_RANK[s.severity] > SEVERITY_RANK[worst] ? s.severity : worst), 'ok');

        let summary;
        if (!failing.length) {
            summary = live
                ? `${expectedGames} game(s) in window (${inProgress.length} in progress), loop ticked ${loopAgeSec}s ago, stats flowing`
                : `No games in the live window; loop ticked ${loopAgeSec === null ? 'never' : `${loopAgeSec}s ago`}`;
        } else {
            summary = failing.map(s => s.detail).join('; ');
        }
        if (summary.length > 400) summary = `${summary.slice(0, 397)}...`;

        return { ...base, status, severity, expectedGames, gamesInProgress: inProgress.length, signals, summary };
    }

    /**
     * The weekly update (advance current_week) is deliberately manual, but it
     * must happen before the next week's first kickoff: live updates poll
     * current_week, so an unadvanced week silently loses the new week's stats.
     * Fails when the current week is complete and the next week's first game
     * is under 24h away; warns when the week has been complete >72h with no
     * next-week schedule to judge by.
     */
    async checkWeekAdvanceDeadline(week, season) {
        const name = 'Week Advance Deadline';
        const pass = message => ({ name, status: 'passed', message });

        const current = await this.db.get(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status LIKE 'Final%' THEN 1 ELSE 0 END) as final,
                   MAX(game_time_epoch) as last_epoch
            FROM nfl_games WHERE week = ? AND season = ?
        `, [week, season]);

        if (!current || current.total === 0) {
            return pass(`No games for week ${week}/${season} (offseason) - nothing to advance`);
        }
        if (current.final < current.total) {
            return pass(`Week ${week} still in progress (${current.final}/${current.total} final)`);
        }

        const nowEpoch = Math.floor(Date.now() / 1000);

        const nextWeek = await this.db.get(`
            SELECT MIN(game_time_epoch) as first_epoch, COUNT(*) as total
            FROM nfl_games WHERE week = ? AND season = ?
        `, [week + 1, season]);

        if (nextWeek && nextWeek.total > 0 && nextWeek.first_epoch) {
            const hoursToKickoff = (nextWeek.first_epoch - nowEpoch) / 3600;
            if (hoursToKickoff < 24) {
                return {
                    name,
                    status: 'failed',
                    message: `ADVANCE THE WEEK: week ${week} is complete and week ${week + 1} kicks off ` +
                        (hoursToKickoff <= 0
                            ? `${Math.abs(hoursToKickoff).toFixed(0)}h AGO - its stats are NOT being collected`
                            : `in ${hoursToKickoff.toFixed(0)}h - live updates only poll the current week`)
                };
            }
            return pass(`Week ${week} complete; ${hoursToKickoff.toFixed(0)}h until week ${week + 1} kickoff`);
        }

        // No next-week schedule to judge by (daily sync only pulls the current
        // week). Season's final week has nothing to advance to; otherwise a
        // long-complete week deserves a nudge.
        if (week >= 18) {
            return pass(`Week ${week} is the final week - nothing to advance to`);
        }
        const hoursSinceEnd = current.last_epoch ? (nowEpoch - current.last_epoch) / 3600 : null;
        if (hoursSinceEnd !== null && hoursSinceEnd > 72) {
            return {
                name,
                status: 'warning',
                message: `Week ${week} has been complete for ${hoursSinceEnd.toFixed(0)}h and week ${week + 1}'s ` +
                    `schedule is not synced - advance the week (and sync the new week's games)`
            };
        }
        return pass(`Week ${week} complete; no week ${week + 1} schedule yet, within the grace window`);
    }

    /**
     * Check 4: matchup scoring points equal the sum of marked scoring players'
     * fantasy points for each side.
     */
    async checkMatchupConsistency(week, season) {
        const mismatches = await this.db.all(`
            SELECT
                m.matchup_id,
                m.team1_id, m.team2_id,
                m.team1_scoring_points, m.team2_scoring_points,
                (SELECT COALESCE(SUM(ps.fantasy_points), 0)
                 FROM weekly_rosters wr
                 JOIN player_stats ps ON wr.player_id = ps.player_id
                     AND ps.week = wr.week AND ps.season = wr.season
                 WHERE wr.team_id = m.team1_id AND wr.week = m.week
                     AND wr.season = m.season AND wr.is_scoring = 1) as team1_sum,
                (SELECT COALESCE(SUM(ps.fantasy_points), 0)
                 FROM weekly_rosters wr
                 JOIN player_stats ps ON wr.player_id = ps.player_id
                     AND ps.week = wr.week AND ps.season = wr.season
                 WHERE wr.team_id = m.team2_id AND wr.week = m.week
                     AND wr.season = m.season AND wr.is_scoring = 1) as team2_sum
            FROM matchups m
            WHERE m.week = ? AND m.season = ?
        `, [week, season]);

        const issues = [];
        for (const m of mismatches) {
            if (Math.abs((m.team1_scoring_points || 0) - m.team1_sum) > 0.05) {
                issues.push(`Matchup ${m.matchup_id} team ${m.team1_id}: matchup=${m.team1_scoring_points}, scoring players sum=${m.team1_sum.toFixed(2)}`);
            }
            if (Math.abs((m.team2_scoring_points || 0) - m.team2_sum) > 0.05) {
                issues.push(`Matchup ${m.matchup_id} team ${m.team2_id}: matchup=${m.team2_scoring_points}, scoring players sum=${m.team2_sum.toFixed(2)}`);
            }
        }

        return {
            name: 'Matchup Consistency',
            status: issues.length === 0 ? 'passed' : 'failed',
            message: issues.length === 0
                ? `All ${mismatches.length} matchups match their scoring players' point sums`
                : `${issues.length} matchup side(s) do not match scoring players' point sums`,
            details: issues
        };
    }

    /**
     * Check 6: DST sanity (the #1 historical bug source).
     *  a. Completed games with points on the board whose cached boxscore yields
     *     zero parsed scoring plays (parser silently swallowing errors).
     *  b. Rostered DSTs whose team played a completed game but have no stat row.
     *  c. Defensive bonuses applied once all games are final.
     */
    async checkDSTSanity(week, season) {
        const issues = [];
        const warnings = [];

        const games = await this.db.all(
            "SELECT game_id, home_team, away_team, home_score, away_score, status FROM nfl_games WHERE week = ? AND season = ?",
            [week, season]
        );
        const finalGames = games.filter(g => g.status && g.status.startsWith('Final'));

        if (games.length === 0) {
            return {
                name: 'DST Sanity',
                status: 'passed',
                message: `No games for week ${week}/${season} - DST checks skipped`
            };
        }

        // a. Boxscores that parse to zero scoring plays despite a non-zero final score
        for (const game of finalGames) {
            if ((game.home_score || 0) + (game.away_score || 0) === 0) continue;

            const cached = await this.db.get(
                'SELECT response_data FROM tank01_cache WHERE cache_key = ?',
                [`boxscore_${game.game_id}`]
            );
            if (!cached) continue; // Nothing cached to verify against

            try {
                const data = JSON.parse(cached.response_data);
                const body = data.body || data;
                const plays = this.scoringPlayParser.extractScoringPlays(body);
                if (plays.length === 0) {
                    issues.push(`${game.game_id}: final score ${game.away_score}-${game.home_score} but boxscore parsed to 0 scoring plays`);
                }
            } catch (error) {
                issues.push(`${game.game_id}: cached boxscore could not be parsed (${error.message})`);
            }
        }

        // b. Rostered DSTs with a completed game but no stats recorded
        const missingDSTs = await this.db.all(`
            SELECT DISTINCT wr.player_id, wr.player_name, wr.player_team, wr.team_id
            FROM weekly_rosters wr
            JOIN nfl_games ng ON wr.week = ng.week AND wr.season = ng.season
                AND (ng.home_team = wr.player_team OR ng.away_team = wr.player_team)
            LEFT JOIN player_stats ps ON wr.player_id = ps.player_id
                AND wr.week = ps.week AND wr.season = ps.season
            WHERE wr.season = ? AND wr.week = ?
                AND wr.player_position = 'DST'
                AND wr.roster_position = 'active'
                AND ng.status LIKE 'Final%'
                AND ps.stat_id IS NULL
        `, [season, week]);
        for (const dst of missingDSTs) {
            issues.push(`${dst.player_name} (${dst.player_team}) played but has no stats row (fantasy team ${dst.team_id})`);
        }

        // c. Defensive bonuses applied once the week is fully complete
        const allFinal = finalGames.length === games.length;
        if (allFinal) {
            const bonuses = await this.db.get(`
                SELECT
                    SUM(CASE WHEN def_yards_bonus > 0 THEN 1 ELSE 0 END) as yards_bonus_count,
                    SUM(CASE WHEN def_points_bonus > 0 THEN 1 ELSE 0 END) as points_bonus_count
                FROM player_stats
                WHERE week = ? AND season = ?
            `, [week, season]);
            if (!bonuses || !bonuses.yards_bonus_count) {
                issues.push('All games final but no fewest-yards-allowed bonus has been applied');
            }
            if (!bonuses || !bonuses.points_bonus_count) {
                issues.push('All games final but no fewest-points-allowed bonus has been applied');
            }
        } else {
            warnings.push(`${finalGames.length}/${games.length} games final - bonus check deferred`);
        }

        const status = issues.length > 0 ? 'failed' : (warnings.length > 0 ? 'warning' : 'passed');
        return {
            name: 'DST Sanity',
            status,
            message: issues.length === 0
                ? (warnings.length === 0 ? 'DST scoring plays, stats and bonuses all look sane' : warnings.join('; '))
                : `${issues.length} DST issue(s) found`,
            details: [...issues, ...warnings]
        };
    }

    /**
     * Check 7 (warn-level): every team code used this week is a canonical NFL
     * code (catches recurring WSH/WAS-class mismatches).
     */
    async checkTeamCodes(week, season) {
        const sources = {
            player_stats: await this.db.all(
                'SELECT DISTINCT team as code FROM player_stats WHERE week = ? AND season = ? AND team IS NOT NULL AND team != ""',
                [week, season]
            ),
            weekly_rosters: await this.db.all(
                'SELECT DISTINCT player_team as code FROM weekly_rosters WHERE week = ? AND season = ?',
                [week, season]
            ),
            nfl_games: await this.db.all(
                'SELECT home_team as code FROM nfl_games WHERE week = ? AND season = ? UNION SELECT away_team FROM nfl_games WHERE week = ? AND season = ?',
                [week, season, week, season]
            )
        };

        const unknown = [];
        for (const [table, rows] of Object.entries(sources)) {
            for (const row of rows) {
                if (row.code && !CANONICAL_TEAM_CODES.has(row.code)) {
                    unknown.push(`${table}: '${row.code}'`);
                }
            }
        }

        return {
            name: 'Team Code Consistency',
            status: unknown.length === 0 ? 'passed' : 'warning',
            message: unknown.length === 0
                ? 'All team codes are canonical'
                : `${unknown.length} non-canonical team code(s) found`,
            details: unknown
        };
    }

    /**
     * Check 3: run the existing end-of-week validation suite in-process
     * (read-only; includes ESPN cross-checks for missing stats).
     */
    async checkEndOfWeekSuite(week, season) {
        if (!this.testRunnerService) {
            return {
                name: 'End-of-Week Suite',
                status: 'warning',
                message: 'testRunnerService not available - suite skipped'
            };
        }

        const results = await this.testRunnerService.runValidateEndOfWeekTest(week, season);
        const failed = (results.checks || []).filter(c => c.status === 'failed');
        const warned = (results.checks || []).filter(c => c.status === 'warning');

        let status = 'passed';
        if (results.overallStatus === 'error' || failed.length > 0) status = 'failed';
        else if (warned.length > 0) status = 'warning';

        return {
            name: 'End-of-Week Suite',
            status,
            message: results.overallStatus === 'error'
                ? `Suite execution error: ${results.error?.message || 'unknown'}`
                : `${results.summary.passed} passed, ${results.summary.failed} failed, ${results.summary.warnings} warnings`,
            details: [...failed, ...warned].map(c => `${c.name}: ${c.message}`)
        };
    }
}

module.exports = HealthCheckService;
