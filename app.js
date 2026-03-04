/** =========================================================
 * Code.gs v9 - Townhall Challenge Backend
 * - 3 attempts per user
 * - log answers per attempt into answer_logs
 * - scoring by difficulty + streak bonus
 * - leaderboard best attempt per user, group completion% + top score
 * ========================================================= */

/** ========= CONFIG ========= */
const SHEET_USERS      = "users";
const SHEET_SESSIONS   = "sessions";
const SHEET_WATCH      = "watch_logs";
const SHEET_TAKEAWAYS  = "takeaways";
const SHEET_QUESTIONS  = "questions";
const SHEET_SCORES     = "scores";
const SHEET_ANSWERS    = "answer_logs"; // NEW

const VIDEO_ID = "TOWNHALL_2026_DIRUT";

// Durasi video 01:14:29 (abaikan frame)
const VIDEO_TOTAL_SECONDS = 1 * 3600 + 14 * 60 + 29; // 4469
const MIN_WATCH_SECONDS = Math.ceil(VIDEO_TOTAL_SECONDS * 0.60); // 2682

const MAX_ATTEMPTS_PER_USER = 3;

/** ========= Helpers ========= */
function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowISO() { return new Date().toISOString(); }

function makeId(prefix) {
  return prefix + "_" + Utilities.getUuid().slice(0, 8) + "_" + Date.now();
}

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error(`Sheet "${name}" tidak ditemukan.`);
  return sh;
}

function findRowByValue(sheet, colIndex1Based, value) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const range = sheet.getRange(2, colIndex1Based, last - 1, 1).getValues();
  const needle = String(value).trim();
  for (let i = 0; i < range.length; i++) {
    if (String(range[i][0]).trim() === needle) return i + 2;
  }
  return -1;
}

function getParams_(e) {
  const p = (e && e.parameter) ? e.parameter : {};
  if (e && e.postData && e.postData.contents) {
    try { return Object.assign({}, p, JSON.parse(e.postData.contents)); } catch (_) {}
  }
  return p;
}

function idxMap_(headers) {
  const h = headers.map(x => String(x).trim());
  const idx = (name) => h.indexOf(name);
  return { h, idx };
}

/** ========= USERS =========
 * users: user_id | nipp | name | email | unit | sub_unit | password | is_active
 */
function getUserByCredentials(userKey, password) {
  const sh = getSheet(SHEET_USERS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return null;

  const { idx } = idxMap_(data[0]);

  const idI   = idx("user_id");
  const nippI = idx("nipp");
  const nmI   = idx("name");
  const emI   = idx("email");
  const unI   = idx("unit");
  const suI   = idx("sub_unit");
  const pwI   = idx("password");
  const acI   = idx("is_active");

  const required = ["user_id","name","email","unit","sub_unit","password","is_active"];
  const missing = required.filter(c => idx(c) === -1);
  if (missing.length) throw new Error("Header users kurang: " + missing.join(", "));

  const inputRaw = String(userKey || "").trim();
  const inputLower = inputRaw.toLowerCase();
  const pass = String(password || "").trim();

  for (let r = 1; r < data.length; r++) {
    const row = data[r];

    const userId = String(row[idI] || "").trim();
    const email  = String(row[emI] || "").trim();
    const nipp   = (nippI !== -1) ? String(row[nippI] || "").trim() : "";

    const pw     = String(row[pwI] || "").trim();
    const active = String(row[acI] || "").trim().toUpperCase() === "TRUE";
    if (!active) continue;

    const match =
      (inputRaw === userId) ||
      (inputLower === email.toLowerCase()) ||
      (nipp && inputRaw === nipp);

    if (match && pw === pass) {
      return {
        user_id: userId,
        nipp: nipp,
        name: String(row[nmI] || "").trim(),
        email,
        unit: String(row[unI] || "").trim(),
        sub_unit: String(row[suI] || "").trim()
      };
    }
  }
  return null;
}

/** ========= SESSIONS ========= */
function getSession(sessionId) {
  const sh = getSheet(SHEET_SESSIONS);
  const row = findRowByValue(sh, 1, sessionId);
  if (row === -1) return null;
  const vals = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0];
  return {
    session_id: vals[0],
    user_id: vals[1],
    login_time: vals[2],
    last_seen: vals[3],
    user_agent: vals[4],
  };
}
function touchSession(sessionId) {
  const sh = getSheet(SHEET_SESSIONS);
  const row = findRowByValue(sh, 1, sessionId);
  if (row !== -1) sh.getRange(row, 4).setValue(nowISO());
}

