/** ========= CONFIG ========= */
const API_URL = "https://script.google.com/macros/s/AKfycbw7n1PsG712PmW6ioF6SpUa2Tey-SuvqPcqIom_tTbJ8NZQQ4b4pKw2eLZWapTVO_q8FQ/exec"; // <-- isi dari Apps Script deployment
const VIDEO_ID = "TOWNHALL_2026_DIRUT";

// Durasi video: 01:14:29:10  -> treat as 01:14:29
const VIDEO_TOTAL_SECONDS = 1*3600 + 14*60 + 29; // 4469
const MIN_WATCH_PERCENT = 0.60;
const MIN_WATCH_SECONDS = Math.ceil(VIDEO_TOTAL_SECONDS * MIN_WATCH_PERCENT); // 2682

const MAX_SUBMISSIONS_PER_USER = 3;

/** ========= State ========= */
let sessionId = localStorage.getItem("session_id") || "";
let user = JSON.parse(localStorage.getItem("user") || "null");

// YouTube tracking (perkiraan): tambah 1 detik saat video sedang play
let ytPlayer = null;
let watchSeconds = Number(localStorage.getItem("watch_seconds") || 0);
let watchTick = null;

let takeawaysSaved = false;

// Quiz state
let quiz = [];
let quizIdx = 0;
let answers = [];
let qTimer = 20;
let timerInt = null;
let quizStartTs = 0;

/** ========= DOM ========= */
const vLogin   = document.getElementById("view-login");
const vHub     = document.getElementById("view-hub");
const vQuiz    = document.getElementById("view-quiz");
const vResult  = document.getElementById("view-result");

const loginMsg = document.getElementById("login-msg");
const hubMsg   = document.getElementById("hub-msg");
const quizMsg  = document.getElementById("quiz-msg");

const elWatchSec = document.getElementById("watch-sec");
const elWatchMin = document.getElementById("watch-min");
const elWatchStatus = document.getElementById("watch-status");
const userBadge = document.getElementById("user-badge");

elWatchMin.textContent = WATCH_MIN_SECONDS;

/** ========= Utils ========= */
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }

function setMsg(el, text, type=""){
  el.textContent = text || "";
  el.className = "msg " + (type || "");
}

async function api(action, params = {}) {
  const url = new URL(API_URL);
  url.searchParams.set("action", action);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), { method: "GET" });
  const json = await res.json();
  return json;
}

function goto(view){
  [vLogin, vHub, vQuiz, vResult].forEach(hide);
  show(view);
}

async function refreshStatus(){
  const st = await api("status", { session_id: sessionId });
  if(!st.ok) return;

  watchSeconds = Number(st.watch_total || watchSeconds);
  localStorage.setItem("watch_seconds", String(watchSeconds));

  elWatchSec.textContent = String(watchSeconds);
  elWatchMin.textContent = String(st.min_watch_seconds);

  // lock setelah submit
  if(st.locked){
    takeawaysSaved = true; // supaya tombol quiz tidak ngaco
    document.getElementById("btn-start-quiz").disabled = true;
    document.getElementById("btn-start-quiz").textContent = "Quiz sudah disubmit";
  }
  updateQualifiedUI();
  unlockQuizIfReady();
}

/** ========= Login Flow ========= */
document.getElementById("btn-login").addEventListener("click", async () => {
  setMsg(loginMsg, "Memeriksa akun...", "");
  const u = document.getElementById("login-user").value.trim();
  const p = document.getElementById("login-pass").value.trim();
  if(!u || !p) return setMsg(loginMsg, "Lengkapi user dan password/token.", "bad");

  const json = await api("login", { user: u, password: p, ua: navigator.userAgent });
  if(!json.ok) return setMsg(loginMsg, json.error || "Login gagal.", "bad");

  sessionId = json.session_id;
  user = json.user;

  localStorage.setItem("session_id", sessionId);
  localStorage.setItem("user", JSON.stringify(user));

  setMsg(loginMsg, "Login berhasil. Mengarahkan...", "ok");
  await refreshStatus();
  initHub();
});

document.getElementById("btn-logout").addEventListener("click", () => {
  localStorage.removeItem("session_id");
  localStorage.removeItem("user");
  localStorage.removeItem("watch_seconds");
  sessionId = "";
  user = null;
  watchSeconds = 0;
  takeawaysSaved = false;
  stopWatchTick();
  goto(vLogin);
});

