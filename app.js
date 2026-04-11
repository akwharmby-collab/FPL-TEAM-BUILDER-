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
const bankInput = document.getElementById("bank");
const currentSquadOutput = document.getElementById("currentSquadOutput");
const summaryOutput = document.getElementById("summaryOutput");
const bestXiOutput = document.getElementById("bestXiOutput");
const benchOutput = document.getElementById("benchOutput");
const captainOutput = document.getElementById("captainOutput");
const transferOutput = document.getElementById("transferOutput");
const formationOutput = document.getElementById("formationOutput");

analyseBtn.addEventListener("click", analyseTeam);

async function analyseTeam() {
  clearOutputs();

  const teamId = document.getElementById("teamId").value.trim();
  const manualFreeTransfers = Math.min(
    5,
    Math.max(0, Number(document.getElementById("freeTransfers").value || 1))
  );

  if (!teamId) {
    setStatus("Please enter your FPL team ID.");
    return;
  }

  try {
    setStatus("Loading FPL data...");

    const [bootstrap, fixtures, entry, history] = await Promise.all([
      fetchJson("https://fantasy.premierleague.com/api/bootstrap-static/"),
      fetchJson("https://fantasy.premierleague.com/api/fixtures/"),
      fetchJson(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
      fetchJson(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`)
    ]);

    if (!entry || !entry.id) {
      throw new Error("Team not found");
    }

    const targetEventId = getTargetEventId(bootstrap.events);

    const picksData = await fetchJson(
      `https://fantasy.premierleague.com/api/entry/${teamId}/event/${targetEventId}/picks/`
    );

    const bankFromFpl = getBankValue(picksData, history, targetEventId);

    if (bankFromFpl !== null) {
      bankInput.value = bankFromFpl.toFixed(1);
    } else {
      bankInput.value = "";
    }

    const squad = buildSquad(picksData.picks, bootstrap);

    const squadCheck = validateSquad(squad);
    if (!squadCheck.valid) {
      setStatus(`Squad validation failed: ${squadCheck.errors.join(" | ")}`);
      return;
    }

    const horizonEventIds = getNextEventIds(bootstrap.events, targetEventId, 3);
    const fixtureMap = buildFixtureMap(fixtures, bootstrap.teams, horizonEventIds);

    scorePlayers(squad, fixtureMap);

    const sortedSquad = [...squad].sort((a, b) => {
      const order = { GK: 1, DEF: 2, MID: 3, FWD: 4 };
      if (order[a.position] !== order[b.position]) {
        return order[a.position] - order[b.position];
      }
      return b.expectedPoints - a.expectedPoints;
    });

    renderSummary({
      teamName: entry.name || "Your Team",
      managerName: entry.player_first_name && entry.player_last_name
        ? `${entry.player_first_name} ${entry.player_last_name}`
        : "Manager",
      bank: bankFromFpl,
      freeTransfers: manualFreeTransfers,
      gameweeks: horizonEventIds
    });

    renderPlayers(currentSquadOutput, sortedSquad);

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
      bank: bankFromFpl ?? Number(bankInput.value || 0),
      freeTransfers: manualFreeTransfers,
      fixtureMap
    });

    renderTransfers(transferIdeas);

    const bankMessage = bankFromFpl === null
      ? " Bank could not be read automatically, so enter it manually."
      : ` Bank auto-filled: £${bankFromFpl.toFixed(1)}m.`;

    setStatus(`Done. Analysed team ID ${teamId} across GWs ${horizonEventIds.join(", ")}.${bankMessage}`);
  } catch (error) {
    console.error(error);
    setStatus("Could not load your team. Check the team ID and try again.");
  }
}

function getTargetEventId(events) {
  const current = events.find(e => e.is_current);
  if (current) return current.id;

  const next = events.find(e => e.is_next);
  if (next) return next.id;

  const latestFinished = [...events]
    .filter(e => e.finished)
    .sort((a, b) => b.id - a.id)[0];

  if (latestFinished) return Math.min(latestFinished.id + 1, 38);

  return 1;
}

function getNextEventIds(events, startEventId, count) {
  const validIds = new Set(events.map(e => e.id));
  const ids = [];
  for (let i = startEventId; i <= 38 && ids.length < count; i++) {
    if (validIds.has(i)) ids.push(i);
  }
  return ids;
}

function getBankValue(picksData, history, targetEventId) {
  const picksBank = picksData?.entry_history?.bank;
  if (typeof picksBank === "number" && !Number.isNaN(picksBank)) {
    return picksBank / 10;
  }

  const current = history?.current;
  if (Array.isArray(current)) {
    const matchingGw = current.find(row => row.event === targetEventId);
    if (matchingGw && typeof matchingGw.bank === "number") {
      return matchingGw.bank / 10;
    }

    const latest = [...current].sort((a, b) => b.event - a.event)[0];
    if (latest && typeof latest.bank === "number") {
      return latest.bank / 10;
    }
  }

  return null;
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
      expectedGoals: Number(player.expected_goals || 0),
      expectedAssists: Number(player.expected_assists || 0),
      chanceOfPlaying: getChanceOfPlaying(player),
      fixtureDifficulty: 3,
      nextFixtureText: "No fixture found",
      nextFixturesText: "No fixtures found",
      horizonExpectedPoints: 0,
      expectedPoints: 0
    };
  });
}

