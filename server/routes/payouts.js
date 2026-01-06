const express = require('express');
const { asyncHandler, APIError, logError } = require('../utils/errorHandler');

const router = express.Router();

// Constants from PFL Rules (12-team league)
const WEEKLY_WIN_AMOUNT_STANDARD = 37.78;  // Weeks 1-16
const WEEKLY_WIN_AMOUNT_REDUCED = 37.76;   // Weeks 17-18 (to make total exactly $680)
const OVERALL_POINTS_PRIZES = { 1: 500, 2: 300, 3: 200, 4: 150, 5: 100, 6: 70 };  // $1,320 total
const HEAD_TO_HEAD_PRIZES = { 1: 400, 2: 300, 3: 200, 4: 100 };    // $1,000 total
const IR_POOL_PERCENTAGES = {
    points_1st: 0.25,
    points_2nd: 0.15,
    points_3rd: 0.10,
    h2h_1st: 0.25,
    h2h_2nd: 0.15,
    h2h_3rd: 0.10
};
const IR_MOVE_FEE = 10;
const BUY_IN = 250;
const NUM_OWNERS = 12;

// Get payouts for a season
router.get('/:season', asyncHandler(async (req, res) => {
    const { season } = req.params;
    const seasonNum = parseInt(season);

    // Validate parameters
    if (isNaN(seasonNum) || seasonNum < 2020 || seasonNum > 2030) {
        throw new APIError('Invalid season. Must be between 2020 and 2030.', 400);
    }

    const db = req.app.locals.db;

    try {
        // 1. Get all teams
        const teams = await new Promise((resolve, reject) => {
            db.db.all('SELECT team_id, team_name, owner_name FROM teams ORDER BY team_id', [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Create team lookup map
        const teamMap = {};
        teams.forEach(t => {
            teamMap[t.team_id] = t;
            // Also map by owner name for easy lookup
            teamMap[t.owner_name] = t;
        });

        // 2. Get IR move count (only 'ir' and 'ir_return', NOT supplemental)
        const irMoves = await new Promise((resolve, reject) => {
            db.db.all(`
                SELECT team_id, COUNT(*) as move_count
                FROM roster_moves
                WHERE season = ? AND move_type IN ('ir', 'ir_return')
                GROUP BY team_id
            `, [seasonNum], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        const totalIRMoves = irMoves.reduce((sum, m) => sum + m.move_count, 0);
        const irPool = totalIRMoves * IR_MOVE_FEE;

        // 3. Get weekly winners (weeks 1-17 from database)
        const weeklyWinners = await new Promise((resolve, reject) => {
            db.db.all(`
                SELECT ws.week, ws.team_id, t.owner_name, ws.points_for_week
                FROM weekly_standings ws
                JOIN teams t ON ws.team_id = t.team_id
                WHERE ws.season = ? AND ws.weekly_rank = 1 AND ws.week <= 17
                ORDER BY ws.week
            `, [seasonNum], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // Count weekly wins per owner
        const weeklyWinCounts = {};
        weeklyWinners.forEach(w => {
            weeklyWinCounts[w.owner_name] = (weeklyWinCounts[w.owner_name] || 0) + 1;
        });

        // Add week 18 winner (Cal - hardcoded per user)
        const week18Winner = 'Cal';
        weeklyWinCounts[week18Winner] = (weeklyWinCounts[week18Winner] || 0) + 1;

        // Add week 18 to the list
        const allWeeklyWinners = [
            ...weeklyWinners,
            { week: 18, owner_name: week18Winner, points_for_week: 108.5 }
        ];

        // 4. Get cumulative points standings at week 17
        const pointsStandings = await new Promise((resolve, reject) => {
            db.db.all(`
                SELECT DISTINCT ws.team_id, t.owner_name, ws.cumulative_points
                FROM weekly_standings ws
                JOIN teams t ON ws.team_id = t.team_id
                WHERE ws.season = ? AND ws.week = 17
                ORDER BY ws.cumulative_points DESC
            `, [seasonNum], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        // 5. Head to Head standings (hardcoded per user input)
        const h2hStandings = [
            { rank: 1, owner_name: 'Matt', team_id: 12 },
            { rank: 2, owner_name: 'Chris', team_id: 1 },
            { rank: 3, owner_name: 'Bruce', team_id: 8 },
            { rank: 4, owner_name: 'Dan', team_id: 3 }
        ];

        // 6. Calculate all payouts
        const payouts = {};
        teams.forEach(t => {
            payouts[t.owner_name] = {
                team_id: t.team_id,
                owner_name: t.owner_name,
                weekly_wins: 0,
                weekly_payout: 0,
                points_rank: null,
                points_payout: 0,
                h2h_rank: null,
                h2h_payout: 0,
                ir_pool_points_payout: 0,
                ir_pool_h2h_payout: 0,
                total: 0
            };
        });

        // Weekly wins payouts (variable amounts: $37.78 for weeks 1-16, $37.76 for weeks 17-18)
        allWeeklyWinners.forEach(w => {
            if (payouts[w.owner_name]) {
                const amount = w.week <= 16 ? WEEKLY_WIN_AMOUNT_STANDARD : WEEKLY_WIN_AMOUNT_REDUCED;
                payouts[w.owner_name].weekly_wins = (payouts[w.owner_name].weekly_wins || 0) + 1;
                payouts[w.owner_name].weekly_payout += amount;
            }
        });

        // Overall points payouts (top 6)
        pointsStandings.slice(0, 6).forEach((team, index) => {
            const rank = index + 1;
            if (payouts[team.owner_name]) {
                payouts[team.owner_name].points_rank = rank;
                payouts[team.owner_name].points_payout = OVERALL_POINTS_PRIZES[rank] || 0;
            }
        });

        // Head to head payouts (top 4)
        h2hStandings.slice(0, 4).forEach(team => {
            if (payouts[team.owner_name]) {
                payouts[team.owner_name].h2h_rank = team.rank;
                payouts[team.owner_name].h2h_payout = HEAD_TO_HEAD_PRIZES[team.rank] || 0;
            }
        });

        // IR Pool payouts
        // Points-based: 1st, 2nd, 3rd in cumulative points
        if (pointsStandings[0]) {
            payouts[pointsStandings[0].owner_name].ir_pool_points_payout = irPool * IR_POOL_PERCENTAGES.points_1st;
        }
        if (pointsStandings[1]) {
            payouts[pointsStandings[1].owner_name].ir_pool_points_payout = irPool * IR_POOL_PERCENTAGES.points_2nd;
        }
        if (pointsStandings[2]) {
            payouts[pointsStandings[2].owner_name].ir_pool_points_payout = irPool * IR_POOL_PERCENTAGES.points_3rd;
        }

        // H2H-based: 1st, 2nd, 3rd in head to head
        if (h2hStandings[0]) {
            payouts[h2hStandings[0].owner_name].ir_pool_h2h_payout = irPool * IR_POOL_PERCENTAGES.h2h_1st;
        }
        if (h2hStandings[1]) {
            payouts[h2hStandings[1].owner_name].ir_pool_h2h_payout = irPool * IR_POOL_PERCENTAGES.h2h_2nd;
        }
        if (h2hStandings[2]) {
            payouts[h2hStandings[2].owner_name].ir_pool_h2h_payout = irPool * IR_POOL_PERCENTAGES.h2h_3rd;
        }

        // Calculate totals
        Object.values(payouts).forEach(p => {
            p.total = p.weekly_payout + p.points_payout + p.h2h_payout +
                      p.ir_pool_points_payout + p.ir_pool_h2h_payout;
        });

        // Convert to array and sort by total descending
        const payoutsArray = Object.values(payouts)
            .filter(p => p.total > 0)
            .sort((a, b) => b.total - a.total);

        // Calculate totals for verification
        const totalWeeklyPayout = Object.values(payouts).reduce((sum, p) => sum + p.weekly_payout, 0);
        const totalPointsPayout = Object.values(payouts).reduce((sum, p) => sum + p.points_payout, 0);
        const totalH2HPayout = Object.values(payouts).reduce((sum, p) => sum + p.h2h_payout, 0);
        const totalIRPoolPayout = Object.values(payouts).reduce((sum, p) => sum + p.ir_pool_points_payout + p.ir_pool_h2h_payout, 0);
        const grandTotal = Object.values(payouts).reduce((sum, p) => sum + p.total, 0);

        res.json({
            success: true,
            season: seasonNum,
            data: {
                // Summary info
                summary: {
                    buyIn: BUY_IN,
                    numOwners: NUM_OWNERS,
                    totalBuyIn: BUY_IN * NUM_OWNERS,
                    weeklyWinAmountStandard: WEEKLY_WIN_AMOUNT_STANDARD,
                    weeklyWinAmountReduced: WEEKLY_WIN_AMOUNT_REDUCED,
                    totalIRMoves,
                    irPool,
                    totalWeeklyPayout,
                    totalPointsPayout,
                    totalH2HPayout,
                    totalIRPoolPayout,
                    grandTotal
                },
                // Prize structure rules
                rules: {
                    buyIn: BUY_IN,
                    numOwners: NUM_OWNERS,
                    totalBuyIn: BUY_IN * NUM_OWNERS,
                    irMoveFee: IR_MOVE_FEE,
                    weeklyWinAmountStandard: WEEKLY_WIN_AMOUNT_STANDARD,
                    weeklyWinAmountReduced: WEEKLY_WIN_AMOUNT_REDUCED,
                    pointsPrizes: OVERALL_POINTS_PRIZES,
                    h2hPrizes: HEAD_TO_HEAD_PRIZES,
                    irPoolPercentages: IR_POOL_PERCENTAGES
                },
                // Weekly winners breakdown
                weeklyWinners: allWeeklyWinners,
                weeklyWinCounts,
                // Points standings (top 6 for payout)
                pointsStandings: pointsStandings.slice(0, 6).map((t, i) => ({
                    rank: i + 1,
                    owner_name: t.owner_name,
                    cumulative_points: t.cumulative_points,
                    payout: OVERALL_POINTS_PRIZES[i + 1] || 0
                })),
                // H2H standings (top 4 for payout)
                h2hStandings: h2hStandings.slice(0, 4).map(t => ({
                    ...t,
                    payout: HEAD_TO_HEAD_PRIZES[t.rank] || 0
                })),
                // IR Pool breakdown
                irPoolBreakdown: {
                    points_1st: { owner: pointsStandings[0]?.owner_name, amount: irPool * IR_POOL_PERCENTAGES.points_1st },
                    points_2nd: { owner: pointsStandings[1]?.owner_name, amount: irPool * IR_POOL_PERCENTAGES.points_2nd },
                    points_3rd: { owner: pointsStandings[2]?.owner_name, amount: irPool * IR_POOL_PERCENTAGES.points_3rd },
                    h2h_1st: { owner: h2hStandings[0]?.owner_name, amount: irPool * IR_POOL_PERCENTAGES.h2h_1st },
                    h2h_2nd: { owner: h2hStandings[1]?.owner_name, amount: irPool * IR_POOL_PERCENTAGES.h2h_2nd },
                    h2h_3rd: { owner: h2hStandings[2]?.owner_name, amount: irPool * IR_POOL_PERCENTAGES.h2h_3rd }
                },
                // IR moves by team
                irMovesByTeam: irMoves.map(m => ({
                    owner_name: teamMap[m.team_id]?.owner_name,
                    move_count: m.move_count,
                    fees: m.move_count * IR_MOVE_FEE
                })),
                // Final payouts per person
                payouts: payoutsArray
            }
        });
    } catch (error) {
        logError('Error calculating payouts:', error);
        throw new APIError('Failed to calculate payouts', 500);
    }
}));

module.exports = router;
