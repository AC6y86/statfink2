/**
 * Delta Manager - Shared logic for managing 30-second score deltas
 * Used by both production (statfink.html) and test (delta-test.html) pages
 */

var DeltaManager = (function() {
    // Global delta storage - persists across matchup navigation
    var globalDeltas = {
        players: {}, // playerId -> {delta: value, timestamp: time, changedStats: []}
        teams: {}    // "matchupId_team1/2" -> {delta: value, timestamp: time}
    };
    
    // Cleanup interval reference
    var cleanupInterval = null;
    
    // Constants
    var EXPIRY_TIME = 30000; // 30 seconds
    
    /**
     * Initialize the delta manager - starts the cleanup interval
     */
    function init() {
        // Start cleanup timer to remove expired indicators (runs every second)
        if (cleanupInterval) clearInterval(cleanupInterval);
        cleanupInterval = setInterval(cleanupExpiredIndicators, 1000);
        console.log('DeltaManager initialized - cleanup interval started');
    }
    
    /**
     * Stop the delta manager - clears the cleanup interval
     */
    function stop() {
        if (cleanupInterval) {
            clearInterval(cleanupInterval);
            cleanupInterval = null;
        }
    }
    
    /**
     * Add or update a player delta
     * @param {string} playerId - The player ID
     * @param {number} delta - The score delta
     * @param {array} changedStats - Array of stat names that changed
     */
    function addPlayerDelta(playerId, delta, changedStats = []) {
        globalDeltas.players[playerId] = {
            delta: delta,
            timestamp: Date.now(),
            changedStats: changedStats
        };
    }
    
    /**
     * Add or update a team delta
     * @param {string} matchupId - The matchup ID
     * @param {string} team - Either "team1" or "team2"
     * @param {number} delta - The score delta
     */
    function addTeamDelta(matchupId, team, delta) {
        const key = `${matchupId}_${team}`;
        globalDeltas.teams[key] = {
            delta: delta,
            timestamp: Date.now()
        };
    }
    
    /**
     * Get a player delta if not expired
     * @param {string} playerId - The player ID
     * @returns {object|null} - Delta object or null if expired/not found
     */
    function getPlayerDelta(playerId) {
        const delta = globalDeltas.players[playerId];
        if (delta && (Date.now() - delta.timestamp <= EXPIRY_TIME)) {
            return delta;
        }
        return null;
    }
    
    /**
     * Get a team delta if not expired
     * @param {string} matchupId - The matchup ID
     * @param {string} team - Either "team1" or "team2"
     * @returns {object|null} - Delta object or null if expired/not found
     */
    function getTeamDelta(matchupId, team) {
        const key = `${matchupId}_${team}`;
        const delta = globalDeltas.teams[key];
        if (delta && (Date.now() - delta.timestamp <= EXPIRY_TIME)) {
            return delta;
        }
        return null;
    }
    
    /**
     * Get all active (non-expired) deltas
     * @returns {object} - Object with players and teams arrays
     */
    function getActiveDeltas() {
        const now = Date.now();
        const active = {
            players: [],
            teams: []
        };
        
        // Get active player deltas
        Object.keys(globalDeltas.players).forEach(playerId => {
            const delta = globalDeltas.players[playerId];
            if (delta && (now - delta.timestamp <= EXPIRY_TIME)) {
                active.players.push({
                    playerId: playerId,
                    ...delta,
                    remainingTime: Math.ceil((EXPIRY_TIME - (now - delta.timestamp)) / 1000)
                });
            }
        });
        
        // Get active team deltas
        Object.keys(globalDeltas.teams).forEach(key => {
            const delta = globalDeltas.teams[key];
            if (delta && (now - delta.timestamp <= EXPIRY_TIME)) {
                const [matchupId, team] = key.split('_');
                active.teams.push({
                    matchupId: matchupId,
                    team: team,
                    ...delta,
                    remainingTime: Math.ceil((EXPIRY_TIME - (now - delta.timestamp)) / 1000)
                });
            }
        });
        
        return active;
    }
    
    /**
     * Clean up expired indicators - called every second by interval
     * This is the exact logic from production
     */
    function cleanupExpiredIndicators() {
        const now = Date.now();
        
        // Clean up expired team score deltas in the left panel
        Object.keys(globalDeltas.teams).forEach(key => {
            const delta = globalDeltas.teams[key];
            if (delta && (now - delta.timestamp > EXPIRY_TIME)) {
                // Parse the key to get matchup ID and team
                const [matchupId, team] = key.split('_');
                
                // Find the row in the left panel
                const rows = document.querySelectorAll(`tr[data-matchup-id="${matchupId}"][data-team="${team}"]`);
                rows.forEach(row => {
                    const scoreCell = row.cells[1];
                    if (scoreCell) {
                        // Remove delta span and restore normal display
                        const deltaSpan = scoreCell.querySelector('.score-delta');
                        if (deltaSpan) {
                            // Extract the actual score from the cell
                            const scoreText = scoreCell.textContent.replace(/[+-]\d+\.\d+\s*/, '');
                            scoreCell.textContent = scoreText;
                            scoreCell.className = "fanpts";
                        }
                    }
                });
                
                // Remove from global deltas
                delete globalDeltas.teams[key];
            }
        });
        
        // Clean up expired player deltas in the matchup display
        Object.keys(globalDeltas.players).forEach(playerId => {
            const playerDelta = globalDeltas.players[playerId];
            if (playerDelta && (now - playerDelta.timestamp > EXPIRY_TIME)) {
                // Find player rows in both team tables
                ['team0', 'team1'].forEach(tableId => {
                    const table = document.getElementById(tableId);
                    if (table) {
                        const rows = table.getElementsByTagName('tr');
                        for (let row of rows) {
                            // Check if this row contains the player's score
                            const pointsCell = row.cells?.[4];
                            if (pointsCell && pointsCell.className.includes('fanpts')) {
                                const deltaSpan = pointsCell.querySelector('.score-delta');
                                if (deltaSpan) {
                                    // Extract the actual score and remove delta
                                    const scoreText = pointsCell.textContent.replace(/[+-]\d+\.\d+\s*/, '');
                                    pointsCell.textContent = scoreText;
                                    pointsCell.className = 'points fanpts';
                                }
                            }
                            
                            // Remove bold from stats in the stats row
                            const statsCell = row.querySelector('td[colspan="5"]');
                            if (statsCell) {
                                const boldSpans = statsCell.querySelectorAll('.stat-changed');
                                boldSpans.forEach(span => {
                                    // Replace the bold span with plain text
                                    const text = span.textContent;
                                    const textNode = document.createTextNode(text);
                                    span.parentNode.replaceChild(textNode, span);
                                });
                            }
                        }
                    }
                });
                
                // Remove from global deltas
                delete globalDeltas.players[playerId];
            }
        });
    }
    
    /**
     * Clear all deltas immediately
     */
    function clearAll() {
        globalDeltas.players = {};
        globalDeltas.teams = {};
    }
    
    /**
     * Get the raw globalDeltas object (for debugging)
     */
    function getRawDeltas() {
        return globalDeltas;
    }
    
    // Public API
    return {
        init: init,
        stop: stop,
        addPlayerDelta: addPlayerDelta,
        addTeamDelta: addTeamDelta,
        getPlayerDelta: getPlayerDelta,
        getTeamDelta: getTeamDelta,
        getActiveDeltas: getActiveDeltas,
        clearAll: clearAll,
        getRawDeltas: getRawDeltas,
        EXPIRY_TIME: EXPIRY_TIME
    };
})();