/** ========= Hub ========= */
function initHub(){
  if(!sessionId || !user) return goto(vLogin);

  userBadge.textContent = `${user.name} · ${user.unit}`;
  elWatchSec.textContent = String(watchSeconds);
  updateQualifiedUI();

  goto(vHub);
}

document.getElementById("btn-save-takeaways").addEventListener("click", async () => {
  const text = document.getElementById("takeaways").value.trim();
  if(text.length < 10) return setMsg(hubMsg, "Takeaways terlalu pendek. Tambahkan poin yang lebih jelas.", "bad");

  setMsg(hubMsg, "Menyimpan takeaways...", "");
  const json = await api("save_takeaways", { session_id: sessionId, takeaways_text: text });
  if(!json.ok) return setMsg(hubMsg, json.error || "Gagal menyimpan.", "bad");

  takeawaysSaved = true;
  setMsg(hubMsg, "Takeaways tersimpan ✅", "ok");
  unlockQuizIfReady();
});

document.getElementById("btn-start-quiz").addEventListener("click", async () => {
  await startQuiz();
});

/** ========= YouTube API ========= */
window.onYouTubeIframeAPIReady = function(){
  ytPlayer = new YT.Player("yt", {
    events: {
      onStateChange: onYtStateChange
    }
  });
};

function onYtStateChange(e){
  // 1 = playing, 2 = paused, 0 = ended
  if(e.data === 1) startWatchTick();
  else stopWatchTick();
}

function startWatchTick(){
  if(watchTick) return;
  watchTick = setInterval(async () => {
    watchSeconds += 1;
    localStorage.setItem("watch_seconds", String(watchSeconds));
    elWatchSec.textContent = String(watchSeconds);

    // kirim batch setiap 5 detik supaya hemat request
    if(watchSeconds % 5 === 0){
      const qualified = watchSeconds >= WATCH_MIN_SECONDS;
      await api("log_watch", {
        session_id: sessionId,
        add_seconds: 5,
        qualified: qualified ? "true" : "false",
        events_json: "" // bisa diisi kalau mau simpan event detail
      });
      updateQualifiedUI();
      unlockQuizIfReady();
    }
  }, 1000);
}

function stopWatchTick(){
  if(!watchTick) return;
  clearInterval(watchTick);
  watchTick = null;
}

function updateQualifiedUI(){
  const qualified = watchSeconds >= WATCH_MIN_SECONDS;
  elWatchStatus.textContent = qualified ? "Syarat nonton terpenuhi ✅" : "Belum memenuhi syarat";
  elWatchStatus.style.borderColor = qualified ? "rgba(52,211,153,.55)" : "rgba(255,255,255,.12)";
  elWatchStatus.style.color = qualified ? "rgba(52,211,153,.95)" : "rgba(255,255,255,.7)";
}

async function unlockQuizIfReady(){
  const st = await api("status", { session_id: sessionId });
  const qualified = st.ok ? st.qualified : (watchSeconds >= WATCH_MIN_SECONDS);
  const locked = st.ok ? st.locked : false;

  const btn = document.getElementById("btn-start-quiz");
  btn.disabled = !(qualified && takeawaysSaved && !locked);
}

/** ========= Quiz ========= */
document.getElementById("btn-cancel-quiz").addEventListener("click", () => {
  stopTimer();
  goto(vHub);
});

document.getElementById("btn-back-hub").addEventListener("click", () => {
  goto(vHub);
});

async function startQuiz(){
  setMsg(hubMsg, "Menyiapkan quiz...", "");
  const json = await api("get_quiz", { session_id: sessionId, n: 10 });
  if(!json.ok) return setMsg(hubMsg, json.error || "Gagal memuat quiz.", "bad");

  quiz = json.questions;
  quizIdx = 0;
  answers = [];
  quizStartTs = Date.now();

  goto(vQuiz);
  renderQuestion();
}

