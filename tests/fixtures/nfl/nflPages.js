/**
 * Fixture builders for NFL.com pages, modeled on the live markup observed on
 * 2026-09-25 (injury report, team roster, reserve-list transactions) and
 * re-checked 2026-10-01 (roster Status codes seen live: ACT, DEV, RES, RSR,
 * PUP, RSN, EXE, TRC, TRD, CUT, RLS). Each builder returns a complete HTML
 * document so the service's transport and identity checks run exactly as in
 * production.
 */

function wrap(title, body) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body class="nfl-is-league-site"><main id="main-content">${body}</main></body></html>`;
}

const IMG = '<picture><source media="(min-width:1024px)"><img class="img-responsive" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="></picture>';

/**
 * Injury report. teams: [{ nickname: 'Texans', rows: [{ name, slug, pos, injuries, practice, game }] }]
 * options.selectedPath overrides the selected <option> (page identity);
 * options.title overrides the <title>.
 */
function injuryReport({ season = 2026, week = 3, teams = [], selectedPath = null, title = null } = {}) {
    const path = selectedPath || `/injuries/league/${season}/reg${week}`;
    const t = title || `Official NFL Injury Report for Players - Week ${week} of the ${season} Season | NFL.com`;
    const selects = `<div class="nfl-o-filter"><select><option value="/injuries/league/${season - 1}/reg1">${season - 1}</option><option value="${path}" selected>${season}</option></select><select><option value="/injuries/league/${season}/reg1">WEEK 1</option><option value="${path}" selected>WEEK ${week}</option></select></div>`;
    const blocks = teams.map(team => {
        const rows = team.rows.map(r =>
            `<tr><td scope="row" tabindex="0"><a href="/players/${r.slug || r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/" class="nfl-o-cta--link" aria-label="Visit ${r.name}"> ${r.name} </a></td><td>${r.pos || 'WR'}</td><td>${r.injuries || ''}</td><td>${r.practice || ''}</td><td>${r.game === undefined ? '' : r.game}</td></tr>`
        ).join('');
        return `<div class="nfl-t-stats__title"><div class="nfl-u-hide-empty"></div><div class="d3-o-section-sub-title"><span>${team.nickname}</span></div></div><div class="d3-o-table--horizontal-scroll"><table class="d3-o-table d3-o-table--detailed d3-o-reports--detailed"><thead><tr><th>Player</th><th>Position</th><th>Injuries</th><th>Practice Status</th><th>Game Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join('');
    return wrap(t, `<h1 class="nfl-o-page-title nfl-o-page-title--visuallyhidden">${t}</h1><h1 class="nfl-c-content-header__title">${season} NFL Injury Report</h1>${selects}${blocks}`);
}

/**
 * Team roster. players: [{ name, slug, no, pos, status }]
 */
function teamRoster({ teamName = 'Baltimore Ravens', season = 2026, players = [], title = null } = {}) {
    const t = title || `${teamName} ${season} Player Roster | NFL.com`;
    const rows = players.map(p =>
        `<tr><td class="sorter-lastname" scope="row"><div class="d3-o-media-object"><figure class="d3-o-media-object__figure">${IMG}</figure><a class="nfl-o-roster__player-name nfl-o-cta--link" href="/players/${p.slug}/">${p.name}</a></div></td><td>${p.no || ''}</td><td>${p.pos || 'WR'}</td><td>${p.status}</td><td class="sorter-height">72</td><td>200</td><td>2</td><td>Somewhere State</td></tr>`
    ).join('');
    return wrap(t, `<h1 class="nfl-o-page-title nfl-o-page-title--visuallyhidden">${t}</h1><div class="d3-o-table--horizontal-scroll"><table class="d3-o-table d3-o-table--detailed d3-o-table--sortable"><thead><tr><th>Player</th><th>No</th><th>Pos</th><th>Status</th><th>Height</th><th>Weight</th><th>Experience</th><th>College</th></tr></thead><tbody>${rows}</tbody></table></div>`);
}

/**
 * Reserve-list transactions page. rows: [{ teamSlug, teamNick, date, name, slug, pos, transaction }]
 * nextAfter: cursor for the ?after= continuation link (null = last page).
 */
function reserveList({ year = 2026, month = 9, rows = [], nextAfter = null, title = null } = {}) {
    const t = title || `${year} NFL reserve-list by month | NFL.com`;
    const club = r => `<a class="d3-o-club-info" href="/teams/${r.teamSlug}/"><div class="d3-o-club-logo">${IMG}</div><div class="d3-o-club-fullname">${r.teamNick}</div><div class="d3-o-club-shortname">${r.teamNick}</div></a>`;
    const trs = rows.map(r =>
        `<tr><td>${club(r)}</td><td>${club(r)}</td><td>${r.date}</td><td><a href="/players/${r.slug}/" class="nfl-o-cta nfl-o-cta--link">${r.name}</a></td><td>${r.pos || ''}</td><td>${r.transaction}</td></tr>`
    ).join('');
    const next = nextAfter
        ? `<div class="nfl-o-table-pagination"><a class="nfl-o-table-pagination__next" href="/transactions/league/reserve-list/${year}/${month}?after=${nextAfter}">Next</a></div>`
        : '';
    return wrap(t, `<h1 class="nfl-o-page-title nfl-o-page-title--visuallyhidden">${t}</h1><h1 class="nfl-c-content-header__title">${year} NFL Transactions</h1><div class="d3-o-table--horizontal-scroll"><table class="d3-o-table d3-o-table--detailed"><thead><tr><th>From</th><th>To</th><th scope="col">Date</th><th scope="col">Name</th><th scope="col">Position</th><th scope="col">Transaction</th></tr></thead><tbody>${trs}</tbody></table></div>${next}`);
}

module.exports = { injuryReport, teamRoster, reserveList, wrap };