function getChanceOfPlaying(player) {
  if (player.chance_of_playing_next_round === null || player.chance_of_playing_next_round === undefined) {
    return 100;
  }
  return Number(player.chance_of_playing_next_round);
}

function validateSquad(squad) {
  const errors = [];

  if (squad.length !== 15) errors.push("Squad must contain 15 players.");

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

  return { valid: errors.length === 0, errors };
}

function countByPosition(players) {
  return players.reduce((acc, player) => {
    acc[player.position] = (acc[player.position] || 0) + 1;
    return acc;
  }, { GK: 0, DEF: 0, MID: 0, FWD: 0 });
}

function buildFixtureMap(fixtures, teams, horizonEventIds) {
  const map = {};

  teams.forEach(team => {
    const matches = fixtures.filter(f =>
      horizonEventIds.includes(f.event) &&
      (f.team_h === team.id || f.team_a === team.id)
    );

    if (matches.length === 0) {
      map[team.id] = {
        difficulties: [3],
        texts: ["No fixture found"],
        avgDifficulty: 3,
        shortText: "No fixture found",
        fullText: "No fixture found"
      };
      return;
    }

    const texts = [];
    const difficulties = [];

    matches.forEach(match => {
      const isHome = match.team_h === team.id;
      const opponentId = isHome ? match.team_a : match.team_h;
      const opponent = teams.find(t => t.id === opponentId);
      const difficulty = isHome ? match.team_h_difficulty : match.team_a_difficulty;

      texts.push(`GW${match.event}: ${opponent ? opponent.name : "Unknown"} (${isHome ? "H" : "A"})`);
      difficulties.push(difficulty);
    });

    const avgDifficulty = difficulties.reduce((sum, d) => sum + d, 0) / difficulties.length;

    map[team.id] = {
      difficulties,
      texts,
      avgDifficulty,
      shortText: texts[0],
      fullText: texts.join(" | ")
    };
  });

  return map;
}

function scorePlayers(squad, fixtureMap) {
  squad.forEach(player => {
    const fixture = fixtureMap[player.teamId] || {
      avgDifficulty: 3,
      shortText: "No fixture found",
      fullText: "No fixtures found",
      difficulties: [3]
    };

    player.fixtureDifficulty = Number(fixture.avgDifficulty.toFixed(1));
    player.nextFixtureText = fixture.shortText;
    player.nextFixturesText = fixture.fullText;

    const minutesReliability = Math.min(player.minutes / 2700, 1);
    const availabilityFactor = player.chanceOfPlaying / 100;
    const fixtureMultiplier = difficultyMultiplier(fixture.avgDifficulty);

    let roleBonus = 0;
    if (player.position === "GK") {
      roleBonus = player.cleanSheets * 0.20;
    } else if (player.position === "DEF") {
      roleBonus = (player.cleanSheets * 0.22) + (player.expectedGoals * 0.30);
    } else if (player.position === "MID") {
      roleBonus = (player.expectedGoals * 1.10) + (player.expectedAssists * 0.90);
    } else if (player.position === "FWD") {
      roleBonus = (player.expectedGoals * 1.20) + (player.expectedAssists * 0.70);
    }

    const baseScore =
      (player.form * 0.32) +
      (player.pointsPerGame * 0.20) +
      (minutesReliability * 2.2) +
      (player.ictIndex * 0.035) +
      roleBonus;

    player.horizonExpectedPoints = baseScore * fixtureMultiplier * availabilityFactor;
    player.expectedPoints = player.horizonExpectedPoints;
  });
}

function difficultyMultiplier(difficulty) {
  if (difficulty <= 1.5) return 1.22;
  if (difficulty <= 2.5) return 1.12;
  if (difficulty <= 3.5) return 1.00;
  if (difficulty <= 4.5) return 0.90;
  return 0.78;
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
  const sorted = [...startingXI].sort((a, b) => captainScore(b) - captainScore(a));
  return {
    captain: sorted[0],
    viceCaptain: sorted[1]
  };
}