function renderQuestion(){
  setMsg(quizMsg, "", "");
  const box = document.getElementById("q-box");
  const q = quiz[quizIdx];
  if(!q){
    return finishQuiz();
  }

  document.getElementById("btn-next").disabled = true;

  box.innerHTML = `
    <div class="muted">Soal ${quizIdx+1} dari ${quiz.length}</div>
    <div style="font-size:18px;font-weight:800;margin-top:6px">${escapeHtml(q.question)}</div>
    ${renderChoice("A", q.choices.A)}
    ${renderChoice("B", q.choices.B)}
    ${renderChoice("C", q.choices.C)}
    ${renderChoice("D", q.choices.D)}
  `;

  box.querySelectorAll(".choice").forEach(el => {
    el.addEventListener("click", () => {
      box.querySelectorAll(".choice").forEach(x => x.classList.remove("selected"));
      el.classList.add("selected");
      document.getElementById("btn-next").disabled = false;
      const ans = el.getAttribute("data-choice");
      // set temp answer
      answers[quizIdx] = { q_id: q.q_id, answer: ans };
    });
  });

  // timer
  startTimer(20, () => {
    // auto next jika waktu habis (jawaban kosong)
    if(!answers[quizIdx]) answers[quizIdx] = { q_id: q.q_id, answer: "" };
    nextQuestion();
  });

  document.getElementById("btn-next").onclick = () => nextQuestion();
}

function nextQuestion(){
  stopTimer();
  quizIdx += 1;
  renderQuestion();
}

function startTimer(sec, onEnd){
  qTimer = sec;
  document.getElementById("timer").textContent = String(qTimer);
  timerInt = setInterval(() => {
    qTimer -= 1;
    document.getElementById("timer").textContent = String(qTimer);
    if(qTimer <= 0){
      stopTimer();
      onEnd();
    }
  }, 1000);
}
function stopTimer(){
  if(timerInt) clearInterval(timerInt);
  timerInt = null;
}

async function finishQuiz(){
  const durationSeconds = Math.round((Date.now() - quizStartTs) / 1000);
  setMsg(quizMsg, "Menghitung skor...", "");

  const json = await api("submit_score", {
    session_id: sessionId,
    answers_json: JSON.stringify(answers),
    duration_seconds: String(durationSeconds)
  });

  localStorage.setItem("quiz_locked", "true");
  if(!json.ok) return setMsg(quizMsg, json.error || "Gagal submit skor.", "bad");

  document.getElementById("btn-start-quiz").disabled = true;
  document.getElementById("btn-start-quiz").textContent = "Quiz sudah disubmit";
  goto(vResult);
  document.getElementById("result-box").innerHTML = `
    <div style="font-size:18px;font-weight:900">Skor kamu: ${json.score}</div>
    <div class="muted">Benar: ${json.correctCount}/${json.total} · Durasi: ${durationSeconds}s</div>
  `;

  await loadLeaderboard();
}

