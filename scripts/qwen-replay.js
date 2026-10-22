#!/usr/bin/env node
/**
 * Qwen replay: ask the local Qwen the SAME question the live review asks, for
 * every touchdown / safety of past weeks, and score its answers.
 *
 *   node scripts/qwen-replay.js --season 2025 [--weeks 2,3,7] [--limit N] [--dry] [--report-only]
 *        [--tag v2] [--classes DEF_8_FUMBLE,AMBIGUOUS --sample 10]
 *   --tag      write logs/qwen-replay/<season>/replay-<tag>.json instead (compare prompt versions)
 *   --classes  only plays the script classes so; --sample N adds every Nth other play as a control
 *
 * Read-only: nfl_games / tank01_cache / player_stats are read, the ESPN
 * summaries come from the Double Check's cache (weeks without a cache are
 * skipped unless --online), nothing in the DB or the live-review state changes.
 * Results accumulate in logs/qwen-replay/<season>/replay.json (resumable) and
 * report.md summarises:
 *   - agreement with the calibrated script per award class (false disputes),
 *   - the registered known errors of that season the play concerns: did Qwen
 *     pick the CORRECT award (the script's, proven by the calibration) or the
 *     one production stored,
 *   - what Qwen said on the plays the rules could not decide (AMBIGUOUS),
 *   - latency and rejected answers.
 */
const fs = require('fs');
const path = require('path');
const LR = require('./lib/liveReview');
const tdDossier = require('./lib/tdDossier');
const espnClient = require('./lib/espnClient');
const live = require('./live-review');
const qwen = require('./lib/qwenClient');
const known = require('../server/config/knownScoringErrors.json');