function captainScore(player) {
  let multiplier = 1;
  if (player.position === "MID") multiplier += 0.08;
  if (player.position === "FWD") multiplier += 0.10;
  if (player.chanceOfPlaying < 100) multiplier -= 0.15;
  if (player.fixtureDifficulty <= 2.5) multiplier += 0.08;
  if (player.fixtureDifficulty >= 4) multiplier -= 0.08;
  return player.expectedPoints * multiplier;
}

function buildCandidatePool({ squad, allPlayers, teams, fixtureMap }) {
  const squadIds = new Set(squad.map(p => p.id));

  return allPlayers
    .filter(p => !squadIds.has(p.id))
    .map(p => {
      const team = teams.find(t => t.id === p.team);
      const position = POSITION_MAP[p.element_type];
      const fixture = fixtureMap[p.team] || {
        avgDifficulty: 3,
        shortText: "No fixture found",
        fullText: "No fixtures found"
      };

      const minutesReliability = Math.min((p.minutes || 0) / 2700, 1);
      const availabilityFactor = (
        p.chance_of_playing_next_round === null || p.chance_of_playing_next_round === undefined
          ? 1
          : Number(p.chance_of_playing_next_round) / 100
      );
      const fixtureMultiplier = difficultyMultiplier(fixture.avgDifficulty);

      let roleBonus = 0;
      if (position === "GK") {
        roleBonus = (p.clean_sheets || 0) * 0.20;
      } else if (position === "DEF") {
        roleBonus = ((p.clean_sheets || 0) * 0.22) + (Number(p.expected_goals || 0) * 0.30);
      } else if (position === "MID") {
        roleBonus = (Number(p.expected_goals || 0) * 1.10) + (Number(p.expected_assists || 0) * 0.90);
      } else if (position === "FWD") {
        roleBonus = (Number(p.expected_goals || 0) * 1.20) + (Number(p.expected_assists || 0) * 0.70);
      }

      const predicted =
        (
          (Number(p.form || 0) * 0.32) +
          (Number(p.points_per_game || 0) * 0.20) +
          (minutesReliability * 2.2) +
          (Number(p.ict_index || 0) * 0.035) +
          roleBonus
        ) * fixtureMultiplier * availabilityFactor;

      return {
        id: p.id,
        name: `${p.first_name} ${p.second_name}`,
        teamId: p.team,
        teamName: team ? team.name : "Unknown",
        position,
        cost: p.now_cost / 10,
        expectedPoints: predicted,
        nextFixtureText: fixture.shortText,
        nextFixturesText: fixture.fullText,
        fixtureDifficulty: Number(fixture.avgDifficulty.toFixed(1))
      };
    })
    .sort((a, b) => b.expectedPoints - a.expectedPoints);
}

function generateTransferIdeas({ squad, allPlayers, teams, bank, freeTransfers, fixtureMap }) {
  const candidatePool = buildCandidatePool({ squad, allPlayers, teams, fixtureMap });

  const singleIdeas = generateSingleTransferIdeas({
    squad,
    candidatePool,
    bank,
    freeTransfers
  });

  const comboIdeas = generateDoubleTransferIdeas({
    squad,
    candidatePool,
    bank,
    freeTransfers
  });

  return [...singleIdeas, ...comboIdeas]
    .sort((a, b) => b.netGain - a.netGain)
    .slice(0, 8);
}

function generateSingleTransferIdeas({ squad, candidatePool, bank, freeTransfers }) {
  const teamCounts = getTeamCounts(squad);
  const ideas = [];

  for (const currentPlayer of squad) {
    const samePositionTargets = candidatePool.filter(candidate => {
      if (candidate.position !== currentPlayer.position) return false;
      if (candidate.cost > currentPlayer.cost + bank) return false;

      const currentClubCount = teamCounts[candidate.teamId] || 0;
      const adjustedClubCount =
        candidate.teamId === currentPlayer.teamId ? currentClubCount : currentClubCount + 1;

      return adjustedClubCount <= 3;
    });

    for (const target of samePositionTargets.slice(0, 20)) {
      const gain = target.expectedPoints - currentPlayer.expectedPoints;
      const transferCost = freeTransfers >= 1 ? 0 : 4;
      const netGain = gain - transferCost;

      if (netGain > 0.3) {
        ideas.push({
          type: "Single transfer",
          moves: [{ out: currentPlayer, in: target }],
          gain,
          netGain
        });
      }
    }
  }

  return ideas;
}