function apiLeaderboard(p) {
  // Supported: group_by=unit | sub_unit
  const groupBy = (p.group_by || "unit").toLowerCase();
  const validGroupBy = (groupBy === "sub_unit") ? "sub_unit" : "unit";

  /** ---------- Build user map (no subholding/regional) ---------- */
  const shUsers = getSheet(SHEET_USERS);
  const users = shUsers.getDataRange().getValues();
  if (users.length < 2) {
    return jsonOut({ ok: true, top: [], fast_thinker_uids: [], top5_units: [], group_by: validGroupBy, top_groups: [] });
  }

  const uh = users[0].map(String);
  const idx = (name) => uh.indexOf(name);

  const uidI = idx("user_id");
  const nmI  = idx("name");
  const unI  = idx("unit");
  const suI  = idx("sub_unit");

  const userMap = {};
  for (let r = 1; r < users.length; r++) {
    const uid = String(users[r][uidI] || "").trim();
    if (!uid) continue;
    userMap[uid] = {
      name: String(users[r][nmI] || uid),
      unit: String(users[r][unI] || "-"),
      sub_unit: String(users[r][suI] || "-")
    };
  }

  /** ---------- Read scores + keep BEST per user ---------- */
  const shScores = getSheet(SHEET_SCORES);
  const scores = shScores.getDataRange().getValues();
  if (scores.length < 2) {
    return jsonOut({ ok: true, top: [], fast_thinker_uids: [], top5_units: [], group_by: validGroupBy, top_groups: [] });
  }

  // scores header assumed:
  // session_id, user_id, score, correct_count, total_questions, duration_seconds, submitted_at
  const best = {}; // user_id -> { user_id, score, duration_seconds }
  for (let i = 1; i < scores.length; i++) {
    const row = scores[i];
    const uid = String(row[1] || "").trim();
    if (!uid) continue;

    const sc  = Number(row[2] || 0);
    const dur = Number(row[5] || 0);

    const cur = best[uid];
    if (!cur) {
      best[uid] = { user_id: uid, score: sc, duration_seconds: dur };
    } else {
      // Best logic: higher score wins; tie -> faster duration wins
      if (sc > cur.score) best[uid] = { user_id: uid, score: sc, duration_seconds: dur };
      else if (sc === cur.score && dur < cur.duration_seconds) best[uid] = { user_id: uid, score: sc, duration_seconds: dur };
    }
  }

  /** ---------- Enrich best list with user meta ---------- */
  const list = Object.values(best).map(x => {
    const u = userMap[x.user_id] || { name: x.user_id, unit: "-", sub_unit: "-" };
    const groupVal = (validGroupBy === "sub_unit") ? u.sub_unit : u.unit;
    return {
      user_id: x.user_id,
      name: u.name,
      unit: u.unit,
      sub_unit: u.sub_unit,
      score: x.score,
      duration_seconds: x.duration_seconds,
      group: groupVal
    };
  });

  /** ---------- Top 10 Individual ---------- */
  const top = list
    .slice()
    .sort((a, b) => (b.score - a.score) || (a.duration_seconds - b.duration_seconds))
    .slice(0, 10)
    .map((x, i) => ({
      rank: i + 1,
      user_id: x.user_id,
      name: x.name,
      unit: x.unit,
      sub_unit: x.sub_unit,
      score: x.score,
      duration_seconds: x.duration_seconds
    }));

  /** ---------- Badge: Fast Thinker (fastest for each score bucket within Top 10) ---------- */
  let fastThinkerUids = [];
  if (top.length) {
    const minDurByScore = {};
    top.forEach(r => {
      const s = r.score;
      const d = r.duration_seconds;
      if (minDurByScore[s] == null || d < minDurByScore[s]) minDurByScore[s] = d;
    });
    fastThinkerUids = top
      .filter(r => r.duration_seconds === minDurByScore[r.score])
      .map(r => r.user_id);
  }

  /** ---------- Badge board: Top 5 Unit (aggregate sum of BEST scores by unit) ---------- */
  const unitAgg = {}; // unit -> sum(best score)
  list.forEach(x => {
    const u = x.unit || "-";
    unitAgg[u] = (unitAgg[u] || 0) + x.score;
  });
  const top5Units = Object.entries(unitAgg)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map((kv, i) => ({
      rank: i + 1,
      unit: kv[0],
      total_score: kv[1]
    }));

  /** ---------- Group leaderboard: per unit OR per sub_unit (sum of BEST scores) ---------- */
  const groupAgg = {}; // group -> { total_score, members }
  list.forEach(x => {
    const g = x.group || "-";
    if (!groupAgg[g]) groupAgg[g] = { group: g, total_score: 0, members: 0 };
    groupAgg[g].total_score += x.score;
    groupAgg[g].members += 1;
  });

  const topGroups = Object.values(groupAgg)
    .sort((a, b) => b.total_score - a.total_score)
    .slice(0, 10)
    .map((x, i) => ({
      rank: i + 1,
      group: x.group,
      total_score: x.total_score,
      members: x.members
    }));

  return jsonOut({
    ok: true,
    top,
    fast_thinker_uids: fastThinkerUids,
    top5_units: top5Units,
    group_by: validGroupBy,
    top_groups: topGroups
  });
}

function renderChoice(letter, text){
  return `
    <div class="choice" data-choice="${letter}">
      <div class="pill"><b>${letter}</b></div>
      <div>${escapeHtml(text || "")}</div>
    </div>
  `;
}

function escapeHtml(str){
  return String(str)
    .replaceAll("&","&amp;").replaceAll("<","&lt;")
    .replaceAll(">","&gt;").replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

/** ========= Boot ========= */
(function boot(){
  if(sessionId && user) initHub();
  else goto(vLogin);
})();