const REPO = path.resolve(__dirname, '..');
const ESPN_ROOT = path.join(REPO, 'logs', 'doublecheck', 'espn');
const args = process.argv.slice(2);
const argValue = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const season = parseInt(argValue('--season') || '2025', 10);
const limit = argValue('--limit') ? parseInt(argValue('--limit'), 10) : Infinity;
const dry = args.includes('--dry');
const online = args.includes('--online');
const reportOnly = args.includes('--report-only');
const tag = argValue('--tag');                      // separate results file, e.g. after a prompt change
const classes = argValue('--classes') ? new Set(argValue('--classes').split(',')) : null;   // only plays the script classes so
const sample = argValue('--sample') ? parseInt(argValue('--sample'), 10) : null;             // plus every Nth play outside --classes as a control
const OUT_DIR = path.join(REPO, 'logs', 'qwen-replay', String(season));
const RESULTS = path.join(OUT_DIR, tag ? `replay-${tag}.json` : 'replay.json');
const REPORT = path.join(OUT_DIR, tag ? `report-${tag}.md` : 'report.md');
const pad2 = n => String(n).padStart(2, '0');
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`);

function cachedWeeks() {
    const dir = path.join(ESPN_ROOT, String(season));
    try { return fs.readdirSync(dir).map(n => /^week(\d\d)$/.exec(n)).filter(Boolean).map(m => Number(m[1])).sort((a, b) => a - b); } catch (_) { return []; }
}
function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
function writeJsonAtomic(f, obj) { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(obj, null, 2)); fs.renameSync(t, f); }

/** Registry entries this play's expected credits touch (game + column). */
function knownFor(gameId, play) {
    const cols = new Set((play.expectedCredits || []).map(c => c.column));
    return (known.entries || []).filter(e => e.season === season && e.game_id === gameId && e.column && (cols.has(e.column) || play.agreement === false)).map(e => e.id);
}

async function collect(weeks) {
    const results = readJson(RESULTS) || { season, model: qwen.config().model, startedAt: new Date().toISOString(), records: {} };
    let asked = 0, skipped = 0, planned = 0, controlSeen = 0;
    const rule = live.ruleText();
    const options = live.optionsTable();
    for (const week of weeks) {
        const db = await live.openDb();
        let league, data;
        try {
            league = await live.readLeague(db, { season, week });
            data = await live.loadGameData(db, season, week, league.games);
        } finally { await live.closeDb(db); }
        const games = league.games.filter(g => /^Final/i.test(String(g.status)));
        const offline = !online || live.cachedFinal(season, week, games);
        const espn = await live.pullEspn(season, week, games, { offline, log: () => {} });
        log(`week ${week}: ${games.length} final game(s); espn ${espn.cached} cached, ${espn.fetched} fetched, ${espn.missing.length} missing`);
        for (const g of games) {
            const box = data.boxscores.get(g.game_id);
            const summary = espn.summaries.get(g.game_id);
            if (!box || !summary) { log(`  ${g.game_id}: ${!box ? 'no boxscore' : 'no ESPN summary'} - skipped`); continue; }
            let dossier;
            try {
                dossier = tdDossier.buildGameDossier({ gameId: g.game_id, season, week, homeTeam: g.home_team, awayTeam: g.away_team, tank01Body: box, espnSummary: summary, playerPositions: data.playerPositions, nflPlayers: data.nflPlayers, dbRows: data.statsByGame.get(g.game_id) || [], finalScore: { home: g.home_score, away: g.away_score } });
            } catch (e) { log(`  ${g.game_id}: dossier failed: ${e.message}`); continue; }
            const plays = (dossier.plays || []).filter(p => p.kind === 'TD' || p.kind === 'SAFETY');
            for (const play of plays) {
                const key = LR.playKey(g.game_id, play);
                if (classes && !classes.has(play.awardClass)) {
                    if (!sample) continue;
                    controlSeen += 1;
                    if (controlSeen % sample !== 0) continue;
                }
                planned += 1;
                if (results.records[key] && results.records[key].qwen) { skipped += 1; continue; }
                if (dry) continue;
                if (asked >= limit) continue;
                asked += 1;
                const t0 = Date.now();
                const r = await live.qwenVote(play, g.game_id, { season, week, rule, options, log: m => log(`    ${m}`) });
                const verdict = LR.compareVotes({ play, qwen: r.vote });
                const rec = LR.reviewRecord({ play, gameId: g.game_id, season, week, qwen: r.vote, qwenError: r.error, verdict, ts: new Date().toISOString() });
                rec.knownErrors = knownFor(g.game_id, play);
                rec.wallMs = Date.now() - t0;
                results.records[key] = rec;
                writeJsonAtomic(RESULTS, results);
                const q = r.vote ? `${r.vote.awardClass} (${r.vote.confidence || '?'}, ${r.vote.latencyMs} ms)` : `NO VOTE: ${r.error}`;
                log(`  ${key} | ${(rec.text || '').slice(0, 70)} | script ${play.awardClass} | qwen ${q} -> ${verdict.status}${rec.knownErrors.length ? ` [KNOWN ERROR ${rec.knownErrors.join(',')}]` : ''}`);
                if (r.unreachable) { log('qwen unreachable - stopping; rerun to resume'); return { results, asked, skipped, planned, stopped: true }; }
            }
        }
    }
    return { results, asked, skipped, planned, stopped: false };
}

function pct(a, b) { return b ? `${Math.round((100 * a) / b)}%` : '-'; }

function buildReport(results) {
    const recs = Object.values(results.records);
    const voted = recs.filter(r => r.qwen);
    const lines = [];
    lines.push(`# Qwen replay - ${season} (${results.model || 'model ?'})`, '', `Generated ${new Date().toISOString()}. ${recs.length} plays asked, ${voted.length} answered, ${recs.length - voted.length} rejected/unreachable.`, '');
    // 1. agreement by script class
    const classes = [...new Set(recs.map(r => r.deterministic.awardClass))].sort();
    lines.push('## Agreement with the calibrated script, by award class', '', '| script class | plays | Qwen agrees | Qwen disagrees | no vote | false-dispute rate |', '|---|---|---|---|---|---|');
    for (const c of classes) {
        const rs = recs.filter(r => r.deterministic.awardClass === c);
        const agree = rs.filter(r => r.qwen && r.qwen.awardClass === c).length;
        const dis = rs.filter(r => r.qwen && r.qwen.awardClass !== c).length;
        const none = rs.filter(r => !r.qwen).length;
        lines.push(`| ${c} | ${rs.length} | ${agree} | ${dis} | ${none} | ${c === 'AMBIGUOUS' ? 'n/a' : pct(dis, agree + dis)} |`);
    }
    const decisive = recs.filter(r => r.deterministic.awardClass !== 'AMBIGUOUS' && r.qwen);
    const disputes = decisive.filter(r => r.qwen.awardClass !== r.deterministic.awardClass);
    lines.push('', `Overall: Qwen disputed ${disputes.length} of ${decisive.length} decided plays (${pct(disputes.length, decisive.length)}). Each dispute would have been an "under review" row and a question for Opus.`, '');
    // 2. known errors
    const ke = recs.filter(r => r.knownErrors && r.knownErrors.length);
    lines.push('## Registered known errors (production scored these wrong; the script\'s class is the proven-correct one)', '');
    if (!ke.length) lines.push('_none of the replayed plays touch a registry entry_');
    for (const r of ke) {
        const right = r.qwen && r.qwen.awardClass === r.deterministic.awardClass;
        lines.push(`- **${r.knownErrors.join(', ')}** - ${r.gameId} ${r.period} ${r.clock}: "${r.text}"`, `  - correct: ${r.deterministic.awardClass}; Qwen: ${r.qwen ? `${r.qwen.awardClass} (${r.qwen.confidence})` : 'no vote'} -> ${right ? 'WOULD HAVE CAUGHT IT' : 'MISSED'}`, r.qwen && r.qwen.reasoning ? `  - Qwen: ${r.qwen.reasoning.slice(0, 300)}` : '');
    }
    // 3. disputes
    lines.push('', '## Disputes (Qwen vs script on decided plays)', '');
    if (!disputes.length) lines.push('_none_');
    for (const r of disputes) lines.push(`- ${r.gameId} ${r.period} ${r.clock}: "${r.text}"`, `  - script ${r.deterministic.awardClass} (votes ${JSON.stringify(r.deterministic.votes)}); Qwen ${r.qwen.awardClass} (${r.qwen.confidence})`, `  - Qwen: ${(r.qwen.reasoning || '').slice(0, 300)}`);
    // 4. ambiguous
    const amb = recs.filter(r => r.deterministic.awardClass === 'AMBIGUOUS');
    lines.push('', '## Plays the rules could not decide (AMBIGUOUS) - Qwen\'s answer', '');
    if (!amb.length) lines.push('_none_');
    for (const r of amb) lines.push(`- ${r.gameId} ${r.period} ${r.clock}: "${r.text}"`, `  - DB credit ${JSON.stringify(r.dbCredit)}; Qwen ${r.qwen ? `${r.qwen.awardClass} (${r.qwen.confidence})` : 'no vote'}`, r.qwen && r.qwen.reasoning ? `  - Qwen: ${r.qwen.reasoning.slice(0, 300)}` : '');
    // 5. latency / errors
    const lat = voted.map(r => r.qwen.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
    const errs = recs.filter(r => !r.qwen);
    lines.push('', '## Latency and rejected answers', '', `- votes: ${lat.length}; latency ms min ${lat[0] ?? '-'} / median ${lat[Math.floor(lat.length / 2)] ?? '-'} / p90 ${lat[Math.floor(lat.length * 0.9)] ?? '-'} / max ${lat[lat.length - 1] ?? '-'}`, `- rejected or unreachable: ${errs.length}${errs.length ? ` (${[...new Set(errs.map(r => (r.qwenError || '').slice(0, 80)))].join(' | ')})` : ''}`);
    const conf = {}; for (const r of voted) conf[r.qwen.confidence || '?'] = (conf[r.qwen.confidence || '?'] || 0) + 1;
    lines.push(`- confidence: ${JSON.stringify(conf)}`);
    return lines.filter(l => l !== undefined).join('\n') + '\n';
}

async function main() {
    const weeks = argValue('--weeks') ? argValue('--weeks').split(',').map(Number) : cachedWeeks();
    if (!weeks.length) { console.error(`no cached ESPN weeks for ${season} under ${ESPN_ROOT}`); process.exit(2); }
    if (!reportOnly && !dry && !qwen.isConfigured()) { console.error('QWEN_BASE_URL / QWEN_MODEL not configured'); process.exit(2); }
    let results = readJson(RESULTS);
    if (!reportOnly) {
        const r = await collect(weeks);
        results = r.results;
        log(`${dry ? 'dry run: ' : ''}${r.planned} plays in weeks ${weeks.join(',')}; asked ${r.asked}, already done ${r.skipped}${r.stopped ? ' (stopped: Qwen unreachable)' : ''}`);
        if (dry) return;
    }
    if (!results) { console.error('no results yet'); process.exit(1); }
    const md = buildReport(results);
    fs.writeFileSync(REPORT, md);
    console.log(md);
    log(`report: ${REPORT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