/** ========= WATCH ========= */
function getWatchTotalBySession_(sessionId) {
  const sh = getSheet(SHEET_WATCH);
  const row = findRowByValue(sh, 1, sessionId);
  if (row === -1) return 0;
  return Number(sh.getRange(row, 4).getValue() || 0);
}

/** ========= SCORE/ATTEMPT ========= */
function getUserBestScore_(userId) {
  const sh = getSheet(SHEET_SCORES);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;

  let best = 0;
  for (let i = 1; i < data.length; i++) {
    const uid = String(data[i][1] || "").trim();
    if (uid !== String(userId).trim()) continue;
    const score = Number(data[i][2] || 0);
    if (score > best) best = score;
  }
  return best;
}

function countAttemptsByUser_(userId) {
  const sh = getSheet(SHEET_SCORES);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return 0;

  let count = 0;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][1] || "").trim() === String(userId).trim()) count++;
  }
  return count;
}

/** ========= ROUTER ========= */
function doGet(e)  { return handle(e); }
function doPost(e) { return handle(e); }

function handle(e) {
  const p = getParams_(e);
  const action = p.action || "";
  try {
    if (action === "ping") return jsonOut({ ok: true, time: nowISO() });

    if (action === "login") return apiLogin(p);
    if (action === "status") return apiStatus(p);
    if (action === "log_watch") return apiLogWatch(p);
    if (action === "save_takeaways") return apiSaveTakeaways(p);

    if (action === "get_quiz") return apiGetQuiz(p);
    if (action === "submit_score") return apiSubmitScore(p);
    if (action === "leaderboard") return apiLeaderboard(p);

    return jsonOut({ ok: false, error: "Unknown action" });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

/** ========= ENDPOINTS ========= */
function apiLogin(p) {
  const userKey = p.user || "";
  const password = p.password || "";
  const ua = p.ua || "";

  const user = getUserByCredentials(userKey, password);
  if (!user) return jsonOut({ ok: false, error: "Login gagal. Cek akun/token." });

  const sessionId = makeId("S");
  getSheet(SHEET_SESSIONS).appendRow([sessionId, user.user_id, nowISO(), nowISO(), ua]);

  return jsonOut({ ok: true, session_id: sessionId, user });
}

function apiStatus(p) {
  const sessionId = p.session_id || "";
  const sess = getSession(sessionId);
  if (!sess) return jsonOut({ ok: false, error: "Session tidak valid." });

  const watchTotal = getWatchTotalBySession_(sessionId);
  const qualified = watchTotal >= MIN_WATCH_SECONDS;

  const attemptsUsed = countAttemptsByUser_(sess.user_id);
  const locked = attemptsUsed >= MAX_ATTEMPTS_PER_USER;

  touchSession(sessionId);
  return jsonOut({
    ok: true,
    video_total_seconds: VIDEO_TOTAL_SECONDS,
    min_watch_seconds: MIN_WATCH_SECONDS,
    watch_total: watchTotal,
    qualified,
    attempts_used: attemptsUsed,
    max_attempts: MAX_ATTEMPTS_PER_USER,
    attempt_next: Math.min(MAX_ATTEMPTS_PER_USER, attemptsUsed + 1),
    locked
  });
}

function apiLogWatch(p) {
  const sessionId = p.session_id || "";
  const sess = getSession(sessionId);
  if (!sess) return jsonOut({ ok: false, error: "Session tidak valid." });

  const addSeconds = Math.max(0, Number(p.add_seconds || 0));
  const eventsJson = p.events_json || "";

  const sh = getSheet(SHEET_WATCH);
  // watch_logs: session_id | user_id | video_id | watch_seconds_total | events_json | qualified | updated_at
  const row = findRowByValue(sh, 1, sessionId);

  if (row === -1) {
    const total = addSeconds;
    const qualifiedNow = total >= MIN_WATCH_SECONDS;
    sh.appendRow([sessionId, sess.user_id, VIDEO_ID, total, eventsJson, qualifiedNow, nowISO()]);
  } else {
    const current = Number(sh.getRange(row, 4).getValue() || 0);
    const next = Math.max(0, current + addSeconds);
    const qualifiedNow = next >= MIN_WATCH_SECONDS;

    sh.getRange(row, 4).setValue(next);
    if (eventsJson) sh.getRange(row, 5).setValue(eventsJson);
    sh.getRange(row, 6).setValue(qualifiedNow);
    sh.getRange(row, 7).setValue(nowISO());
  }

  touchSession(sessionId);
  return jsonOut({ ok: true });
}

function apiSaveTakeaways(p) {
  const sessionId = p.session_id || "";
  const sess = getSession(sessionId);
  if (!sess) return jsonOut({ ok: false, error: "Session tidak valid." });

  const text = (p.takeaways_text || "").trim();
  if (text.length < 10) return jsonOut({ ok: false, error: "Takeaways terlalu pendek." });

  getSheet(SHEET_TAKEAWAYS).appendRow([sessionId, sess.user_id, text, nowISO()]);
  touchSession(sessionId);
  return jsonOut({ ok: true });
}

/**
 * questions header required:
 * q_id | question | a | b | c | d | correct | is_active | difficulty(optional)
 * difficulty: easy|medium|hard (case-insensitive). default: medium
 */
function apiGetQuiz(p) {
  const sessionId = p.session_id || "";
  const sess = getSession(sessionId);
  if (!sess) return jsonOut({ ok: false, error: "Session tidak valid." });

  const watchTotal = getWatchTotalBySession_(sessionId);
  if (watchTotal < MIN_WATCH_SECONDS) {
    return jsonOut({ ok: false, error: `Belum memenuhi syarat menonton (min ${MIN_WATCH_SECONDS} detik).` });
  }

  const attemptsUsed = countAttemptsByUser_(sess.user_id);
  if (attemptsUsed >= MAX_ATTEMPTS_PER_USER) {
    return jsonOut({ ok: false, error: "Attempt sudah 3x. Silakan lihat leaderboard." });
  }

  const n = Math.min(20, Math.max(5, Number(p.n || 10)));

  const sh = getSheet(SHEET_QUESTIONS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return jsonOut({ ok: false, error: "Bank soal kosong." });

  const { idx } = idxMap_(data[0]);

  const activeI = idx("is_active");
  const idI = idx("q_id"), qI = idx("question"), aI = idx("a"), bI = idx("b"), cI = idx("c"), dI = idx("d"), corI = idx("correct");
  const diffI = idx("difficulty"); // optional

  if ([activeI,idI,qI,aI,bI,cI,dI,corI].some(i => i === -1)) {
    return jsonOut({ ok:false, error:"Header questions wajib memuat: q_id, question, a,b,c,d, correct, is_active." });
  }

  // build active pool
  let pool = [];
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const active = String(row[activeI] || "").toUpperCase() === "TRUE";
    if (!active) continue;

    const difficulty = (diffI !== -1) ? String(row[diffI] || "medium").trim().toLowerCase() : "medium";

    pool.push({
      q_id: String(row[idI]),
      question: String(row[qI]),
      a: String(row[aI]),
      b: String(row[bI]),
      c: String(row[cI]),
      d: String(row[dI]),
      correct: String(row[corI]).toUpperCase(),
      difficulty
    });
  }
  if (pool.length < n) return jsonOut({ ok:false, error:"Soal aktif kurang." });

  // pick random n
  pool = pool.sort(() => Math.random() - 0.5).slice(0, n);

  // send to client WITHOUT correct & difficulty (difficulty not needed client)
  const clientQuestions = pool.map(x => ({
    q_id: x.q_id,
    question: x.question,
    choices: { A: x.a, B: x.b, C: x.c, D: x.d }
  }));

  // store full key per session for scoring + logging
  // include difficulty so server can score
  const prop = PropertiesService.getScriptProperties();
  prop.setProperty("QUIZKEY_" + sessionId, JSON.stringify(pool.map(x => ({
    q_id: x.q_id,
    correct: x.correct,
    difficulty: x.difficulty
  }))));

  touchSession(sessionId);
  return jsonOut({
    ok: true,
    attempt_no: attemptsUsed + 1,
    max_attempts: MAX_ATTEMPTS_PER_USER,
    questions: clientQuestions
  });
}

/** scoring rules */
function pointsForDifficulty_(difficulty) {
  const d = String(difficulty || "medium").toLowerCase();
  if (d === "easy") return 5;
  if (d === "hard") return 20;
  return 10; // medium default
}

function computeStreakBonus_(correctFlags) {
  // milestone stacking
  let bonus = 0;
  // streak length tracking
  let streak = 0;
  let hit3 = false, hit5 = false, hit10 = false;

  for (let i = 0; i < correctFlags.length; i++) {
    if (correctFlags[i]) {
      streak++;
      if (!hit3 && streak >= 3) { bonus += 5; hit3 = true; }
      if (!hit5 && streak >= 5) { bonus += 10; hit5 = true; }
      if (!hit10 && streak >= 10) { bonus += 100; hit10 = true; }
    } else {
      streak = 0;
    }
  }
  return bonus;
}

/**
 * submit_score:
 * - validates attempt remaining
 * - calculates per-question score from difficulty + correctness
 * - adds streak bonus
 * - writes:
 *   - scores sheet (for leaderboard): total_score + meta
 *   - answer_logs sheet (detail per question)
 */
function apiSubmitScore(p) {
  const sessionId = p.session_id || "";
  const sess = getSession(sessionId);
  if (!sess) return jsonOut({ ok:false, error:"Session tidak valid." });

  const watchTotal = getWatchTotalBySession_(sessionId);
  if (watchTotal < MIN_WATCH_SECONDS) {
    return jsonOut({ ok:false, error:`Belum memenuhi syarat menonton (min ${MIN_WATCH_SECONDS} detik).` });
  }

  const attemptsUsed = countAttemptsByUser_(sess.user_id);
  if (attemptsUsed >= MAX_ATTEMPTS_PER_USER) {
    return jsonOut({ ok:false, error:`Attempt sudah mencapai ${MAX_ATTEMPTS_PER_USER}x.` });
  }
  const attemptNo = attemptsUsed + 1;

  const duration = Math.max(0, Number(p.duration_seconds || 0));

  const prop = PropertiesService.getScriptProperties();
  const keyStr = prop.getProperty("QUIZKEY_" + sessionId);
  if (!keyStr) return jsonOut({ ok:false, error:"Quiz key tidak ditemukan. Ambil quiz dulu." });

  const keyArr = JSON.parse(keyStr); // [{q_id, correct, difficulty}]
  const keyMap = {};
  keyArr.forEach(x => keyMap[String(x.q_id)] = { correct: String(x.correct).toUpperCase(), difficulty: x.difficulty });

  let answers;
  try { answers = JSON.parse(p.answers_json || "[]"); }
  catch (_) { return jsonOut({ ok:false, error:"Format answers_json tidak valid." }); }

  // preserve order as keyArr (which is question order)
  const ordered = keyArr.map(k => {
    const found = (answers || []).find(a => String(a.q_id) === String(k.q_id)) || {};
    return { q_id: String(k.q_id), answer: String(found.answer || "").toUpperCase() };
  });

  let correctCount = 0;
  const perScores = [];
  const correctFlags = [];

  for (let i = 0; i < ordered.length; i++) {
    const qid = ordered[i].q_id;
    const ans = ordered[i].answer;
    const meta = keyMap[qid] || { correct:"", difficulty:"medium" };

    const isCorrect = (ans && meta.correct && ans === meta.correct);
    correctFlags.push(!!isCorrect);

    if (isCorrect) {
      correctCount++;
      perScores.push(pointsForDifficulty_(meta.difficulty));
    } else {
      perScores.push(0);
    }
  }

  const totalQuestions = keyArr.length;
  const baseScore = perScores.reduce((a,b)=>a+b,0);
  const bonusScore = computeStreakBonus_(correctFlags);
  const totalScore = baseScore + bonusScore;

  // Append to scores (leaderboard uses this)
  // scores: session_id | user_id | score | correct_count | total_questions | duration_seconds | submitted_at | attempt_no | base_score | bonus_score
  const shScores = getSheet(SHEET_SCORES);
  shScores.appendRow([sessionId, sess.user_id, totalScore, correctCount, totalQuestions, duration, nowISO(), attemptNo, baseScore, bonusScore]);

  // Need user nipp for answer log
  const userInfo = getUserInfoById_(sess.user_id); // {nipp, unit, sub_unit, name}
  const nipp = userInfo?.nipp || "";

  // Append to answer_logs (wide row)
  ensureAnswerLogHeader_(); // create header if empty
  const shAns = getSheet(SHEET_ANSWERS);

  const row = [];
  row.push(nowISO(), sess.user_id, nipp, attemptNo, sessionId, duration);

  // q1..q10 (or up to 20)
  for (let i = 0; i < ordered.length; i++) {
    row.push(ordered[i].q_id, ordered[i].answer, perScores[i]);
  }
  // pad to 10 if quiz < 10
  for (let i = ordered.length; i < 10; i++) {
    row.push("", "", "");
  }

  row.push(baseScore, bonusScore, totalScore);
  shAns.appendRow(row);

  touchSession(sessionId);

  const bestScore = getUserBestScore_(sess.user_id);
  const attemptsUsedNow = attemptsUsed + 1;

  return jsonOut({
    ok:true,
    attempt_no: attemptNo,
    attempts_used: attemptsUsedNow,
    max_attempts: MAX_ATTEMPTS_PER_USER,
    locked: attemptsUsedNow >= MAX_ATTEMPTS_PER_USER,
    base_score: baseScore,
    bonus_score: bonusScore,
    total_score: totalScore,
    correctCount,
    total: totalQuestions,
    best_score: bestScore
  });
}

/** users info by id for logs/leaderboard */
function getUserInfoById_(userId) {
  const sh = getSheet(SHEET_USERS);
  const data = sh.getDataRange().getValues();
  if (data.length < 2) return null;
  const { idx } = idxMap_(data[0]);

  const idI = idx("user_id");
  const nmI = idx("name");
  const nippI = idx("nipp");
  const unI = idx("unit");
  const suI = idx("sub_unit");
  const acI = idx("is_active");

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const uid = String(row[idI] || "").trim();
    if (uid !== String(userId).trim()) continue;
    if (acI !== -1) {
      const active = String(row[acI] || "").toUpperCase() === "TRUE";
      if (!active) return null;
    }
    return {
      name: String(row[nmI] || uid),
      nipp: (nippI !== -1) ? String(row[nippI] || "").trim() : "",
      unit: String(row[unI] || "-"),
      sub_unit: String(row[suI] || "-")
    };
  }
  return null;
}

function ensureAnswerLogHeader_() {
  const sh = getSheet(SHEET_ANSWERS);
  if (sh.getLastRow() > 0) return;

  const header = ["created_at","user_id","nipp","attempt_no","session_id","duration_seconds"];
  for (let i = 1; i <= 10; i++) {
    header.push(`q${i}_id`, `q${i}_ans`, `q${i}_score`);
  }
  header.push("base_score","bonus_score","total_score");
  sh.appendRow(header);
}

/**
 * leaderboard:
 * - best attempt per user: max score, tie min duration
 * - top 5 units by TOP SCORE (max best score in unit)
 * - group ranking:
 *    completion% = submitters/active
 *    top_score = max best score in group
 */
function apiLeaderboard(p) {
  const reqGroupBy = String(p.group_by || "unit").toLowerCase();
  const groupBy = (reqGroupBy === "sub_unit") ? "sub_unit" : "unit";

  // build active users + group sizes
  const shUsers = getSheet(SHEET_USERS);
  const usersVals = shUsers.getDataRange().getValues();
  if (usersVals.length < 2) return jsonOut({ ok:true, group_by:groupBy, top:[], fast_thinker_uids:[], top5_units:[], top_groups:[] });

  const { idx } = idxMap_(usersVals[0]);
  const uidI = idx("user_id"), nmI = idx("name"), unI = idx("unit"), suI = idx("sub_unit"), acI = idx("is_active");

  if ([uidI,nmI,unI,suI,acI].some(i=>i===-1)) {
    return jsonOut({ ok:false, error:"Header users wajib memuat: user_id, name, unit, sub_unit, is_active." });
  }

  const userMap = {};
  const groupActiveCount = {}; // group -> active users
  const unitActiveCount = {};  // unit -> active users

  for (let r = 1; r < usersVals.length; r++) {
    const row = usersVals[r];
    const active = String(row[acI] || "").toUpperCase() === "TRUE";
    if (!active) continue;

    const uid = String(row[uidI] || "").trim();
    if (!uid) continue;

    const name = String(row[nmI] || uid);
    const unit = String(row[unI] || "-");
    const sub_unit = String(row[suI] || "-");

    userMap[uid] = { name, unit, sub_unit };

    const g = (groupBy === "sub_unit") ? sub_unit : unit;

    groupActiveCount[g] = (groupActiveCount[g] || 0) + 1;
    unitActiveCount[unit] = (unitActiveCount[unit] || 0) + 1;
  }

  // best attempt per user from scores
  const shScores = getSheet(SHEET_SCORES);
  const scoresVals = shScores.getDataRange().getValues();
  if (scoresVals.length < 2) return jsonOut({ ok:true, group_by:groupBy, top:[], fast_thinker_uids:[], top5_units:[], top_groups:[] });

  const best = {}; // uid -> {score, duration}
  for (let i = 1; i < scoresVals.length; i++) {
    const row = scoresVals[i];
    const uid = String(row[1] || "").trim();
    if (!uid || !userMap[uid]) continue;

    const score = Number(row[2] || 0);
    const dur = Number(row[5] || 0);

    const cur = best[uid];
    if (!cur) best[uid] = { user_id: uid, score, duration_seconds: dur };
    else {
      if (score > cur.score) best[uid] = { user_id: uid, score, duration_seconds: dur };
      else if (score === cur.score && dur < cur.duration_seconds) best[uid] = { user_id: uid, score, duration_seconds: dur };
    }
  }

  const list = Object.values(best).map(x => {
    const u = userMap[x.user_id];
    return {
      user_id: x.user_id,
      name: u.name,
      unit: u.unit,
      sub_unit: u.sub_unit,
      score: x.score,
      duration_seconds: x.duration_seconds
    };
  });

  // top 10 individual
  const sortedIndividuals = list.slice().sort((a,b)=> (b.score-a.score) || (a.duration_seconds-b.duration_seconds));
  const top = sortedIndividuals.slice(0,10).map((x,i)=>({
    rank:i+1, user_id:x.user_id, name:x.name, unit:x.unit, sub_unit:x.sub_unit, score:x.score, duration_seconds:x.duration_seconds
  }));

  // Fast Thinker: fastest duration for same score within top 10
  let fastThinkerUids = [];
  if (top.length) {
    const minDurByScore = {};
    top.forEach(r => {
      if (minDurByScore[r.score] == null || r.duration_seconds < minDurByScore[r.score]) {
        minDurByScore[r.score] = r.duration_seconds;
      }
    });
    fastThinkerUids = top.filter(r => r.duration_seconds === minDurByScore[r.score]).map(r => r.user_id);
  }

  // Top 5 unit by TOP SCORE in that unit
  const unitTop = {};
  list.forEach(x => {
    const u = x.unit || "-";
    unitTop[u] = Math.max(unitTop[u] || 0, x.score);
  });
  const top5Units = Object.entries(unitTop).sort((a,b)=>b[1]-a[1]).slice(0,5)
    .map((kv,i)=>({ rank:i+1, unit:kv[0], top_score:kv[1] }));

  // Group ranking: completion% and top_score
  const groupSubmitters = {}; // group -> set count
  const groupTopScore = {};   // group -> max best score

  list.forEach(x => {
    const g = (groupBy === "sub_unit") ? x.sub_unit : x.unit;
    groupSubmitters[g] = (groupSubmitters[g] || 0) + 1;
    groupTopScore[g] = Math.max(groupTopScore[g] || 0, x.score);
  });

  const groups = Object.keys(groupActiveCount).map(g => {
    const active = groupActiveCount[g] || 0;
    const submit = groupSubmitters[g] || 0;
    const pct = active > 0 ? Math.round((submit/active)*100) : 0;
    const topScore = groupTopScore[g] || 0;
    return { group:g, completion_pct:pct, top_score:topScore };
  });

  // sort: by top_score desc, then completion_pct desc
  const topGroups = groups.sort((a,b)=> (b.top_score-a.top_score) || (b.completion_pct-a.completion_pct))
    .slice(0,10)
    .map((x,i)=>({ rank:i+1, group:x.group, completion_pct:x.completion_pct, top_score:x.top_score }));

  return jsonOut({
    ok:true,
    group_by: groupBy,
    top,
    fast_thinker_uids: fastThinkerUids,
    top5_units: top5Units,
    top_groups: topGroups
  });
}