function generateDoubleTransferIdeas({ squad, candidatePool, bank, freeTransfers }) {
  const ideas = [];
  const indexedByPosition = {
    GK: candidatePool.filter(p => p.position === "GK").slice(0, 12),
    DEF: candidatePool.filter(p => p.position === "DEF").slice(0, 20),
    MID: candidatePool.filter(p => p.position === "MID").slice(0, 20),
    FWD: candidatePool.filter(p => p.position === "FWD").slice(0, 15),
  };

  for (let i = 0; i < squad.length; i++) {
    for (let j = i + 1; j < squad.length; j++) {
      const out1 = squad[i];
      const out2 = squad[j];

      const pool1 = indexedByPosition[out1.position];
      const pool2 = indexedByPosition[out2.position];

      for (const in1 of pool1) {
        if (in1.id === out1.id || in1.id === out2.id) continue;

        for (const in2 of pool2) {
          if (in2.id === in1.id) continue;
          if (in2.id === out1.id || in2.id === out2.id) continue;

          const totalOutCost = out1.cost + out2.cost;
          const totalInCost = in1.cost + in2.cost;

          if (totalInCost > totalOutCost + bank) continue;

          const newSquad = squad
            .filter(p => p.id !== out1.id && p.id !== out2.id)
            .concat([in1, in2]);

          const squadCheck = validateSquad(newSquad);
          if (!squadCheck.valid) continue;

          const gain =
            (in1.expectedPoints + in2.expectedPoints) -
            (out1.expectedPoints + out2.expectedPoints);

          const extraTransfers = Math.max(0, 2 - freeTransfers);
          const transferCost = extraTransfers * 4;
          const netGain = gain - transferCost;

          if (netGain > 0.5) {
            ideas.push({
              type: "Two-transfer combo",
              moves: [
                { out: out1, in: in1 },
                { out: out2, in: in2 }
              ],
              gain,
              netGain
            });
          }
        }
      }
    }
  }

  return dedupeComboIdeas(ideas).slice(0, 30);
}

function getTeamCounts(squad) {
  const counts = {};
  squad.forEach(player => {
    counts[player.teamId] = (counts[player.teamId] || 0) + 1;
  });
  return counts;
}

function dedupeComboIdeas(ideas) {
  const seen = new Set();
  const deduped = [];

  for (const idea of ideas.sort((a, b) => b.netGain - a.netGain)) {
    const key = idea.moves
      .map(move => `${move.out.id}->${move.in.id}`)
      .sort()
      .join("|");

    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(idea);
    }
  }

  return deduped;
}

function renderSummary(summary) {
  const bankText = summary.bank === null
    ? "Unavailable from public data"
    : `£${summary.bank.toFixed(1)}m`;

  summaryOutput.innerHTML = `
    <div class="summary-list">
      <div class="summary-box">
        <div class="summary-top">
          <strong>${summary.teamName}</strong>
          <span class="badge">GWs ${summary.gameweeks.join(", ")}</span>
        </div>
        <div class="player-meta">Manager: ${summary.managerName}</div>
        <div class="player-meta">Bank: ${bankText}</div>
        <div class="player-meta">Free Transfers: ${summary.freeTransfers}</div>
      </div>
    </div>
  `;
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
          <div class="player-meta">
            Fixtures: ${player.nextFixturesText} • Avg difficulty: ${player.fixtureDifficulty}
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
      <div class="player-meta">${data.captain.position} • ${data.captain.teamName} • ${data.captain.nextFixturesText}</div>
    </div>
    <div class="captain-box" style="margin-top: 10px;">
      <div><strong>Vice-captain:</strong> ${data.viceCaptain.name} (${data.viceCaptain.expectedPoints.toFixed(2)} pts)</div>
      <div class="player-meta">${data.viceCaptain.position} • ${data.viceCaptain.teamName} • ${data.viceCaptain.nextFixturesText}</div>
    </div>
  `;
}

function renderTransfers(ideas) {
  if (!ideas || ideas.length === 0) {
    transferOutput.innerHTML = `<p class="empty">No strong transfer ideas found yet.</p>`;
    return;
  }

  transferOutput.innerHTML = `
    <div class="transfer-list">
      ${ideas.map(item => `
        <div class="transfer-item">
          <div class="transfer-title">${item.type}</div>
          ${item.moves.map(move => `
            <div><strong>Out:</strong> ${move.out.name} (${move.out.teamName})</div>
            <div><strong>In:</strong> ${move.in.name} (${move.in.teamName})</div>
            <div class="player-meta">
              ${move.out.position} • Cost change: £${(move.in.cost - move.out.cost).toFixed(1)}m
            </div>
            <div class="player-meta">
              In fixtures: ${move.in.nextFixturesText}
            </div>
            <div style="height:8px;"></div>
          `).join("")}
          <div class="player-meta">
            Gross gain: ${item.gain.toFixed(2)} pts • Net gain: ${item.netGain.toFixed(2)} pts
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function clearOutputs() {
  summaryOutput.innerHTML = "";
  currentSquadOutput.innerHTML = "";
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
