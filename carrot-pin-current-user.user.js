// ==UserScript==
// @name         Carrot, But Userscript - Pin Current User
// @namespace    https://github.com/TianzeNie/carrot-pin-current-user
// @version      1.3.0-pinme.1
// @author       Yan233_ (original), TianzeNie (modifications)
// @description  Carrot rating predictions plus a pinned current-user row, including fallback reconstruction when the public standings API omits the logged-in contestant.
// @license      AGPL-3.0-or-later
// @homepageURL  https://github.com/TianzeNie/carrot-pin-current-user
// @supportURL   https://github.com/TianzeNie/carrot-pin-current-user/issues
// @downloadURL  https://raw.githubusercontent.com/TianzeNie/carrot-pin-current-user/main/carrot-pin-current-user.user.js
// @updateURL    https://raw.githubusercontent.com/TianzeNie/carrot-pin-current-user/main/carrot-pin-current-user.user.js
// @match        https://codeforces.com/contest/*/standings*
// @match        https://codeforces.com/gym/*/standings*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const PAGE_SIZE = 1e4;
  function shouldRebuildContestStandings(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : "";
    return message.includes("authenticated") || message.includes("cloudflare") || message.includes("human check") || message.includes("invalid json");
  }
  async function rebuildContestStandings(contestId, gym, knownContest) {
    const contestPromise = knownContest ? Promise.resolve(knownContest) : fetchContest(contestId, gym);
    const [contest, status, hacks] = await Promise.all([
      contestPromise,
      fetchContestSubmissions(contestId),
      contestPromise.then((contest2) => contest2.type === "CF" ? fetchApi("contest.hacks", { contestId }) : [])
    ]);
    const officialSubmissions = status.submissions.filter(
      (submission) => isOfficialSubmission(submission, contest.durationSeconds)
    );
    return {
      standings: buildContestStandings(contest, officialSubmissions, hacks),
      statusPages: status.pages,
      submissions: status.submissions.length,
      officialSubmissions: officialSubmissions.length,
      hacks: hacks.length
    };
  }
  function buildContestStandings(contest, submissions, hacks) {
    const rows = buildRows(submissions, contest);
    if (contest.type === "CF") {
      applyHackScores(hacks, rows);
    }
    rows.sort(compareRows);
    assignRanks$1(rows);
    return {
      contest,
      problems: getProblems(submissions),
      rows
    };
  }
  async function fetchContestSubmissions(contestId) {
    const submissions = [];
    let pages = 0;
    for (let from = 1; ; from += PAGE_SIZE) {
      const page = await fetchApi("contest.status", {
        contestId,
        from: String(from),
        count: String(PAGE_SIZE)
      });
      pages += 1;
      submissions.push(...page);
      if (page.length < PAGE_SIZE) {
        return { submissions, pages };
      }
    }
  }
  function isOfficialSubmission(submission, durationSeconds) {
    const { author, relativeTimeSeconds } = submission;
    return author?.participantType === "CONTESTANT" && author.ghost !== true && Number.isInteger(relativeTimeSeconds) && relativeTimeSeconds >= 0 && relativeTimeSeconds <= durationSeconds;
  }
  function getProblems(submissions) {
    const problems = new Map();
    for (const submission of submissions) {
      if (submission.problem?.index) {
        problems.set(submission.problem.index, submission.problem);
      }
    }
    return Array.from(problems.values()).sort((left, right) => left.index.localeCompare(right.index));
  }
  function buildRows(submissions, contest) {
    const submissionsByParty = new Map();
    const parties = new Map();
    for (const submission of submissions) {
      const { author } = submission;
      if (!author) {
        continue;
      }
      const key = getPartyKey(author);
      parties.set(key, author);
      const partySubmissions = submissionsByParty.get(key) ?? [];
      partySubmissions.push(submission);
      submissionsByParty.set(key, partySubmissions);
    }
    return Array.from(
      submissionsByParty,
      ([key, partySubmissions]) => buildRow(parties.get(key), partySubmissions, contest)
    );
  }
  function buildRow(party, submissions, contest) {
    let points = 0;
    let penalty = 0;
    for (const problemSubmissions of groupByProblem(submissions).values()) {
      const score = scoreProblem(problemSubmissions, contest);
      points += score.points;
      penalty += score.penalty;
    }
    return { party, rank: 0, points, penalty };
  }
  function groupByProblem(submissions) {
    const groups = new Map();
    for (const submission of submissions) {
      const index = submission.problem?.index;
      if (!index) {
        continue;
      }
      const group = groups.get(index) ?? [];
      group.push(submission);
      groups.set(index, group);
    }
    return groups;
  }
  function scoreProblem(submissions, contest) {
    submissions.sort(
      (left, right) => left.creationTimeSeconds === right.creationTimeSeconds ? left.id - right.id : left.creationTimeSeconds - right.creationTimeSeconds
    );
    let wrongBeforeAccepted = 0;
    for (const submission of submissions) {
      if (submission.verdict === "OK") {
        return scoreAcceptedSubmission(submission, contest, wrongBeforeAccepted);
      }
      if (countsAsWrongAttempt(submission)) {
        wrongBeforeAccepted += 1;
      }
    }
    return { points: 0, penalty: 0 };
  }
  function scoreAcceptedSubmission(submission, contest, wrongBeforeAccepted) {
    const minute = Math.trunc(submission.relativeTimeSeconds / 60);
    if (contest.type === "ICPC") {
      return { points: 1, penalty: minute + 10 * wrongBeforeAccepted };
    }
    const maxPoints = submission.problem?.points ?? 0;
    const durationMinutes = contest.durationSeconds / 60;
    const timePenalty = Math.floor(120 * maxPoints * minute / (250 * durationMinutes));
    return {
      points: Math.max(0.3 * maxPoints, maxPoints - timePenalty) - 50 * wrongBeforeAccepted,
      penalty: minute
    };
  }
  function countsAsWrongAttempt(submission) {
    if (submission.verdict === void 0 || submission.verdict === "OK" || submission.verdict === "COMPILATION_ERROR") {
      return false;
    }
    if (submission.verdict === "HACKED" || submission.verdict === "SKIPPED") {
      return true;
    }
    return (submission.passedTestCount ?? 0) > 0;
  }
  function applyHackScores(hacks, rows) {
    const rowsByParty = new Map(rows.map((row) => [getPartyKey(row.party), row]));
    for (const hack of hacks) {
      const hacker = hack.hacker;
      if (hacker?.participantType !== "CONTESTANT" || hacker.ghost === true) {
        continue;
      }
      const key = getPartyKey(hacker);
      const row = rowsByParty.get(key) ?? addEmptyRow(rows, rowsByParty, key, hacker);
      if (hack.verdict === "HACK_SUCCESSFUL") {
        row.points += 100;
      } else if (hack.verdict === "HACK_UNSUCCESSFUL") {
        row.points -= 50;
      }
    }
  }
  function addEmptyRow(rows, rowsByParty, key, party) {
    const row = { party, rank: 0, points: 0, penalty: 0 };
    rows.push(row);
    rowsByParty.set(key, row);
    return row;
  }
  function getPartyKey(party) {
    return party.participantId !== void 0 ? String(party.participantId) : party.members.map((member) => member.handle).sort().join(",");
  }
  function compareRows(left, right) {
    return left.points === right.points ? left.penalty - right.penalty : right.points - left.points;
  }
  function assignRanks$1(rows) {
    let rank = 0;
    let previousPoints = null;
    let previousPenalty = null;
    for (const [index, row] of rows.entries()) {
      if (row.points !== previousPoints || row.penalty !== previousPenalty) {
        rank = index + 1;
        previousPoints = row.points;
        previousPenalty = row.penalty;
      }
      row.rank = rank;
    }
  }
  const API_ROOT = "https://codeforces.com/api/";
  async function fetchContest(contestId, gym) {
    const contests = await fetchApi("contest.list", { gym: String(gym) });
    const contest = contests.find((entry) => String(entry.id) === contestId);
    if (!contest) {
      throw new Error(`Contest ${contestId} not found`);
    }
    return contest;
  }
  async function fetchRatingChanges(contestId) {
    return await fetchApi("contest.ratingChanges", { contestId });
  }
  function standingsHasHandle(standings, handle) {
    if (!standings || !handle) return false;
    const target = handle.toLowerCase();
    return standings.rows.some((row) =>
      row.party?.members?.some((member) => member.handle?.toLowerCase() === target)
    );
  }

  function makeStandingsResultFromRebuild(rebuilt, startedAt, cacheStored) {
    return {
      source: "status-rebuild",
      standings: rebuilt.standings,
      durationMs: performance.now() - startedAt,
      cacheStored,
      statusPages: rebuilt.statusPages,
      submissions: rebuilt.submissions,
      officialSubmissions: rebuilt.officialSubmissions,
      hacks: rebuilt.hacks
    };
  }

  async function fetchContestStandings(contestId, gym, cache, knownContest) {
    const startedAt = performance.now();
    const cached = await cache?.get(contestId, gym);
    const pinNeedsMissingUser = PIN_CONTEXT.active && PIN_CONTEXT.handle;

    if (cached && (!pinNeedsMissingUser || standingsHasHandle(cached.standings, PIN_CONTEXT.handle))) {
      return {
        source: cached.source === "api" ? "api-cache" : "status-rebuild-cache",
        standings: cached.standings,
        durationMs: performance.now() - startedAt,
        statusPages: cached.statusPages,
        submissions: cached.submissions,
        officialSubmissions: cached.officialSubmissions,
        hacks: cached.hacks
      };
    }

    if (cached && pinNeedsMissingUser) {
      console.info(`${LOG_PREFIX} Cached standings omit ${PIN_CONTEXT.handle}; refreshing standings data.`);
    }

    try {
      const response = await fetchApi("contest.standings", { contestId });
      const standings = {
        contest: response.contest,
        problems: response.problems,
        rows: response.rows.map(({ party, rank, points, penalty }) => ({
          party: {
            participantType: party.participantType,
            teamId: party.teamId,
            teamName: party.teamName,
            members: party.members.map(({ handle }) => ({ handle }))
          },
          rank,
          points,
          penalty
        }))
      };

      if (pinNeedsMissingUser && !standingsHasHandle(standings, PIN_CONTEXT.handle)) {
        console.info(`${LOG_PREFIX} Public standings omit ${PIN_CONTEXT.handle}; rebuilding from contest.status.`);
        const rebuilt = await rebuildContestStandings(contestId, gym, knownContest);
        if (standingsHasHandle(rebuilt.standings, PIN_CONTEXT.handle)) {
          const cacheStored = await cache?.set(contestId, gym, {
            source: "status-rebuild",
            ...rebuilt
          });
          return makeStandingsResultFromRebuild(rebuilt, startedAt, cacheStored);
        }
        console.warn(`${LOG_PREFIX} Rebuilt standings still do not contain ${PIN_CONTEXT.handle}; using public standings.`);
      }

      const cacheStored = await cache?.set(contestId, gym, {
        source: "api",
        standings
      });
      return {
        source: "api",
        standings,
        durationMs: performance.now() - startedAt,
        cacheStored
      };
    } catch (error) {
      if (!shouldRebuildContestStandings(error)) {
        throw error;
      }
      const rebuilt = await rebuildContestStandings(contestId, gym, knownContest);
      const cacheStored = await cache?.set(contestId, gym, {
        source: "status-rebuild",
        ...rebuilt
      });
      return makeStandingsResultFromRebuild(rebuilt, startedAt, cacheStored);
    }
  }
  async function fetchRatedUsers() {
    const users = await fetchApi("user.ratedList", { activeOnly: "false" });
    return users.map((user) => ({
      handle: user.handle,
      rating: user.rating
    }));
  }
  async function fetchApi(method, query) {
    const url = new URL(method, API_ROOT);
    for (const [key, value] of Object.entries(query)) {
      if (value === void 0) {
        continue;
      }
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store"
    });
    const payload = await parseApiResponse(response, method);
    if (!response.ok || payload.status !== "OK" || payload.result === void 0) {
      throw new Error(payload.comment ?? `Codeforces API request failed: ${method}`);
    }
    return payload.result;
  }
  async function parseApiResponse(response, method) {
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Invalid JSON from Codeforces API: ${method}`, { cause: error });
    }
  }
  const STANDINGS_PATH_PATTERN = /^\/(contest|gym)\/(\d+)\/standings(?:\/.*)?$/;
  function getStandingsPage(location) {
    const match = STANDINGS_PATH_PATTERN.exec(location.pathname);
    if (!match) {
      return null;
    }
    return {
      contestId: match[2],
      gym: match[1] === "gym"
    };
  }
  function lowerBoundInt(start, end, matches) {
    let left = start;
    let right = end;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (matches(middle)) {
        right = middle;
      } else {
        left = middle + 1;
      }
    }
    return left;
  }
  class RealConvolution {
    size;
    reverseIndex;
    rootReal;
    rootImaginary;
    constructor(requiredSize) {
      let bits = 1;
      while (2 ** bits < requiredSize) {
        bits += 1;
      }
      this.size = 2 ** bits;
      const reverseIndex = new Array(this.size);
      reverseIndex[0] = 0;
      for (let index = 1; index < this.size; index += 1) {
        reverseIndex[index] = reverseIndex[index >> 1] >> 1 | (index & 1) << bits - 1;
      }
      this.reverseIndex = reverseIndex;
      const half = this.size / 2;
      const angleStep = 2 * Math.PI / this.size;
      this.rootReal = Array.from({ length: half }, (_, index) => Math.cos(index * angleStep));
      this.rootImaginary = Array.from({ length: half }, (_, index) => Math.sin(index * angleStep));
    }
    convolve(left, right) {
      if (left.length === 0 || right.length === 0) {
        return [];
      }
      const resultLength = left.length + right.length - 1;
      if (resultLength > this.size) {
        throw new Error(`Convolution result length ${resultLength} exceeds FFT size ${this.size}`);
      }
      const real = new Array(this.size).fill(0);
      const imaginary = new Array(this.size).fill(0);
      for (let index = 0; index < left.length; index += 1) {
        real[index] = left[index];
      }
      for (let index = 0; index < right.length; index += 1) {
        imaginary[index] = right[index];
      }
      this.transform(real, imaginary);
      real[0] = 4 * real[0] * imaginary[0];
      imaginary[0] = 0;
      for (let index = 1, mirror = this.size - 1; index <= mirror; index += 1, mirror -= 1) {
        const leftReal = real[index] + real[mirror];
        const leftImaginary = imaginary[index] - imaginary[mirror];
        const rightReal = imaginary[mirror] + imaginary[index];
        const rightImaginary = real[mirror] - real[index];
        real[index] = leftReal * rightReal - leftImaginary * rightImaginary;
        imaginary[index] = leftReal * rightImaginary + leftImaginary * rightReal;
        real[mirror] = real[index];
        imaginary[mirror] = -imaginary[index];
      }
      this.transform(real, imaginary);
      const result = new Array(resultLength);
      result[0] = real[0] / (4 * this.size);
      for (let index = 1, mirror = this.size - 1; index <= mirror && index < resultLength; index += 1, mirror -= 1) {
        result[index] = real[mirror] / (4 * this.size);
        if (mirror < resultLength) {
          result[mirror] = real[index] / (4 * this.size);
        }
      }
      return result;
    }
    transform(real, imaginary) {
      this.applyBitReverse(real);
      this.applyBitReverse(imaginary);
      for (let block = 2; block <= this.size; block *= 2) {
        const halfBlock = block / 2;
        const step = this.size / block;
        for (let offset = 0; offset < this.size; offset += block) {
          let rootIndex = 0;
          for (let index = offset; index < offset + halfBlock; index += 1) {
            const pair = index + halfBlock;
            const rotatedReal = real[pair] * this.rootReal[rootIndex] - imaginary[pair] * this.rootImaginary[rootIndex];
            const rotatedImaginary = real[pair] * this.rootImaginary[rootIndex] + imaginary[pair] * this.rootReal[rootIndex];
            real[pair] = real[index] - rotatedReal;
            imaginary[pair] = imaginary[index] - rotatedImaginary;
            real[index] += rotatedReal;
            imaginary[index] += rotatedImaginary;
            rootIndex += step;
          }
        }
      }
    }
    applyBitReverse(values) {
      for (let index = 1; index < this.size; index += 1) {
        const mirror = this.reverseIndex[index];
        if (index < mirror) {
          const current = values[index];
          values[index] = values[mirror];
          values[mirror] = current;
        }
      }
    }
  }
  const DEFAULT_RATING = 1400;
  const MIN_RATING = -500;
  const MAX_RATING = 6e3;
  const RATING_SPAN = MAX_RATING - MIN_RATING;
  const RATING_INDEX_OFFSET = -MIN_RATING;
  const WIN_PROBABILITY_OFFSET = RATING_SPAN;
  const winProbability = Array.from(
    { length: 2 * RATING_SPAN + 1 },
    (_, index) => 1 / (1 + 10 ** ((index - WIN_PROBABILITY_OFFSET) / 400))
  );
  const convolution = new RealConvolution(winProbability.length + RATING_SPAN - 1);
  function predictDeltas(entries) {
    const contestants = entries.map(toMutableContestant);
    const seeds = buildSeeds(contestants);
    assignRanks(contestants);
    calculate(contestants, seeds);
    return toPredictions(contestants);
  }
  function calculate(contestants, seeds) {
    for (const contestant of contestants) {
      contestant.delta = calculateDelta(contestant, contestant.effectiveRating, seeds);
    }
    const adjustment = adjustDeltas(contestants);
    for (const contestant of contestants) {
      contestant.performance = calculatePerformance(contestant, seeds, adjustment);
    }
  }
  function toPredictions(contestants) {
    return contestants.map(({ handle, rating, delta, performance: performance2 }) => ({
      handle,
      rating,
      delta,
      performance: performance2
    }));
  }
  function toMutableContestant(entry) {
    return {
      ...entry,
      effectiveRating: entry.rating ?? DEFAULT_RATING,
      rank: 0,
      delta: 0,
      performance: 0
    };
  }
  function buildSeeds(contestants) {
    const ratingCounts = new Array(RATING_SPAN).fill(0);
    for (const contestant of contestants) {
      ratingCounts[contestant.effectiveRating + RATING_INDEX_OFFSET] += 1;
    }
    const seeds = convolution.convolve(winProbability, ratingCounts);
    for (let index = 0; index < seeds.length; index += 1) {
      seeds[index] = seeds[index] + 1;
    }
    return seeds;
  }
  function seedForRating(rating, excludedRating, seeds) {
    return seeds[rating + WIN_PROBABILITY_OFFSET + RATING_INDEX_OFFSET] - winProbability[rating - excludedRating + WIN_PROBABILITY_OFFSET];
  }
  function assignRanks(contestants) {
    contestants.sort(
      (left, right) => left.points === right.points ? left.penalty - right.penalty : right.points - left.points
    );
    let rank = 0;
    let previousPoints = null;
    let previousPenalty = null;
    for (let index = contestants.length - 1; index >= 0; index -= 1) {
      const contestant = contestants[index];
      if (contestant.points !== previousPoints || contestant.penalty !== previousPenalty) {
        rank = index + 1;
        previousPoints = contestant.points;
        previousPenalty = contestant.penalty;
      }
      contestant.rank = rank;
    }
  }
  function calculateDelta(contestant, assumedRating, seeds) {
    const seed = seedForRating(assumedRating, contestant.effectiveRating, seeds);
    const targetRank = Math.sqrt(contestant.rank * seed);
    const ratingNeeded = ratingForRank(targetRank, contestant.effectiveRating, seeds);
    return Math.trunc((ratingNeeded - assumedRating) / 2);
  }
  function ratingForRank(rank, ownRating, seeds) {
    return lowerBoundInt(2, MAX_RATING, (rating) => seedForRating(rating, ownRating, seeds) < rank) - 1;
  }
  function adjustDeltas(contestants) {
    contestants.sort((left, right) => right.effectiveRating - left.effectiveRating);
    const totalDelta = contestants.reduce((sum, contestant) => sum + contestant.delta, 0);
    const primaryAdjustment = Math.trunc(-totalDelta / contestants.length) - 1;
    for (const contestant of contestants) {
      contestant.delta += primaryAdjustment;
    }
    const leaderCount = Math.min(4 * Math.round(Math.sqrt(contestants.length)), contestants.length);
    const leaderDelta = contestants.slice(0, leaderCount).reduce((sum, contestant) => sum + contestant.delta, 0);
    const leaderAdjustment = Math.min(Math.max(Math.trunc(-leaderDelta / leaderCount), -10), 0);
    for (const contestant of contestants) {
      contestant.delta += leaderAdjustment;
    }
    return primaryAdjustment + leaderAdjustment;
  }
  function calculatePerformance(contestant, seeds, adjustment) {
    if (contestant.rank === 1) {
      return Infinity;
    }
    return lowerBoundInt(
      MIN_RATING,
      MAX_RATING,
      (assumedRating) => calculateDelta(contestant, assumedRating, seeds) + adjustment <= 0
    );
  }
  const EDUCATIONAL_RATED_THRESHOLD = 2100;
  const RATING_PENDING_MAX_DAYS = 3;
  const UNRATED_CONTEST_NAME_HINTS = ["unrated", "fools", "q#", "kotlin", "marathon", "teams"];
  const FAKE_RATINGS_SINCE_CONTEST = 1360;
  const NEW_DEFAULT_RATING = 1400;
  function predictFromCodeforces(standings, ratedUsers) {
    const ratings = new Map(ratedUsers.map((user) => [user.handle, user.rating]));
    const entries = getPredictionEntries(standings, ratings);
    return predictDeltas(entries);
  }
  function calculateFinalPerformanceFromCodeforces(standings, ratingChanges) {
    const ratings = getAdjustedOldRatings(standings.contest.id, ratingChanges);
    return predictDeltas(getFinalPredictionEntries(standings, ratings));
  }
  function getPredictionSkipReason(standings, nowMs = Date.now()) {
    if (isUnratedByName(standings.contest.name)) {
      return "contest-name-unrated";
    }
    if (standings.rows.some((row) => row.party.teamId !== void 0 || row.party.teamName !== void 0)) {
      return "team-contest";
    }
    if (!standings.rows.some((row) => row.party.participantType === "CONTESTANT")) {
      return "no-contestants";
    }
    if (isOldFinishedContest(standings, nowMs)) {
      return "old-finished-without-rating-changes";
    }
    return null;
  }
  function getPredictionEntries(standings, ratings) {
    const isEducational = isEducationalRound(standings.contest.name);
    return standings.rows.filter((row) => row.party.participantType === "CONTESTANT").filter((row) => row.party.teamId === void 0 && row.party.teamName === void 0).map((row) => {
      const handle = row.party.members[0]?.handle;
      if (!handle) {
        return null;
      }
      const rating = ratings.get(handle) ?? null;
      if (isEducational && rating !== null && rating >= EDUCATIONAL_RATED_THRESHOLD) {
        return null;
      }
      return {
        handle,
        points: row.points,
        penalty: row.penalty,
        rating
      };
    }).filter((entry) => entry !== null);
  }
  function getFinalPredictionEntries(standings, ratings) {
    const seenHandles = new Set();
    const entries = standings.rows.map((row) => {
      const handle = row.party.members[0]?.handle;
      if (!handle || !ratings.has(handle)) {
        return null;
      }
      seenHandles.add(handle);
      return {
        handle,
        points: row.points,
        penalty: row.penalty,
        rating: ratings.get(handle)
      };
    }).filter((entry) => entry !== null);
    for (const [handle, rating] of ratings) {
      if (!seenHandles.has(handle)) {
        entries.push({ handle, points: 0, penalty: 0, rating });
      }
    }
    return entries;
  }
  function getAdjustedOldRatings(contestId, ratingChanges) {
    return new Map(
      ratingChanges.map((change) => [
        change.handle,
        contestId >= FAKE_RATINGS_SINCE_CONTEST && change.oldRating === 0 ? NEW_DEFAULT_RATING : change.oldRating
      ])
    );
  }
  function isEducationalRound(contestName) {
    return contestName.toLowerCase().includes("educational");
  }
  function isUnratedByName(contestName) {
    const lowerName = contestName.toLowerCase();
    return UNRATED_CONTEST_NAME_HINTS.some((hint) => lowerName.includes(hint));
  }
  function isOldFinishedContest(standings, nowMs) {
    const { contest } = standings;
    if (contest.phase !== "FINISHED" || contest.startTimeSeconds === void 0) {
      return false;
    }
    const contestEndMs = (contest.startTimeSeconds + contest.durationSeconds) * 1e3;
    const daysSinceEnd = (nowMs - contestEndMs) / (24 * 60 * 60 * 1e3);
    return daysSinceEnd > RATING_PENDING_MAX_DAYS;
  }
  const UNRATED_RANK = {
    name: "Unrated",
    abbr: "U",
    low: -Infinity,
    high: Infinity,
    colorClass: null
  };
  const RATED_RANKS = [
    { name: "Newbie", abbr: "N", low: -Infinity, high: 1200, colorClass: "user-gray" },
    { name: "Pupil", abbr: "P", low: 1200, high: 1400, colorClass: "user-green" },
    { name: "Specialist", abbr: "S", low: 1400, high: 1600, colorClass: "user-cyan" },
    { name: "Expert", abbr: "E", low: 1600, high: 1900, colorClass: "user-blue" },
    { name: "Candidate Master", abbr: "CM", low: 1900, high: 2100, colorClass: "user-violet" },
    { name: "Master", abbr: "M", low: 2100, high: 2300, colorClass: "user-orange" },
    { name: "International Master", abbr: "IM", low: 2300, high: 2400, colorClass: "user-orange" },
    { name: "Grandmaster", abbr: "GM", low: 2400, high: 2600, colorClass: "user-red" },
    { name: "International Grandmaster", abbr: "IGM", low: 2600, high: 3e3, colorClass: "user-red" },
    { name: "Legendary Grandmaster", abbr: "LGM", low: 3e3, high: 4e3, colorClass: "user-legendary" },
    { name: "Tourist", abbr: "T", low: 4e3, high: Infinity, colorClass: "user-4000" }
  ];
  function getRank(rating) {
    if (rating === null) {
      return UNRATED_RANK;
    }
    return RATED_RANKS.find((rank) => rating < rank.high) ?? RATED_RANKS[RATED_RANKS.length - 1];
  }
  function getNextRank(rank) {
    const index = RATED_RANKS.indexOf(rank);
    return index >= 0 ? RATED_RANKS[index + 1] ?? null : RATED_RANKS[0];
  }
  const CELL_CLASS = "carrot-but-userscript-cell";
  const HEADER_CLASS = "carrot-but-userscript-header";
  const PERFORMANCE_CELL_CLASS = "carrot-but-userscript-performance-cell";
  const DELTA_CELL_CLASS = "carrot-but-userscript-delta-cell";
  const RANK_CELL_CLASS = "carrot-but-userscript-rank-cell";
  const RANK_HELPER_CLASS = "carrot-but-userscript-rank-helper";
  const RANK_UP_ACHIEVED_CLASS = "carrot-but-userscript-rank-up-achieved";
  const FINAL_HEADER_CLASS = "carrot-but-userscript-header-final";
  const LOADING_HEADER_CLASS = "carrot-but-userscript-header-loading";
  const PREDICTED_HEADER_CLASS = "carrot-but-userscript-header-predicted";
  function findStandingsTable(document2) {
    const table = document2.querySelector("table.standings");
    if (!table) {
      return null;
    }
    const rows = Array.from(table.querySelectorAll("tbody tr"));
    if (rows.length === 0) {
      return null;
    }
    return { table, rows };
  }
  function addFinalRatingColumns(standings, finalResults, performancePending = false) {
    return addRatingColumns(standings, performancePending ? "Loading performance" : "Final performance", "Final rating change", "Rank change", FINAL_HEADER_CLASS, {
      performance: (cell, row, isFooterRow) => performancePending ? renderLoadingCell(cell, isFooterRow) : renderFinalPerformanceCell(cell, row, finalResults, isFooterRow),
      delta: (cell, row, isFooterRow) => renderFinalDeltaCell(cell, row, finalResults, isFooterRow),
      rank: (cell, row, isFooterRow) => renderFinalRankCell(cell, row, finalResults, isFooterRow)
    }, performancePending);
  }
  function updateFinalPerformanceColumn(standings, finalResults) {
    for (const [index, row] of standings.rows.entries()) {
      const cell = row.querySelector(`.${PERFORMANCE_CELL_CLASS}`);
      if (!cell) continue;
      if (index === 0) {
        cell.classList.remove(LOADING_HEADER_CLASS);
        cell.classList.add(FINAL_HEADER_CLASS);
        cell.title = "Final performance";
      } else {
        cell.classList.remove("carrot-but-userscript-muted");
        renderFinalPerformanceCell(cell, row, finalResults, index === standings.rows.length - 1);
      }
    }
  }
  function addLoadingColumn(standings) {
    return addRatingColumns(standings, "Loading performance", "Loading rating changes", "Loading rank data", LOADING_HEADER_CLASS, {
      performance: (cell, _row, isFooterRow) => renderLoadingCell(cell, isFooterRow),
      delta: (cell, _row, isFooterRow) => renderLoadingCell(cell, isFooterRow),
      rank: (cell, _row, isFooterRow) => renderLoadingCell(cell, isFooterRow)
    });
  }
  function renderLoadingCell(cell, isFooterRow) {
    cell.textContent = isFooterRow ? "" : "…";
    if (!isFooterRow) {
      cell.classList.add("carrot-but-userscript-muted");
    }
    return !isFooterRow;
  }
  function clearCarrotColumns(standings) {
    for (const row of standings.rows) {
      row.querySelectorAll(`.${CELL_CLASS}`).forEach((cell) => cell.remove());
      row.querySelector("th:last-child, td:last-child")?.classList.add("right");
    }
  }
  function addPredictedRatingColumns(standings, predictions) {
    const predictionMap = predictions ? new Map(predictions.map((prediction) => [prediction.handle, prediction])) : null;
    return addRatingColumns(standings, "Predicted performance", "Predicted rating change", "Rating change for rank up", PREDICTED_HEADER_CLASS, {
      performance: (cell, row, isFooterRow) => renderPredictedPerformanceCell(cell, row, predictionMap, isFooterRow),
      delta: (cell, row, isFooterRow) => renderPredictedDeltaCell(cell, row, predictionMap, isFooterRow),
      rank: (cell, row, isFooterRow) => renderPredictedRankCell(cell, row, predictionMap, isFooterRow)
    });
  }
  function addRatingColumns(standings, performanceTitle, deltaTitle, rankTitle, headerClass, render, performancePending = false) {
    let dataRows = 0;
    let matchedRows = 0;
    for (const [index, row] of standings.rows.entries()) {
      row.querySelector("th:last-child, td:last-child")?.classList.remove("right");
      const performanceCell = document.createElement(index === 0 ? "th" : "td");
      const deltaCell = document.createElement(index === 0 ? "th" : "td");
      const rankCell = document.createElement(index === 0 ? "th" : "td");
      performanceCell.classList.add(CELL_CLASS, PERFORMANCE_CELL_CLASS);
      deltaCell.classList.add(CELL_CLASS, DELTA_CELL_CLASS);
      rankCell.classList.add(CELL_CLASS, RANK_CELL_CLASS);
      if (index === 0) {
        performanceCell.classList.add("top", HEADER_CLASS, performancePending ? LOADING_HEADER_CLASS : headerClass);
        performanceCell.title = performanceTitle;
        performanceCell.textContent = "Π";
        deltaCell.classList.add("top", HEADER_CLASS, headerClass);
        deltaCell.title = deltaTitle;
        deltaCell.textContent = "Δ";
        rankCell.classList.add("top", "right", HEADER_CLASS, headerClass);
        rankCell.title = rankTitle;
        rankCell.textContent = "Rank";
      } else {
        rankCell.classList.add("right");
        if (index % 2) {
          performanceCell.classList.add("dark");
          deltaCell.classList.add("dark");
          rankCell.classList.add("dark");
        }
        const isFooterRow = index === standings.rows.length - 1;
        if (!isFooterRow) {
          dataRows += 1;
        }
        const hasPerformance = render.performance(performanceCell, row, isFooterRow);
        const hasDelta = render.delta(deltaCell, row, isFooterRow);
        const hasRank = render.rank(rankCell, row, isFooterRow);
        if (hasPerformance || hasDelta || hasRank) {
          matchedRows += 1;
        }
      }
      row.append(performanceCell, deltaCell, rankCell);
    }
    return { matchedRows, dataRows };
  }
  function renderFinalDeltaCell(cell, row, finalResults, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const delta = handle && finalResults?.get(handle)?.delta;
    if (typeof delta !== "number") {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No rating change found for this row" : "Rating changes unavailable";
      cell.classList.add("carrot-but-userscript-muted");
      return false;
    }
    renderDeltaText(cell, delta);
    return true;
  }
  function renderFinalPerformanceCell(cell, row, finalResults, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const performance2 = handle && finalResults?.get(handle)?.performance;
    if (typeof performance2 !== "number") {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No performance found for this row" : "Performance unavailable";
      cell.classList.add("carrot-but-userscript-muted");
      return false;
    }
    renderPerformance(cell, performance2);
    return true;
  }
  function renderFinalRankCell(cell, row, finalResults, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const result = handle ? finalResults?.get(handle) : void 0;
    if (!result) {
      cell.textContent = "N/A";
      cell.title = finalResults ? "No rank change found for this row" : "Rank change unavailable";
      cell.classList.add("carrot-but-userscript-muted");
      return false;
    }
    const oldRank = getRank(result.oldRating);
    const newRank = getRank(result.newRating);
    if (oldRank.abbr === newRank.abbr) {
      cell.textContent = "—";
      cell.title = "No rank change";
      cell.classList.add("carrot-but-userscript-muted");
      return true;
    }
    const arrow = result.delta > 0 ? "↑" : "↓";
    appendRankHelper(cell, [makeRankSpan(oldRank), makeArrowSpan(arrow), makeRankSpan(newRank)]);
    return true;
  }
  function renderPredictedDeltaCell(cell, row, predictions, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const prediction = handle ? predictions?.get(handle) : void 0;
    if (!prediction) {
      cell.textContent = "N/A";
      cell.title = predictions ? "No prediction found for this row" : "Prediction unavailable";
      cell.classList.add("carrot-but-userscript-muted");
      return false;
    }
    renderDeltaText(cell, prediction.delta);
    return true;
  }
  function renderPredictedPerformanceCell(cell, row, predictions, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const prediction = handle ? predictions?.get(handle) : void 0;
    if (!prediction) {
      cell.textContent = "N/A";
      cell.title = predictions ? "No prediction found for this row" : "Prediction unavailable";
      cell.classList.add("carrot-but-userscript-muted");
      return false;
    }
    renderPerformance(cell, prediction.performance);
    return true;
  }
  function renderPredictedRankCell(cell, row, predictions, isFooterRow) {
    if (isFooterRow) {
      cell.textContent = "";
      return false;
    }
    const handle = getHandle(row);
    const prediction = handle ? predictions?.get(handle) : void 0;
    if (!prediction) {
      cell.textContent = "N/A";
      cell.title = predictions ? "No prediction found for this row" : "Prediction unavailable";
      cell.classList.add("carrot-but-userscript-muted");
      return false;
    }
    const rank = getRank(prediction.rating);
    const effectiveRating = prediction.rating ?? 1400;
    const effectiveRank = getRank(effectiveRating);
    const nextRank = getNextRank(effectiveRank);
    if (!nextRank) {
      appendRankHelper(cell, [makeRankSpan(rank)]);
      return true;
    }
    appendRankHelper(cell, [
      makeDeltaSpan(effectiveRank.high - effectiveRating),
      makeArrowSpan("↑"),
      makeRankSpan(nextRank)
    ]);
    if (prediction.delta >= effectiveRank.high - effectiveRating) {
      cell.classList.add(RANK_UP_ACHIEVED_CLASS);
    }
    return true;
  }
  function renderPerformance(cell, performance2) {
    cell.textContent = performance2 === Infinity ? "∞" : String(performance2);
    cell.classList.add("carrot-but-userscript-performance");
    const colorClass = performance2 === Infinity ? null : getRank(performance2).colorClass;
    if (colorClass) {
      cell.classList.add(colorClass);
    }
  }
  function renderDeltaText(cell, delta) {
    cell.textContent = formatDelta(delta);
    cell.classList.add(delta > 0 ? "carrot-but-userscript-positive" : "carrot-but-userscript-negative");
  }
  function appendRankHelper(cell, children) {
    const span = document.createElement("span");
    span.classList.add(RANK_HELPER_CLASS);
    span.append(...children);
    cell.append(span);
  }
  function makeDeltaSpan(delta) {
    const span = document.createElement("span");
    span.textContent = formatDelta(delta);
    span.classList.add("carrot-but-userscript-rank-delta", delta > 0 ? "carrot-but-userscript-positive" : "carrot-but-userscript-negative");
    return span;
  }
  function makeRankSpan(rank) {
    const span = document.createElement("span");
    span.textContent = rank.abbr;
    span.title = rank.name;
    span.classList.add("carrot-but-userscript-rank-abbr");
    if (rank.colorClass) {
      span.classList.add(rank.colorClass);
    }
    return span;
  }
  function makeArrowSpan(arrow) {
    const span = document.createElement("span");
    span.textContent = arrow;
    span.classList.add("carrot-but-userscript-rank-arrow");
    return span;
  }
  function formatDelta(delta) {
    return delta > 0 ? `+${delta}` : String(delta);
  }
  function getHandle(row) {
    const contestantCell = row.querySelector("td.contestant-cell");
    const profileLink = contestantCell?.querySelector('a[href*="/profile/"]');
    return profileLink?.textContent?.trim() || null;
  }
  const DATABASE_NAME = "carrot-but-userscript-cache";
  const STORE_NAME = "entries";
  let database;
  let warned = false;
  async function getCachedValue(key) {
    try {
      const entry = await transact((store) => store.get(key));
      return entry && entry.expiresAt > Date.now() ? entry.value : null;
    } catch (error) {
      warnCacheUnavailable(error);
      return null;
    }
  }
  async function setCachedValue(key, value, ttlMs) {
    try {
      if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
        throw new Error("Invalid cache TTL");
      }
      await transact((store) => store.put({ expiresAt: Date.now() + ttlMs, value }, key));
      return true;
    } catch (error) {
      warnCacheUnavailable(error);
      return false;
    }
  }  async function clearCachedValues() {
    await transact((store) => store.clear());
  }
  function openDatabase() {
    if (database) return database;
    const opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      let blocked = false;
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(STORE_NAME);
        store.createIndex("expiresAt", "expiresAt");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => {
        blocked = true;
        reject(new Error("Cache database is blocked by another tab"));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) {
          db.close();
          return;
        }
        db.onclose = db.onversionchange = () => {
          db.close();
          if (database === opening) database = void 0;
        };
        resolve(db);
      };
    });
    database = opening;
    void opening.catch(() => {
      if (database === opening) database = void 0;
    });
    return opening;
  }
  async function transact(operation) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      transaction.onabort = () => reject(transaction.error ?? new Error("Cache transaction aborted"));
      const expired = store.index("expiresAt").openKeyCursor(IDBKeyRange.upperBound(Date.now()));
      expired.onsuccess = () => {
        const cursor = expired.result;
        if (cursor) {
          store.delete(cursor.primaryKey);
          cursor.continue();
        } else {
          try {
            const request = operation(store);
            transaction.oncomplete = () => resolve(request.result);
          } catch (error) {
            transaction.abort();
            reject(error);
          }
        }
      };
    });
  }
  function warnCacheUnavailable(error) {
    if (warned) return;
    warned = true;
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    console.warn(`[Carrot, But Userscript] Cache unavailable; using live data. ${reason}`);
  }
  const PANEL_CLASS = "carrot-but-userscript-cache-panel";
  const STATUS_CLASS = "carrot-but-userscript-cache-status";
  const HIT_CLASS = "carrot-but-userscript-cache-hit";
  const MISS_CLASS = "carrot-but-userscript-cache-miss";
  const LIVE_CLASS = "carrot-but-userscript-cache-live";
  const CLEAR_BUTTON_CLASS = "carrot-but-userscript-cache-clear";
  function addCacheStatusPanel(table) {
    const panel = document.createElement("div");
    panel.classList.add(PANEL_CLASS);
    const label = document.createElement("span");
    label.textContent = "Contest cache";
    panel.append(label);
    const statuses = new Map();
    for (const name of ["metadata", "rating", "standings", "rated-users"]) {
      const status = makeStatus(name, "unused");
      statuses.set(name, status);
      panel.append(status);
    }
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.classList.add(CLEAR_BUTTON_CLASS);
    clearButton.textContent = "Clear";
    clearButton.title = "Clear Carrot, But Userscript cache";
    clearButton.addEventListener("click", () => {
      clearButton.disabled = true;
      void clearCachedValues().then(() => {
        for (const [name, status] of statuses) {
          renderStatus(status, name, "cleared");
        }
        clearButton.title = "Clear Carrot, But Userscript cache";
      }).catch((error) => {
        clearButton.title = "Cache could not be cleared; click to retry";
        console.warn("[Carrot, But Userscript] Cache clear failed:", error instanceof Error ? error.message : String(error));
      }).finally(() => {
        clearButton.disabled = false;
      });
    });
    panel.append(clearButton);
    table.parentElement?.append(panel);
    return {
      set(name, state) {
        const status = statuses.get(name);
        if (status) {
          renderStatus(status, name, state);
        }
      }
    };
  }
  function makeStatus(name, state) {
    const status = document.createElement("span");
    status.classList.add(STATUS_CLASS);
    renderStatus(status, name, state);
    return status;
  }
  function renderStatus(status, name, state) {
    status.classList.remove(HIT_CLASS, MISS_CLASS, LIVE_CLASS);
    status.textContent = `${name}: ${state}`;
    if (state === "hit") {
      status.classList.add(HIT_CLASS);
    } else if (state === "miss") {
      status.classList.add(MISS_CLASS);
    } else if (state === "live") {
      status.classList.add(LIVE_CLASS);
    }
  }
  function installStandingsStyles(document2) {
    const style = document2.createElement("style");
    style.textContent = `
.carrot-but-userscript-cell {
  width: 4em;
  min-width: 4em;
  text-align: center;
}

.carrot-but-userscript-rank-cell {
  width: 6.5em;
  min-width: 6.5em;
}

.carrot-but-userscript-rank-up-achieved {
  background-color: #f2fff2;
}

.carrot-but-userscript-rank-up-achieved.dark {
  background-color: #ebf8eb;
}

tr.highlighted-row .carrot-but-userscript-rank-up-achieved {
  background-color: #d1eef2 !important;
}

.carrot-but-userscript-header {
  font-weight: bold;
}

.carrot-but-userscript-header-final {
  color: green;
}

.carrot-but-userscript-header-loading {
  color: #9aa0a6;
  text-decoration-line: underline;
  text-decoration-thickness: 2px;
  text-decoration-color: #c4c7cc;
  text-underline-offset: 0.16em;
}

.carrot-but-userscript-header-predicted {
  color: #9b6a00;
}

.carrot-but-userscript-positive {
  color: green;
  font-weight: bold;
}

.carrot-but-userscript-negative {
  color: gray;
  font-weight: bold;
}

.carrot-but-userscript-muted {
  color: lightgray;
  font-weight: bold;
}

.carrot-but-userscript-performance {
  font-weight: bold;
}

.carrot-but-userscript-rank-helper {
  align-items: center;
  display: inline-flex;
  font-weight: bold;
}

.carrot-but-userscript-rank-delta {
  line-height: 1;
}

.carrot-but-userscript-rank-abbr {
  display: inline-block;
  line-height: 1;
}

.carrot-but-userscript-rank-arrow {
  line-height: 1;
  padding-left: 0.5em;
  padding-right: 0.5em;
}

.carrot-but-userscript-cache-panel {
  align-items: center;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid #dddddd;
  border-radius: 4px;
  bottom: 0.6em;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  color: #777;
  display: inline-flex;
  font-size: 0.92em;
  gap: 0.45em;
  max-width: calc(100vw - 1.2em);
  overflow-x: auto;
  padding: 0.35em 0.45em;
  position: fixed;
  right: 0.6em;
  white-space: nowrap;
  z-index: 20;
}

.carrot-but-userscript-cache-status {
  border: 1px solid #d8d8d8;
  border-radius: 999px;
  padding: 0.12em 0.55em;
  white-space: nowrap;
}

.carrot-but-userscript-cache-hit {
  border-color: #9dcc9d;
  color: green;
}

.carrot-but-userscript-cache-miss {
  border-color: #d4c090;
  color: #9b6a00;
}

.carrot-but-userscript-cache-live {
  border-color: #b9c7d8;
  color: #536f8a;
}

.carrot-but-userscript-cache-clear {
  background: #f7f7f7;
  border: 1px solid #cfcfcf;
  border-radius: 3px;
  color: #555;
  cursor: pointer;
  font: inherit;
  padding: 0.12em 0.55em;
}

.carrot-but-userscript-cache-clear:hover {
  background: #eeeeee;
}
`;
    document2.head.append(style);
  }
  const CACHE_NAMESPACE$2 = "cache.contest";
  const CACHE_TTL_MS$1 = 24 * 60 * 60 * 1e3;
  async function getCachedContest(contestId, gym) {
    return await getCachedValue(cacheKey$2(contestId, gym));
  }
  async function setCachedContest(contestId, gym, contest) {
    return await setCachedValue(cacheKey$2(contestId, gym), contest, CACHE_TTL_MS$1);
  }
  function cacheKey$2(contestId, gym) {
    return `${CACHE_NAMESPACE$2}.${gym ? "gym" : "contest"}.${contestId}`;
  }
  const CACHE_KEY = "cache.rated-users.compact";
  const CACHE_TTL_MS = 60 * 60 * 1e3;
  async function getCachedRatedUsers() {
    return await getCachedValue(CACHE_KEY);
  }
  async function setCachedRatedUsers(users) {
    return await setCachedValue(CACHE_KEY, users, CACHE_TTL_MS);
  }
  const CACHE_NAMESPACE$1 = "cache.rating-changes";
  const PUBLISHED_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
  async function getCachedRatingChanges(contestId) {
    return await getCachedValue(cacheKey$1(contestId));
  }
  async function setCachedRatingChanges(contestId, changes) {
    if (changes.length === 0) {
      return false;
    }
    return await setCachedValue(cacheKey$1(contestId), changes, PUBLISHED_CACHE_TTL_MS);
  }
  function cacheKey$1(contestId) {
    return `${CACHE_NAMESPACE$1}.contest.${contestId}`;
  }
  const CACHE_NAMESPACE = "cache.standings";
  const LIVE_CACHE_TTL_MS = 30 * 1e3;
  const FINISHED_CACHE_TTL_MS = 24 * 60 * 60 * 1e3;
  async function getCachedContestStandings(contestId, gym) {
    return await getCachedValue(cacheKey(contestId, gym));
  }
  async function setCachedContestStandings(contestId, gym, result) {
    return await setCachedValue(cacheKey(contestId, gym), result, getCacheTtlMs(result));
  }
  function cacheKey(contestId, gym) {
    return `${CACHE_NAMESPACE}.${gym ? "gym" : "contest"}.${contestId}`;
  }
  function getCacheTtlMs(result) {
    return result.standings.contest.phase === "FINISHED" ? FINISHED_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
  }
  const LOG_PREFIX = "[Carrot, But Userscript]";
  async function main() {
    const startedAt = performance.now();
    const page = getStandingsPage(window.location);
    if (!page) {
      return;
    }
    await ensurePinnedCurrentUserRow(page);
    const standings = findStandingsTable(document);
    if (!standings) {
      console.info(`${LOG_PREFIX} Standings table not found.`);
      return;
    }
    installStandingsStyles(document);
    clearCarrotColumns(standings);
    addLoadingColumn(standings);
    const cachePanel = addCacheStatusPanel(standings.table);
    logProgress("start", startedAt, { contestId: page.contestId, page: page.gym ? "gym" : "contest", storage: "indexeddb" });
    let ratingStatus = "unknown";
    const contestResult = await loadContest(page.contestId, page.gym).catch((error) => {
      console.error(`${LOG_PREFIX} Contest unavailable:`, error);
      return null;
    });
    let contest = null;
    if (contestResult) {
      contest = contestResult.value;
      logProgress("metadata", startedAt, {
        cache: contestResult.cache,
        phase: contest.phase,
        source: contestResult.source,
        stepMs: ms(contestResult.durationMs)
      });
      cachePanel.set("metadata", contestResult.cache);
      if (contest.phase !== "FINISHED") {
        ratingStatus = "not-finished";
      }
    }
    if (contest?.phase === "FINISHED") {
      const ratingChangesResult = await loadRatingChanges(page.contestId).catch((error) => {
        console.info(`${LOG_PREFIX} Rating changes unavailable:`, error);
        return null;
      });
      ratingStatus = "pending";
      if (ratingChangesResult) {
        const ratingChanges = ratingChangesResult.value;
        cachePanel.set("rating", ratingChangesResult.cache);
        if (ratingChanges.length === 0) {
          logProgress("rating", startedAt, {
            cache: ratingChangesResult.cache,
            status: ratingStatus,
            source: ratingChangesResult.source,
            changes: 0,
            stepMs: ms(ratingChangesResult.durationMs)
          });
        } else {
          const finalResults = buildFinalResults(ratingChanges);
          ratingStatus = "published";
          clearCarrotColumns(standings);
          const stats2 = addFinalRatingColumns(standings, finalResults, true);
          logProgress("final", startedAt, {
            cache: ratingChangesResult.cache,
            source: ratingChangesResult.source,
            changes: ratingChanges.length,
            performance: "loading",
            rendered: renderRatio(stats2),
            stepMs: ms(ratingChangesResult.durationMs)
          });
          const performanceStartedAt = performance.now();
          let performanceStatus = "ok";
          try {
            const finalStandingsResult = await fetchContestStandings(page.contestId, page.gym, {
              get: getCachedContestStandings,
              set: setCachedContestStandings
            }, contest);
            logStandingsResult("standings", startedAt, finalStandingsResult);
            cachePanel.set("standings", cacheState(finalStandingsResult));
            const predictions = calculateFinalPerformanceFromCodeforces(finalStandingsResult.standings, ratingChanges);
            for (const prediction of predictions) {
              const result = finalResults.get(prediction.handle);
              if (result) result.performance = prediction.performance;
            }
          } catch (error) {
            performanceStatus = "unavailable";
            console.error(`${LOG_PREFIX} Final performance unavailable:`, error);
          }
          updateFinalPerformanceColumn(standings, finalResults);
          logProgress("final-performance", startedAt, {
            status: performanceStatus,
            performance: countFinalPerformance(finalResults),
            stepMs: durationMs(performanceStartedAt)
          });
          return;
        }
      }
    }
    const contestStandingsResult = contest ? await fetchContestStandings(page.contestId, page.gym, {
      get: getCachedContestStandings,
      set: setCachedContestStandings
    }, contest).catch((error) => {
      console.error(`${LOG_PREFIX} Standings unavailable:`, error);
      return null;
    }) : null;
    if (contestStandingsResult) {
      logStandingsResult("standings", startedAt, contestStandingsResult);
      cachePanel.set("standings", cacheState(contestStandingsResult));
    }
    const predictionResult = contestStandingsResult ? await predictContest(contestStandingsResult.standings, startedAt, cachePanel).catch((predictionError) => {
      console.error(`${LOG_PREFIX} Prediction failed:`, predictionError);
      return { predictions: null, status: "failed", reason: errorReason(predictionError) };
    }) : { predictions: null, status: "unavailable", reason: "standings-unavailable" };
    clearCarrotColumns(standings);
    const stats = addPredictedRatingColumns(standings, predictionResult.predictions);
    syncPinnedCurrentUserPrediction(predictionResult.predictions, contestStandingsResult?.standings);
    logProgress("prediction", startedAt, {
      prediction: predictionResult.status,
      reason: predictionResult.reason,
      rating: ratingStatus,
      predictions: predictionResult.predictions?.length ?? 0,
      rendered: renderRatio(stats)
    });
  }
  async function loadContest(contestId, gym) {
    const startedAt = performance.now();
    const cachedContest = await getCachedContest(contestId, gym);
    if (cachedContest) {
      return {
        value: cachedContest,
        cache: "hit",
        source: "contest.list-cache",
        durationMs: performance.now() - startedAt
      };
    }
    const contest = await fetchContest(contestId, gym);
    const stored = contest.phase === "FINISHED" && await setCachedContest(contestId, gym, contest);
    return {
      value: contest,
      cache: contest.phase !== "FINISHED" ? "live" : stored ? "miss" : "unavailable",
      source: "contest.list",
      durationMs: performance.now() - startedAt
    };
  }
  async function loadRatingChanges(contestId) {
    const startedAt = performance.now();
    const cachedChanges = await getCachedRatingChanges(contestId);
    if (cachedChanges) {
      return {
        value: cachedChanges,
        cache: "hit",
        source: "contest.ratingChanges-cache",
        durationMs: performance.now() - startedAt
      };
    }
    const changes = await fetchRatingChanges(contestId);
    const stored = await setCachedRatingChanges(contestId, changes);
    return {
      value: changes,
      cache: changes.length === 0 ? "live" : stored ? "miss" : "unavailable",
      source: "contest.ratingChanges",
      durationMs: performance.now() - startedAt
    };
  }
  function logStandingsResult(stage, startedAt, result) {
    logProgress(stage, startedAt, {
      cache: cacheState(result),
      standings: standingsMode(result),
      source: standingsSource(result),
      rows: result.standings.rows.length,
      statusPages: result.statusPages,
      submissions: result.submissions,
      officialSubmissions: result.officialSubmissions,
      hacks: result.hacks,
      stepMs: ms(result.durationMs)
    });
  }
  function buildFinalResults(ratingChanges) {
    return new Map(
      ratingChanges.map((change) => [
        change.handle,
        {
          delta: change.newRating - change.oldRating,
          oldRating: change.oldRating,
          newRating: change.newRating
        }
      ])
    );
  }
  async function predictContest(standings, startedAt, cachePanel) {
    const skipReason = getPredictionSkipReason(standings);
    if (skipReason) {
      return { predictions: null, status: "skipped", reason: skipReason };
    }
    const ratedUsersResult = await loadRatedUsers();
    logProgress("rated-users", startedAt, {
      cache: ratedUsersResult.cache,
      source: ratedUsersResult.source,
      users: ratedUsersResult.value.length,
      stepMs: ms(ratedUsersResult.durationMs)
    });
    cachePanel.set("rated-users", ratedUsersResult.cache);
    const predictions = predictFromCodeforces(standings, ratedUsersResult.value);
    return { predictions, status: "ok" };
  }
  async function loadRatedUsers() {
    const startedAt = performance.now();
    const cachedUsers = await getCachedRatedUsers();
    if (cachedUsers) {
      return {
        value: cachedUsers,
        cache: "hit",
        source: "user.ratedList-cache",
        durationMs: performance.now() - startedAt
      };
    }
    const users = await fetchRatedUsers();
    const stored = await setCachedRatedUsers(users);
    return {
      value: users,
      cache: stored ? "miss" : "unavailable",
      source: "user.ratedList",
      durationMs: performance.now() - startedAt
    };
  }
  function logProgress(stage, startedAt, details) {
    console.info(`${LOG_PREFIX} ${stage}`, {
      ...withoutUndefined(details),
      totalMs: durationMs(startedAt)
    });
  }
  function withoutUndefined(details) {
    return Object.fromEntries(
      Object.entries(details).filter((entry) => entry[1] !== void 0)
    );
  }
  function standingsSource(result) {
    if (result.source === "api") {
      return "contest.standings";
    }
    if (result.source === "api-cache") {
      return "contest.standings-cache";
    }
    return result.source === "status-rebuild-cache" ? "contest.status-cache" : "contest.status";
  }
  function cacheState(result) {
    return result.source.endsWith("-cache") ? "hit" : result.cacheStored ? "miss" : "unavailable";
  }
  function standingsMode(result) {
    if (result.source === "api" || result.source === "api-cache") {
      return result.source === "api-cache" ? "api-cache" : "api";
    }
    return result.source === "status-rebuild-cache" ? "fallback-cache" : "fallback";
  }
  function renderRatio(stats) {
    return `${stats.matchedRows}/${stats.dataRows}`;
  }
  function countFinalPerformance(results) {
    let count = 0;
    for (const result of results.values()) {
      if (typeof result.performance === "number") {
        count += 1;
      }
    }
    return count;
  }
  function durationMs(startedAt) {
    return ms(performance.now() - startedAt);
  }
  function ms(duration) {
    return Math.round(duration);
  }
  function errorReason(error) {
    return error instanceof Error ? error.message : String(error);
  }

  // ===== Pinned current-user integration =====
  const PINNED_ROW_ID = "carrot-current-user-pinned";
  const PIN_CONTEXT = {
    handle: null,
    active: false
  };

  function getLoggedInHandle(document2 = document) {
    const logoutLink = document2.querySelector('a[href*="/logout"]');
    if (logoutLink) {
      const containers = [logoutLink.parentElement, logoutLink.parentElement?.parentElement].filter(Boolean);
      for (const container of containers) {
        const profileLink = container.querySelector('a[href^="/profile/"]');
        const handle = profileLink?.textContent?.trim();
        if (handle) return handle;
      }
    }

    const topProfileCandidates = document2.querySelectorAll(
      '.lang-chooser a[href^="/profile/"], #header a[href^="/profile/"], .header-bell + a[href^="/profile/"]'
    );
    for (const link of topProfileCandidates) {
      const handle = link.textContent?.trim();
      if (handle) return handle;
    }
    return null;
  }

  function findHandleRow(table, handle) {
    if (!table || !handle) return null;
    const target = handle.toLowerCase();
    for (const link of table.querySelectorAll('a[href*="/profile/"]')) {
      if (link.textContent?.trim().toLowerCase() === target) {
        return link.closest("tr");
      }
    }
    return null;
  }

  async function ensurePinnedCurrentUserRow(page) {
    if (location.pathname.includes("/standings/friends/true")) return null;
    const current = document.getElementById(PINNED_ROW_ID);
    if (current) return current;

    const handle = getLoggedInHandle(document);
    PIN_CONTEXT.handle = handle;
    PIN_CONTEXT.active = false;
    if (!handle) {
      console.info(`${LOG_PREFIX} Pin: no logged-in Codeforces handle detected.`);
      return null;
    }

    try {
      const scope = page.gym ? "gym" : "contest";
      const response = await fetch(`/${scope}/${page.contestId}/standings/friends/true`, {
        credentials: "include",
        cache: "no-store"
      });
      if (!response.ok) {
        console.warn(`${LOG_PREFIX} Pin: friends standings HTTP ${response.status}`);
        return null;
      }

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const friendsTable = doc.querySelector("table.standings");
      if (!friendsTable) {
        console.warn(`${LOG_PREFIX} Pin: friends standings table not found.`);
        return null;
      }

      const sourceRow = findHandleRow(friendsTable, handle);
      if (!sourceRow) {
        console.info(`${LOG_PREFIX} Pin: ${handle} is not present in friends standings for this contest.`);
        return null;
      }

      const mainTable = document.querySelector("table.standings");
      const tbody = mainTable?.querySelector("tbody");
      if (!tbody) {
        console.warn(`${LOG_PREFIX} Pin: main standings tbody not found.`);
        return null;
      }

      const clone = document.importNode(sourceRow, true);
      clone.id = PINNED_ROW_ID;
      clone.dataset.carrotPinnedHandle = handle;
      clone.style.background = "#fff5b5";
      clone.style.borderTop = "3px solid #d9a900";
      clone.style.borderBottom = "3px solid #d9a900";
      clone.querySelectorAll(`.${CELL_CLASS}`).forEach((cell) => cell.remove());

      const firstPlayer = Array.from(tbody.children).find((row) =>
        row.querySelector('a[href*="/profile/"]')
      );
      if (firstPlayer) tbody.insertBefore(clone, firstPlayer);
      else tbody.appendChild(clone);

      PIN_CONTEXT.active = true;
      console.info(`${LOG_PREFIX} Pin: ${handle} inserted at the top of the visible standings.`);
      return clone;
    } catch (error) {
      console.error(`${LOG_PREFIX} Pin failed:`, error);
      return null;
    }
  }

  function updatePinnedOverallRank(standings) {
    const row = document.getElementById(PINNED_ROW_ID);
    const handle = PIN_CONTEXT.handle;
    if (!row || !standings || !handle) return;

    const target = handle.toLowerCase();
    const standingsRow = standings.rows.find((item) =>
      item.party?.members?.some((member) => member.handle?.toLowerCase() === target)
    );
    if (!standingsRow || !Number.isFinite(standingsRow.rank)) return;

    const firstCell = row.cells?.[0];
    if (!firstCell) return;
    const originalText = firstCell.textContent?.trim();
    firstCell.textContent = `${standingsRow.rank} 📌`;
    firstCell.title = originalText
      ? `Pinned current user. Friends-standings label: ${originalText}`
      : "Pinned current user";
  }

  function syncPinnedCurrentUserPrediction(predictions, standings) {
    const row = document.getElementById(PINNED_ROW_ID);
    const handle = PIN_CONTEXT.handle;
    if (!row || !handle) return;

    updatePinnedOverallRank(standings);
    row.querySelectorAll(`.${CELL_CLASS}`).forEach((cell) => cell.remove());

    const prediction = predictions?.find(
      (item) => item.handle?.toLowerCase() === handle.toLowerCase()
    );

    const performanceCell = document.createElement("td");
    const deltaCell = document.createElement("td");
    const rankCell = document.createElement("td");
    performanceCell.classList.add(CELL_CLASS, PERFORMANCE_CELL_CLASS);
    deltaCell.classList.add(CELL_CLASS, DELTA_CELL_CLASS);
    rankCell.classList.add(CELL_CLASS, RANK_CELL_CLASS, "right");

    if (!prediction) {
      for (const cell of [performanceCell, deltaCell, rankCell]) {
        cell.textContent = "N/A";
        cell.classList.add("carrot-but-userscript-muted");
      }
      row.append(performanceCell, deltaCell, rankCell);
      console.warn(`${LOG_PREFIX} Pin: prediction for ${handle} not found.`);
      return;
    }

    renderPerformance(performanceCell, prediction.performance);
    renderDeltaText(deltaCell, prediction.delta);

    const effectiveRating = prediction.rating ?? DEFAULT_RATING;
    const effectiveRank = getRank(effectiveRating);
    const nextRank = getNextRank(effectiveRank);
    if (!nextRank) {
      appendRankHelper(rankCell, [makeRankSpan(effectiveRank)]);
    } else {
      const need = effectiveRank.high - effectiveRating;
      appendRankHelper(rankCell, [
        makeDeltaSpan(need),
        makeArrowSpan("↑"),
        makeRankSpan(nextRank)
      ]);
      if (prediction.delta >= need) {
        rankCell.classList.add(RANK_UP_ACHIEVED_CLASS);
      }
    }

    row.append(performanceCell, deltaCell, rankCell);
    console.info(`${LOG_PREFIX} Pin: prediction synced.`, {
      handle: prediction.handle,
      rating: prediction.rating,
      performance: prediction.performance,
      delta: prediction.delta
    });
  }
  // ===== End pinned current-user integration =====

  void main();

})();