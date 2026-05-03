import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_API_BASE_URL = "https://www.dhlottery.co.kr/common.do?method=getLottoNumber&drwNo=";
const PYONY_ROUND_URL = "https://pyony.com/lotto/rounds/";
const LOTTOHELL_ROUND_URL = "https://lottohell.com/results/";

const REQUEST_TIMEOUT_MS = 15000;
const MAX_FETCH_RETRIES = 4;
const RETRY_DELAYS_MS = [1500, 4000, 9000];

const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFilePath);
const repoRoot = path.resolve(currentDir, "..");
const historyJsonPath = path.join(repoRoot, "lotto-history.json");
const snapshotJsPath = path.join(repoRoot, "lotto-history-snapshot.js");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function formatDate(yyyy, mm, dd) {
  return `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

function normalizeNumbers(values) {
  if (!Array.isArray(values) || values.length !== 6) {
    return null;
  }

  const numbers = values.map((value) => asInteger(value));
  if (numbers.some((value) => value === null || value < 1 || value > 45)) {
    return null;
  }

  if (new Set(numbers).size !== 6) {
    return null;
  }

  return [...numbers].sort((a, b) => a - b);
}

function normalizeRoundObject(roundLike) {
  const round = asInteger(roundLike.round);
  const bonus = asInteger(roundLike.bonus);
  const date = String(roundLike.date ?? "");
  const numbers = normalizeNumbers(roundLike.numbers);

  if (round === null || round <= 0) {
    return null;
  }
  if (bonus === null || bonus < 1 || bonus > 45) {
    return null;
  }
  if (!numbers) {
    return null;
  }
  if (numbers.includes(bonus)) {
    return null;
  }

  return {
    round,
    date,
    numbers,
    bonus
  };
}

function sameRoundCore(left, right) {
  if (!left || !right) {
    return false;
  }
  if (left.round !== right.round || left.bonus !== right.bonus) {
    return false;
  }
  if (left.numbers.length !== right.numbers.length) {
    return false;
  }
  return left.numbers.every((number, idx) => number === right.numbers[idx]);
}

function normalizeHistoryPayload(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("History JSON root must be an object.");
  }
  if (!Array.isArray(raw.rounds)) {
    throw new Error("History JSON must contain a rounds array.");
  }

  const byRound = new Map();
  raw.rounds.forEach((item) => {
    const normalized = normalizeRoundObject(item);
    if (!normalized) {
      throw new Error(`Invalid round data found in history JSON: ${JSON.stringify(item)}`);
    }
    byRound.set(normalized.round, normalized);
  });

  const rounds = [...byRound.values()].sort((a, b) => a.round - b.round);
  return {
    source: "snapshot",
    generatedAt: new Date().toISOString(),
    roundCount: rounds.length,
    rounds
  };
}

async function fetchTextWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: "no-store",
      headers: {
        accept: "application/json, text/plain, */*",
        "user-agent": "codex-lotto-history-updater/1.1"
      }
    });
    const text = await response.text();
    return { response, text };
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildRoundFromOfficialPayload(payload, expectedRound) {
  if (!payload || payload.returnValue !== "success") {
    return null;
  }

  const round = asInteger(payload.drwNo);
  if (round === null || round !== expectedRound) {
    throw new Error(`Official API returned unexpected round number: expected=${expectedRound}, actual=${payload.drwNo}`);
  }

  const numbers = normalizeNumbers([
    payload.drwtNo1,
    payload.drwtNo2,
    payload.drwtNo3,
    payload.drwtNo4,
    payload.drwtNo5,
    payload.drwtNo6
  ]);
  if (!numbers) {
    throw new Error(`Official API returned invalid winning numbers for round ${expectedRound}.`);
  }

  const bonus = asInteger(payload.bnusNo);
  if (bonus === null || bonus < 1 || bonus > 45 || numbers.includes(bonus)) {
    throw new Error(`Official API returned invalid bonus number for round ${expectedRound}.`);
  }

  return {
    round,
    date: String(payload.drwNoDate ?? ""),
    numbers,
    bonus
  };
}

async function fetchRoundFromOfficialOnce(round) {
  const { response, text } = await fetchTextWithTimeout(`${OFFICIAL_API_BASE_URL}${round}`);

  if (!response.ok) {
    throw new Error(`Official API HTTP ${response.status}`);
  }
  if (text.trim().startsWith("<")) {
    throw new Error("Official API returned HTML instead of JSON.");
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Official API returned invalid JSON.");
  }

  if (payload.returnValue !== "success") {
    return { status: "not_ready" };
  }

  return {
    status: "success",
    roundData: buildRoundFromOfficialPayload(payload, round),
    source: "official"
  };
}

async function fetchRoundFromOfficialWithRetry(round) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    try {
      return await fetchRoundFromOfficialOnce(round);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[official][round ${round}] attempt ${attempt}/${MAX_FETCH_RETRIES} failed: ${message}`);

      if (attempt < MAX_FETCH_RETRIES) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Official API failed for round ${round} after ${MAX_FETCH_RETRIES} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildRoundFromPyonyHtml(html, expectedRound) {
  const text = stripHtmlToText(html);
  const pattern = new RegExp(
    `${expectedRound}\\D+\\((20\\d{2})\\D+(\\d{1,2})\\D+(\\d{1,2})\\D+\\)\\s*` +
      "([0-9]{1,2})\\s+([0-9]{1,2})\\s+([0-9]{1,2})\\s+([0-9]{1,2})\\s+([0-9]{1,2})\\s+([0-9]{1,2})\\s+([0-9]{1,2})"
  );
  const match = text.match(pattern);
  if (!match) {
    return null;
  }

  const round = expectedRound;
  const date = formatDate(
    Number(match[1]),
    Number(match[2]),
    Number(match[3])
  );

  const numbers = normalizeNumbers([
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
    Number(match[8]),
    Number(match[9])
  ]);
  const bonus = asInteger(match[10]);

  if (!numbers || bonus === null || bonus < 1 || bonus > 45 || numbers.includes(bonus)) {
    throw new Error(`Pyony returned invalid numbers for round ${expectedRound}.`);
  }

  return { round, date, numbers, bonus };
}

