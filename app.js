const POSITION_MAP = {
  1: "GK",
  2: "DEF",
  3: "MID",
  4: "FWD",
};

const VALID_FORMATIONS = [
  { DEF: 3, MID: 4, FWD: 3 },
  { DEF: 3, MID: 5, FWD: 2 },
  { DEF: 4, MID: 4, FWD: 2 },
  { DEF: 4, MID: 3, FWD: 3 },
  { DEF: 4, MID: 5, FWD: 1 },
  { DEF: 5, MID: 3, FWD: 2 },
  { DEF: 5, MID: 4, FWD: 1 },
];

const analyseBtn = document.getElementById("analyseBtn");
const statusEl = document.getElementById("status");
const bestXiOutput = document.getElementById("bestXiOutput");
const benchOutput = document.getElementById("benchOutput");
const captainOutput = document.getElementById("captainOutput");
const transferOutput = document.getElementById("transferOutput");
const formationOutput = document.getElementById("formationOutput");

analyseBtn.addEventListener("click", analyseTeam);

async function analyseTeam() {
  clearOutputs();

  const teamId = document.getElementById("teamId").value.trim();
  const bank = Number(document.getElementById("bank").value || 0);
  const freeTransfers = Number(document.getElementById("freeTransfers").value || 1);

  if (!teamId) {
    setStatus("Please enter your FPL team ID.");
    return;
  }

  try {
    setStatus("Loading FPL data...");

    const bootstrap = await fetchJson("https://fantasy.premierleague.com/api/bootstrap-static/");

    const entry = await fetchJson(`https://fantasy.premierleague.com/api/entry/${teamId}/`);

    if (!entry || !entry.id) {
      throw new Error("Team not found");
    }

    const targetEventId = getBestEventId(bootstrap.events);

    const picksData = await fetchJson(
      `https://fantasy.premierleague.com/api/entry/${teamId}/event/${targetEventId}/picks/`
    );

    const squad = buildSquad(picksData.picks, bootstrap);

    const squadCheck = validateSquad(squad);
    if (!squadCheck.valid) {
      setStatus(`Squad validation failed: ${squadCheck.errors.join(" | ")}`);
      return;
    }

    scorePlayers(squad);

    const bestTeamResult = pickBestStartingXI(squad);
    renderPlayers(bestXiOutput, bestTeamResult.startingXI);
    formationOutput.textContent = `Recommended formation: ${bestTeamResult.formation}`;
    renderPlayers(benchOutput, bestTeamResult.bench);

    const captainData = pickCaptainAndVice(bestTeamResult.startingXI);
    renderCaptainSection(captainData);

    const transferIdeas = generateTransferIdeas({
      squad,
      allPlayers: bootstrap.elements,
      teams: bootstrap.teams,
      bank,
      freeTransfers
    });

    renderTransfers(transferIdeas);
    setStatus(`Done. Analysed team ID ${teamId} using Gameweek ${targetEventId}.`);
  } catch (error) {
    console.error(error);
    setStatus("Could not load your team. Check the team ID, then try again. If it still fails, the FPL API is likely being blocked in the browser.");
  }
}

function getBestEventId(events) {
  const current = events.find(e => e.is_current);
  if (current) return current.id;

  const next = events.find(e => e.is_next);
  if (next) return next.id;

  const latestFinished = [...events]
    .filter(e => e.finished)
    .sort((a, b) => b.id - a.id)[0];

  if (latestFinished) return latestFinished.id;

  return 1;
}

async function fetchJson(url) {
  const proxiedUrl = `https://corsproxy.io/?url=${encodeURIComponent(url)}`;
  const response = await fetch(proxiedUrl);

  if (!response.ok) {
    throw new Error(`Fetch failed: ${url}`);
  }

  return response.json();
}

