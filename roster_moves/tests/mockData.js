// Mock data for testing
// Based on real data structure from the database

const mockPlayers = [
  // QBs
  { player_id: "11252", name: "Joe Flacco", position: "QB", team: "CLE" },
  { player_id: "justin_herbert_qb_lac", name: "Justin Herbert", position: "QB", team: "LAC" },
  { player_id: "josh_allen_qb_buf", name: "Josh Allen", position: "QB", team: "BUF" },
  { player_id: "lamar_jackson_qb_bal", name: "Lamar Jackson", position: "QB", team: "BAL" },
  { player_id: "mac_jones_qb_ne", name: "Mac Jones", position: "QB", team: "NE" },
  { player_id: "daniel_jones_qb_giants", name: "Daniel Jones", position: "QB", team: "Giants" },
  { player_id: "tommy_devito_qb_giants", name: "Tommy DeVito", position: "QB", team: "Giants" },
  { player_id: "russell_wilson_qb_den", name: "Russell Wilson", position: "QB", team: "DEN" },
  { player_id: "justin_fields_qb_chi", name: "Justin Fields", position: "QB", team: "CHI" },
  { player_id: "gardner_minshew_qb_raiders", name: "Gardner Minshew", position: "QB", team: "Raiders" },
  { player_id: "zach_wilson_qb_nyj", name: "Zach Wilson", position: "QB", team: "NYJ" },

  // RBs
  { player_id: "4240657", name: "Michael Carter", position: "RB", team: "ARI" },
  { player_id: "david_montgomery_rb_lions", name: "David Montgomery", position: "RB", team: "Lions" },
  { player_id: "kendre_miller_rb_no", name: "Kendre Miller", position: "RB", team: "NO" },
  { player_id: "gus_edwards_rb_chargers", name: "Gus Edwards", position: "RB", team: "Chargers" },
  { player_id: "ameer_abdullah_rb_raiders", name: "Ameer Abdullah", position: "RB", team: "Raiders" },
  { player_id: "isiah_pacheco_rb_chiefs", name: "Isiah Pacheco", position: "RB", team: "Chiefs" },
  { player_id: "brian_robinson_rb_commanders", name: "Brian Robinson", position: "RB", team: "Commanders" },
  { player_id: "bryan_robinson_rb_commanders", name: "Bryan Robinson", position: "RB", team: "Commanders" }, // Misspelling test
  { player_id: "raheem_mostert_rb_dolphins", name: "Raheem Mostert", position: "RB", team: "Dolphins" },
  { player_id: "blake_corum_rb_rams", name: "Blake Corum", position: "RB", team: "Rams" },
  { player_id: "christian_mccaffrey_rb_sf", name: "Christian McCaffrey", position: "RB", team: "SF" },
  { player_id: "austin_ekeler_rb_lac", name: "Austin Ekeler", position: "RB", team: "LAC" },
  { player_id: "tony_pollard_rb_dal", name: "Tony Pollard", position: "RB", team: "DAL" },
  { player_id: "breece_hall_rb_nyj", name: "Breece Hall", position: "RB", team: "NYJ" },
  { player_id: "jerome_ford_rb_cle", name: "Jerome Ford", position: "RB", team: "CLE" },

  // WRs  
  { player_id: "tank_dell_wr_texans", name: "Tank Dell", position: "WR", team: "Texans" },
  { player_id: "adam_thielen_wr_panthers", name: "Adam Thielen", position: "WR", team: "Panthers" },
  { player_id: "marvin_harrison_jr_wr_ari", name: "Marvin Harrison Jr", position: "WR", team: "ARI" },
  { player_id: "cedric_tillman_wr_browns", name: "Cedric Tillman", position: "WR", team: "Browns" },
  { player_id: "elijah_moore_wr_browns", name: "Elijah Moore", position: "WR", team: "Browns" },
  { player_id: "chris_olave_wr_no", name: "Chris Olave", position: "WR", team: "NO" },
  { player_id: "stefan_diggs_wr_buf", name: "Stefan Diggs", position: "WR", team: "BUF" },
  { player_id: "demarcus_robinson_wr_rams", name: "DeMarcus Robinson", position: "WR", team: "Rams" },
  { player_id: "ceedee_lamb_wr_dal", name: "CeeDee Lamb", position: "WR", team: "DAL" },
  { player_id: "cooper_kupp_wr_lar", name: "Cooper Kupp", position: "WR", team: "LAR" },
  { player_id: "curtis_samuel_wr_was", name: "Curtis Samuel", position: "WR", team: "WAS" },
  { player_id: "michael_thomas_wr_no", name: "Michael Thomas", position: "WR", team: "NO" },
  { player_id: "odell_beckham_wr_bal", name: "Odell Beckham Jr", position: "WR", team: "BAL" },
  { player_id: "obj_wr_bal", name: "OBJ", position: "WR", team: "BAL" }, // Nickname

  // TEs
  { player_id: "travis_kelce_te_kc", name: "Travis Kelce", position: "TE", team: "KC" },

  // Kickers
  { player_id: "harrison_butker_k_chiefs", name: "Harrison Butker", position: "K", team: "Chiefs" },
  { player_id: "spencer_shrader_k_chiefs", name: "Spencer Shrader", position: "K", team: "Chiefs" },
  { player_id: "austin_seibert_k_commanders", name: "Austin Seibert", position: "K", team: "Commanders" },
  { player_id: "jake_bates_k_lions", name: "Jake Bates", position: "K", team: "Lions" },

  // Defense/ST
  { player_id: "aaron_163.67_def", name: "Aaron", position: "DEF", team: "163.67" },
  { player_id: "chris_130.5_def", name: "Chris", position: "DEF", team: "130.5" },
  { player_id: "sf_dst", name: "49ers D", position: "DST", team: "SF" },
  { player_id: "sf_dst2", name: "San Francisco DST", position: "DST", team: "SF" },
  { player_id: "buf_dst", name: "Buffalo DST", position: "DST", team: "BUF" },
];

const mockOwners = [
  { team_id: 1, team_name: "Aaron's Team", owner_name: "Aaron" },
  { team_id: 2, team_name: "Bruce's Team", owner_name: "Bruce" },
  { team_id: 3, team_name: "Cal's Team", owner_name: "Cal" },
  { team_id: 4, team_name: "Chris's Team", owner_name: "Chris" },
  { team_id: 5, team_name: "Dan's Team", owner_name: "Dan" },
  { team_id: 6, team_name: "Joe's Team", owner_name: "Joe" },
  { team_id: 7, team_name: "Matt's Team", owner_name: "Matt" },
  { team_id: 8, team_name: "Mike's Team", owner_name: "Mike" },
  { team_id: 9, team_name: "Mitch's Team", owner_name: "Mitch" },
  { team_id: 10, team_name: "Pete's Team", owner_name: "Pete" },
  { team_id: 11, team_name: "Sean's Team", owner_name: "Sean" },
  { team_id: 12, team_name: "Eli's Team", owner_name: "Eli" }
];

// Helper function to create email content object matching the extractEmailContent format
function createEmailContent(from, subject, date, body, id = 'test-id') {
  return {
    id,
    from,
    subject,
    date,
    body
  };
}

module.exports = {
  mockPlayers,
  mockOwners,
  createEmailContent
};