async function fetchRoundFromPyonyOnce(round) {
  const { response, text } = await fetchTextWithTimeout(`${PYONY_ROUND_URL}${round}/`);

  if (!response.ok) {
    if ([404, 429, 500, 503].includes(response.status)) {
      return { status: "not_ready" };
    }
    throw new Error(`Pyony HTTP ${response.status}`);
  }

  const roundData = buildRoundFromPyonyHtml(text, round);
  if (!roundData) {
    return { status: "not_ready" };
  }

  return {
    status: "success",
    roundData,
    source: "pyony"
  };
}

async function fetchRoundFromPyonyWithRetry(round) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    try {
      return await fetchRoundFromPyonyOnce(round);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[pyony][round ${round}] attempt ${attempt}/${MAX_FETCH_RETRIES} failed: ${message}`);

      if (attempt < MAX_FETCH_RETRIES) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Pyony fetch failed for round ${round} after ${MAX_FETCH_RETRIES} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

function buildRoundFromLottohellHtml(html, expectedRound) {
  const roundTitleMatch = html.match(/<h1[^>]*>[\s\S]*?([0-9]{1,4})\D+<\/h1>/i);
  const titleRound = asInteger(roundTitleMatch?.[1]);
  if (titleRound === null || titleRound !== expectedRound) {
    return null;
  }

  const dateMatch = html.match(
    /card-header[\s\S]{0,220}?fa-clock[\s\S]{0,120}?([0-9]{4})\D+([0-9]{1,2})\D+([0-9]{1,2})/i
  );
  if (!dateMatch) {
    throw new Error(`Lottohell date parsing failed for round ${expectedRound}.`);
  }

  const numbersRaw = [...html.matchAll(/numberCircle[^>]*>\s*<strong>\s*([0-9]{1,2})\s*<\/strong>/gi)]
    .map((match) => Number(match[1]));

  if (numbersRaw.length < 7) {
    return null;
  }

  const numbers = normalizeNumbers(numbersRaw.slice(0, 6));
  const bonus = asInteger(numbersRaw[6]);

  if (!numbers || bonus === null || bonus < 1 || bonus > 45 || numbers.includes(bonus)) {
    throw new Error(`Lottohell returned invalid numbers for round ${expectedRound}.`);
  }

  return {
    round: expectedRound,
    date: formatDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])),
    numbers,
    bonus
  };
}

async function fetchRoundFromLottohellOnce(round) {
  const { response, text } = await fetchTextWithTimeout(`${LOTTOHELL_ROUND_URL}${round}/`);

  if (!response.ok) {
    if ([404, 429, 500, 503].includes(response.status)) {
      return { status: "not_ready" };
    }
    throw new Error(`Lottohell HTTP ${response.status}`);
  }

  const roundData = buildRoundFromLottohellHtml(text, round);
  if (!roundData) {
    return { status: "not_ready" };
  }

  return {
    status: "success",
    roundData,
    source: "lottohell"
  };
}

async function fetchRoundFromLottohellWithRetry(round) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    try {
      return await fetchRoundFromLottohellOnce(round);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[lottohell][round ${round}] attempt ${attempt}/${MAX_FETCH_RETRIES} failed: ${message}`);

      if (attempt < MAX_FETCH_RETRIES) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        await sleep(delay);
      }
    }
  }

  throw new Error(
    `Lottohell fetch failed for round ${round} after ${MAX_FETCH_RETRIES} attempts. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
  );
}

async function verifyFallbackSources(roundsByNumber, referenceRound) {
  const local = roundsByNumber.get(referenceRound);
  if (!local) {
    throw new Error(`Cannot verify fallback sources. Local reference round ${referenceRound} not found.`);
  }

  const pyony = await fetchRoundFromPyonyWithRetry(referenceRound);
  if (pyony.status !== "success" || !sameRoundCore(pyony.roundData, local)) {
    throw new Error(`Pyony verification failed on round ${referenceRound}.`);
  }

  const lottohell = await fetchRoundFromLottohellWithRetry(referenceRound);
  if (lottohell.status !== "success" || !sameRoundCore(lottohell.roundData, local)) {
    throw new Error(`Lottohell verification failed on round ${referenceRound}.`);
  }

  console.log(`Fallback sources verified with round ${referenceRound}.`);
}

async function fetchRoundWithBestEffort(round, roundsByNumber, fallbackState) {
  try {
    const official = await fetchRoundFromOfficialWithRetry(round);
    if (official.status === "success") {
      return official;
    }
    if (official.status === "not_ready") {
      return official;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[round ${round}] Official API unavailable. Switching to verified fallback sources. (${message})`);
  }

  if (!fallbackState.verified) {
    await verifyFallbackSources(roundsByNumber, round - 1);
    fallbackState.verified = true;
  }

  const pyony = await fetchRoundFromPyonyWithRetry(round);
  if (pyony.status === "not_ready") {
    return pyony;
  }

  const lottohell = await fetchRoundFromLottohellWithRetry(round);
  if (lottohell.status === "success" && !sameRoundCore(pyony.roundData, lottohell.roundData)) {
    throw new Error(
      `Fallback sources mismatch for round ${round}. pyony=${JSON.stringify(pyony.roundData)} lottohell=${JSON.stringify(lottohell.roundData)}`
    );
  }
  if (lottohell.status !== "success") {
    console.warn(`[round ${round}] Lottohell did not confirm this round. Using verified Pyony data only.`);
  }

  return pyony;
}