function buildSquad(picks, bootstrap) {
  return picks.map(pick => {
    const player = bootstrap.elements.find(el => el.id === pick.element);
    const team = bootstrap.teams.find(t => t.id === player.team);
    const position = POSITION_MAP[player.element_type];

    return {
      id: player.id,
      name: `${player.first_name} ${player.second_name}`,
      teamId: player.team,
      teamName: team ? team.name : "Unknown",
      position,
      cost: player.now_cost / 10,
      form: Number(player.form || 0),
      totalPoints: player.total_points || 0,
      minutes: player.minutes || 0,
      pointsPerGame: Number(player.points_per_game || 0),
      selectedByPercent: Number(player.selected_by_percent || 0),
      ictIndex: Number(player.ict_index || 0),
      starts: player.starts || 0,
      goals: player.goals_scored || 0,
      assists: player.assists || 0,
      cleanSheets: player.clean_sheets || 0,
      expectedPoints: 0
    };
  });
}

function validateSquad(squad) {
  const errors = [];

  if (squad.length !== 15) {
    errors.push("Squad must contain 15 players.");
  }

  const counts = countByPosition(squad);
  if (counts.GK !== 2) errors.push("Squad must contain 2 goalkeepers.");
  if (counts.DEF !== 5) errors.push("Squad must contain 5 defenders.");
  if (counts.MID !== 5) errors.push("Squad must contain 5 midfielders.");
  if (counts.FWD !== 3) errors.push("Squad must contain 3 forwards.");

  const teamCounts = {};
  squad.forEach(player => {
    teamCounts[player.teamId] = (teamCounts[player.teamId] || 0) + 1;
  });

  Object.values(teamCounts).forEach(count => {
    if (count > 3) {
      errors.push("Squad has more than 3 players from one club.");
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

function countByPosition(players) {
  return players.reduce((acc, player) => {
    acc[player.position] = (acc[player.position] || 0) + 1;
    return acc;
  }, { GK: 0, DEF: 0, MID: 0, FWD: 0 });
}

function scorePlayers(squad) {
  squad.forEach(player => {
    const minutesReliability = Math.min(player.minutes / 2700, 1);
    const attackingScore = (player.goals * 4) + (player.assists * 3);
    const cleanSheetScore = player.position === "GK" || player.position === "DEF" ? player.cleanSheets * 2 : 0;

    player.expectedPoints =
      (player.form * 0.35) +
      (player.pointsPerGame * 0.20) +
      (minutesReliability * 2.0) +
      (attackingScore * 0.08) +
      (cleanSheetScore * 0.05) +
      (player.ictIndex * 0.03);
  });
}

function pickBestStartingXI(squad) {
  const gk = squad.filter(p => p.position === "GK").sort((a, b) => b.expectedPoints - a.expectedPoints);
  const defs = squad.filter(p => p.position === "DEF").sort((a, b) => b.expectedPoints - a.expectedPoints);
  const mids = squad.filter(p => p.position === "MID").sort((a, b) => b.expectedPoints - a.expectedPoints);
  const fwds = squad.filter(p => p.position === "FWD").sort((a, b) => b.expectedPoints - a.expectedPoints);

  let bestResult = null;

  for (const formation of VALID_FORMATIONS) {
    const startingXI = [
      gk[0],
      ...defs.slice(0, formation.DEF),
      ...mids.slice(0, formation.MID),
      ...fwds.slice(0, formation.FWD),
    ];

    if (startingXI.length !== 11) continue;

    const total = startingXI.reduce((sum, p) => sum + p.expectedPoints, 0);

    if (!bestResult || total > bestResult.totalExpected) {
      const usedIds = new Set(startingXI.map(p => p.id));
      const bench = squad
        .filter(p => !usedIds.has(p.id))
        .sort((a, b) => {
          if (a.position === "GK" && b.position !== "GK") return 1;
          if (a.position !== "GK" && b.position === "GK") return -1;
          return b.expectedPoints - a.expectedPoints;
        });

      bestResult = {
        formation: `1-${formation.DEF}-${formation.MID}-${formation.FWD}`,
        startingXI,
        bench,
        totalExpected: total
      };
    }
  }

  return bestResult;
}

function pickCaptainAndVice(startingXI) {
  const sorted = [...startingXI].sort((a, b) => b.expectedPoints - a.expectedPoints);

  return {
    captain: sorted[0],
    viceCaptain: sorted[1]
  };
}

function generateTransferIdeas({ squad, allPlayers, teams, bank }) {
  const squadIds = new Set(squad.map(p => p.id));
  const teamCounts = {};

  squad.forEach(player => {
    teamCounts[player.teamId] = (teamCounts[player.teamId] || 0) + 1;
  });

  const allCandidates = allPlayers
    .filter(p => !squadIds.has(p.id))
    .map(p => {
      const team = teams.find(t => t.id === p.team);
      const position = POSITION_MAP[p.element_type];
      const minutesReliability = Math.min((p.minutes || 0) / 2700, 1);
      const predicted =
        (Number(p.form || 0) * 0.35) +
        (Number(p.points_per_game || 0) * 0.20) +
        (minutesReliability * 2.0) +
        ((p.goals_scored || 0) * 0.32) +
        ((p.assists || 0) * 0.24) +
        ((Number(p.ict_index || 0)) * 0.03);

      return {
        id: p.id,
        name: `${p.first_name} ${p.second_name}`,
        teamId: p.team,
        teamName: team ? team.name : "Unknown",
        position,
        cost: p.now_cost / 10,
        expectedPoints: predicted
      };
    })
    .sort((a, b) => b.expectedPoints - a.expectedPoints);

  const ideas = [];

  for (const currentPlayer of squad) {
    const samePositionTargets = allCandidates.filter(candidate => {
      if (candidate.position !== currentPlayer.position) return false;
      if (candidate.cost > currentPlayer.cost + bank) return false;

      const currentClubCount = teamCounts[candidate.teamId] || 0;
      const adjustedClubCount =
        candidate.teamId === currentPlayer.teamId ? currentClubCount : currentClubCount + 1;

      if (adjustedClubCount > 3) return false;

      return true;
    });

    for (const target of samePositionTargets.slice(0, 25)) {
      const gain = target.expectedPoints - currentPlayer.expectedPoints;

      if (gain > 0.5) {
        ideas.push({
          out: currentPlayer,
          in: target,
          gain
        });
      }
    }
  }

  return ideas.sort((a, b) => b.gain - a.gain).slice(0, 5);
}

function renderPlayers(container, players) {
  if (!players || players.length === 0) {
    container.innerHTML = `<p class="empty">No data available.</p>`;
    return;
  }

  container.innerHTML = `
    <div class="player-list">
      ${players.map(player => `
        <div class="player-item">
          <div class="player-top">
            <div class="player-name">${player.name}</div>
            <div>${player.expectedPoints.toFixed(2)} pts</div>
          </div>
          <div class="player-meta">
            ${player.position} • ${player.teamName} • £${player.cost.toFixed(1)}m
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderCaptainSection(data) {
  if (!data?.captain || !data?.viceCaptain) {
    captainOutput.innerHTML = `<p class="empty">No captain data available.</p>`;
    return;
  }

  captainOutput.innerHTML = `
    <div class="captain-box">
      <div><strong>Captain:</strong> ${data.captain.name} (${data.captain.expectedPoints.toFixed(2)} pts)</div>
      <div class="player-meta">${data.captain.position} • ${data.captain.teamName}</div>
    </div>
    <div class="captain-box" style="margin-top: 10px;">
      <div><strong>Vice-captain:</strong> ${data.viceCaptain.name} (${data.viceCaptain.expectedPoints.toFixed(2)} pts)</div>
      <div class="player-meta">${data.viceCaptain.position} • ${data.viceCaptain.teamName}</div>
    </div>
  `;
}

function renderTransfers(ideas) {
  if (!ideas || ideas.length === 0) {
    transferOutput.innerHTML = `<p class="empty">No strong transfer ideas found from the simple model yet.</p>`;
    return;
  }

  transferOutput.innerHTML = `
    <div class="transfer-list">
      ${ideas.map(item => `
        <div class="transfer-item">
          <div><strong>Out:</strong> ${item.out.name} (${item.out.teamName})</div>
          <div><strong>In:</strong> ${item.in.name} (${item.in.teamName})</div>
          <div class="player-meta">
            ${item.out.position} • Cost change: £${(item.in.cost - item.out.cost).toFixed(1)}m • Expected gain: ${item.gain.toFixed(2)} pts
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function clearOutputs() {
  bestXiOutput.innerHTML = "";
  benchOutput.innerHTML = "";
  captainOutput.innerHTML = "";
  transferOutput.innerHTML = "";
  formationOutput.textContent = "";
  statusEl.textContent = "";
}

function setStatus(message) {
  statusEl.textContent = message;
}