async function readJsonFile(filePath) {
  const content = await fs.readFile(filePath, "utf8");
  return JSON.parse(content);
}

async function writeFileAtomically(targetPath, content) {
  const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, content, "utf8");
  await fs.rename(tempPath, targetPath);
}

function makeSnapshotScript(historyPayload) {
  return `window.LOTTO_HISTORY_SNAPSHOT = ${JSON.stringify(historyPayload)};\n`;
}

async function main() {
  const rawHistory = await readJsonFile(historyJsonPath);
  const normalizedHistory = normalizeHistoryPayload(rawHistory);

  if (normalizedHistory.roundCount === 0) {
    throw new Error("History JSON has no rounds.");
  }

  const roundsByNumber = new Map(
    normalizedHistory.rounds.map((roundData) => [roundData.round, roundData])
  );

  let nextRound = normalizedHistory.rounds[normalizedHistory.rounds.length - 1].round + 1;
  let appendedCount = 0;
  const fallbackState = { verified: false };

  while (true) {
    const result = await fetchRoundWithBestEffort(nextRound, roundsByNumber, fallbackState);

    if (result.status === "not_ready") {
      console.log(`No published data for round ${nextRound} yet. Stop.`);
      break;
    }

    roundsByNumber.set(result.roundData.round, result.roundData);
    appendedCount += 1;
    console.log(
      `Added round ${result.roundData.round} (${result.roundData.date}) using source=${result.source}.`
    );
    nextRound += 1;
  }

  const mergedRounds = [...roundsByNumber.values()].sort((a, b) => a.round - b.round);
  const updatedHistory = {
    source: "snapshot",
    generatedAt: new Date().toISOString(),
    roundCount: mergedRounds.length,
    rounds: mergedRounds
  };

  const updatedHistoryJson = `${JSON.stringify(updatedHistory, null, 2)}\n`;
  const updatedSnapshotJs = makeSnapshotScript(updatedHistory);

  const currentHistoryJson = await fs.readFile(historyJsonPath, "utf8");
  const currentSnapshotJs = await fs.readFile(snapshotJsPath, "utf8");

  const historyChanged = currentHistoryJson !== updatedHistoryJson;
  const snapshotChanged = currentSnapshotJs !== updatedSnapshotJs;

  if (!historyChanged && !snapshotChanged) {
    console.log("History is already up to date. No file changes.");
    return;
  }

  await writeFileAtomically(historyJsonPath, updatedHistoryJson);
  await writeFileAtomically(snapshotJsPath, updatedSnapshotJs);

  const latestRound = mergedRounds[mergedRounds.length - 1];
  console.log(
    `Updated files: +${appendedCount} round(s), latest round=${latestRound.round}, date=${latestRound.date}`
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
