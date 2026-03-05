/**
 * app.js v10 - OneDrive/SharePoint video (HTML5 <video>)
 * - Track watched seconds via unique second stamps while playing (anti-skip ringan)
 * - Send incremental add_seconds to Apps Script action=log_watch
 */

const API_URL = "https://script.google.com/macros/s/AKfycbx09vBniHE2vISKuPPCwZluhhgJET7ZK8_eDdmUnQiQfRV9dKdJ53QdB19Yz4GgL0hSAw/exec";

// Share link (viewer). Akan dicoba jadi direct stream url sederhana.
const ONEDRIVE_SHARE_URL =
  // "https://pelindo2-my.sharepoint.com/:v:/g/personal/pmo_pelindo_co_id/IQA7HhaxUZQSSJQ5Yck7x9PEAY8ojY5w6x2HADIY57Btw0A?e=ASU4xN&nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJTdHJlYW1XZWJBcHAiLCJyZWZlcnJhbFZpZXciOiJTaGFyZURpYWxvZy1MaW5rIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXcifX0%3D";
  "https://pelindo2-my.sharepoint.com/:v:/g/personal/pmo_pelindo_co_id/IQAT-nk2KETNQLz3J93mxRr5AQA7Rema50rmnWtP2zSRhXw?e=D5PI9a&nav=eyJyZWZlcnJhbEluZm8iOnsicmVmZXJyYWxBcHAiOiJTdHJlYW1XZWJBcHAiLCJyZWZlcnJhbFZpZXciOiJTaGFyZURpYWxvZy1MaW5rIiwicmVmZXJyYWxBcHBQbGF0Zm9ybSI6IldlYiIsInJlZmVycmFsTW9kZSI6InZpZXcifX0%3D";
const QUIZ_QUESTIONS = 10;
const QUIZ_TIMER_SECONDS = 20;

// watch batching
const WATCH_SEND_EVERY_SECONDS = 5;

let sessionId = localStorage.getItem("session_id") || "";
let user = safeJson(localStorage.getItem("user"));
let takeawaysSaved = false;

// status cache
let statusCache = null;
let lastStatusAt = 0;
let watchSeconds = Number(localStorage.getItem("watch_seconds") || 0);
let attemptNo = 0;

// video tracking
let videoEl = null;
let watchedSecondSet = new Set(); // unique seconds watched in this page session
let lastTime = null;
let pendingAdd = 0;
let sendTick = null;

// quiz state
let quiz = [];
let quizIdx = 0;
let answers = [];
let timerInt = null;
let qTimer = QUIZ_TIMER_SECONDS;
let quizStartTs = 0;

let activeGroupBy = "unit";

/** error trap */
window.addEventListener("error", (e) => {
  const el = $("#login-msg") || $("#hub-msg") || $("#quiz-msg") || $("#video-msg");
  if (el) { el.textContent = "JS Error: " + (e.message || "Unknown"); el.className = "msg bad"; }
  console.error(e);
});
window.addEventListener("unhandledrejection", (e) => {
  const el = $("#login-msg") || $("#hub-msg") || $("#quiz-msg") || $("#video-msg");
  const msg = e.reason?.message ? e.reason.message : String(e.reason || "Unknown");
  if (el) { el.textContent = "Promise Error: " + msg; el.className = "msg bad"; }
  console.error(e);
});

/** DOM */
function $(sel){ return document.querySelector(sel); }
function safeJson(str){ try{ return str ? JSON.parse(str) : null; } catch { return null; } }
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }
function goto(view){ [$("#view-login"),$("#view-hub"),$("#view-quiz"),$("#view-leaderboard")].forEach(hide); show(view); }
function setMsg(el, text, type=""){ if(!el) return; el.textContent = text || ""; el.className = "msg " + (type||""); }
function escapeHtml(str){
  return String(str ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }
function toPercent(watchSec, totalSec){
  if(!totalSec || totalSec <= 0) return 0;
  return clamp(Math.round((watchSec/totalSec)*100), 0, 100);
}

/** api */
async function api(action, params={}){
  try{
    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { method:"GET", cache:"no-store" });
    const text = await res.text();
    let json;
    try{ json = JSON.parse(text); } catch { return { ok:false, error:"Response bukan JSON: " + text.slice(0,180) }; }
    return json;
  } catch(err){
    return { ok:false, error:"Fetch error: " + String(err) };
  }
}

async function fetchStatus(force=false){
  const now = Date.now();
  if(!force && statusCache && (now - lastStatusAt) < 5000) return statusCache;

  const st = await api("status", { session_id: sessionId });
  if(st?.ok){
    statusCache = st;
    lastStatusAt = now;
    watchSeconds = Number(st.watch_total || 0);
    localStorage.setItem("watch_seconds", String(watchSeconds));
    attemptNo = Number(st.attempt_next || 1);
  }
  return st;
}

function updateAttemptUI(st){
  const used = Number(st.attempts_used || 0);
  const max = Number(st.max_attempts || 3);
  const next = Number(st.attempt_next || (used+1));
  const locked = !!st.locked;

  $("#attempt-badge").textContent = locked ? `Quiz attempt: ${used}/${max} (LOCKED)` : `Quiz attempt: ${used}/${max} (next: ${next})`;
  $("#quiz-attempt").textContent = `Attempt: ${next} / ${max}`;

  const btn = $("#btn-start-quiz");
  if(st.locked){
    btn.disabled = true;
    btn.textContent = "Quiz sudah mencapai 3 attempt";
  } else {
    btn.textContent = "Mulai Quiz";
  }
}

function updateWatchUI(st){
  const total = Number(st?.video_total_seconds || 0);
  const minW  = Number(st?.min_watch_seconds || 0);

  $("#watch-sec").textContent = String(watchSeconds);
  $("#watch-min").textContent = String(minW);

  const pct = toPercent(watchSeconds, total);
  $("#progress-fill").style.width = pct + "%";
  $("#progress-text").textContent = `${pct}% dari total durasi video`;

  const qualified = !!st?.qualified;
  const tag = $("#watch-status");
  tag.textContent = qualified ? "Syarat nonton terpenuhi ✅" : "Belum memenuhi syarat";
  tag.style.borderColor = qualified ? "rgba(52,211,153,.55)" : "rgba(255,255,255,.12)";
  tag.style.color = qualified ? "rgba(52,211,153,.95)" : "rgba(255,255,255,.78)";
}

async function unlockQuizIfReady(){
  const btn = $("#btn-start-quiz");
  const st = await fetchStatus();

  if(!st?.ok){ btn.disabled = true; return; }

  updateAttemptUI(st);

  if(st.locked){
    btn.disabled = true;
    return;
  }

  btn.disabled = !(st.qualified && takeawaysSaved);
}

/** ====== OneDrive video ====== */
function buildMaybeDirectUrl(shareUrl){
  // Banyak tenant OneDrive/SharePoint menerima &download=1 untuk direct file.
  // Jika gagal, kamu perlu pakai "Embed code" atau direct mp4 link.
  const u = new URL(shareUrl);
  u.searchParams.set("download", "1");
  return u.toString();
}

function initVideo(){
  videoEl = $("#video");
  const srcEl = $("#video-src");
  const msgEl = $("#video-msg");

  if(!videoEl || !srcEl){
    console.warn("Video DOM not found");
    return;
  }

  // Set source
  const candidate = buildMaybeDirectUrl(ONEDRIVE_SHARE_URL);
  srcEl.src = candidate;
  videoEl.load();

  setMsg(msgEl, "", "");

  // Start sending batched watch logs when playing
  videoEl.addEventListener("play", () => startSendTick());
  videoEl.addEventListener("pause", () => flushSend());
  videoEl.addEventListener("ended", () => flushSend());

  // detect error
  videoEl.addEventListener("error", () => {
    setMsg(msgEl, "Video gagal dimuat. Link kemungkinan bukan direct mp4. Ambil Embed code / direct link file mp4 dari SharePoint.", "bad");
  });

  // Track unique seconds while playing
  videoEl.addEventListener("timeupdate", () => {
    if(!sessionId) return;
    if(videoEl.paused || videoEl.seeking) return;

    const t = videoEl.currentTime || 0;

    // Anti-seek ringan: jika loncat jauh, jangan dihitung pada tick ini
    if(lastTime != null && Math.abs(t - lastTime) > 1.75){
      lastTime = t;
      return;
    }
    lastTime = t;

    const sec = Math.floor(t);
    if(sec < 0) return;
    if(!watchedSecondSet.has(sec)){
      watchedSecondSet.add(sec);
      pendingAdd += 1;
    }
  });

  // Optional: show duration from metadata (untuk debugging)
  videoEl.addEventListener("loadedmetadata", () => {
    const d = Number(videoEl.duration || 0);
    if(d && d > 1){
      setMsg(msgEl, "Video siap diputar ✅", "ok");
    }
  });
}

function startSendTick(){
  if(sendTick) return;
  sendTick = setInterval(async () => {
    try{
      if(pendingAdd >= WATCH_SEND_EVERY_SECONDS){
        await sendWatchIncrement();
      }
    } catch(err){
      console.error(err);
    }
  }, 1000);
}

async function flushSend(){
  if(sendTick){ clearInterval(sendTick); sendTick = null; }
  await sendWatchIncrement(true);
}

async function sendWatchIncrement(force=false){
  const add = Math.floor(pendingAdd);
  if(add <= 0 && !force) return;

  if(add > 0){
    pendingAdd -= add;
    const r = await api("log_watch", { session_id: sessionId, add_seconds: String(add), events_json: "" });
    if(!r?.ok){
      // put back if failed
      pendingAdd += add;
      console.warn("log_watch failed:", r?.error);
      return;
    }
  }

  const st = await fetchStatus(true);
  if(st?.ok){
    updateWatchUI(st);
    updateAttemptUI(st);
    await unlockQuizIfReady();
  }
}

/** auth */
function logout(){
  localStorage.removeItem("session_id");
  localStorage.removeItem("user");
  localStorage.removeItem("watch_seconds");

  sessionId = "";
  user = null;
  takeawaysSaved = false;
  statusCache = null;
  lastStatusAt = 0;

  stopTimer();
  flushSend().catch(()=>{});
  goto($("#view-login"));
}
$("#btn-logout")?.addEventListener("click", logout);
$("#btn-logout-2")?.addEventListener("click", logout);

/** hub init */
async function initHub(){
  if(!sessionId || !user){ goto($("#view-login")); return; }

  const nipp = user.nipp ? `NIPP ${user.nipp}` : "";
  const meta = [nipp, user.unit, user.sub_unit].filter(Boolean).join(" · ");
  $("#user-badge").textContent = `${user.name}${meta ? " · " + meta : ""}`;

  goto($("#view-hub"));

  const st = await fetchStatus(true);
  if(st?.ok){
    updateWatchUI(st);
    updateAttemptUI(st);
  } else {
    setMsg($("#hub-msg"), st?.error || "Gagal memuat status.", "bad");
  }

  await unlockQuizIfReady();
}

/** takeaways */
$("#btn-save-takeaways")?.addEventListener("click", async () => {
  const text = ($("#takeaways").value || "").trim();
  if(text.length < 10) return setMsg($("#hub-msg"), "Key takeaways terlalu pendek. Tambahkan poin yang lebih jelas.", "bad");

  setMsg($("#hub-msg"), "Menyimpan key takeaways...", "");
  const r = await api("save_takeaways", { session_id: sessionId, takeaways_text: text });
  if(!r?.ok) return setMsg($("#hub-msg"), "Gagal menyimpan: " + (r?.error || "Unknown"), "bad");

  takeawaysSaved = true;
  setMsg($("#hub-msg"), "Key takeaways tersimpan ✅", "ok");
  await unlockQuizIfReady();
});

/** quiz */
$("#btn-cancel-quiz")?.addEventListener("click", () => {
  stopTimer();
  goto($("#view-hub"));
});

$("#btn-start-quiz")?.addEventListener("click", async () => {
  const st = await fetchStatus(true);
  if(!st?.ok) return setMsg($("#hub-msg"), st?.error || "Gagal cek status.", "bad");

  if(st.locked){
    $("#btn-start-quiz").disabled = true;
    return setMsg($("#hub-msg"), "Attempt sudah 3x. Silakan lihat leaderboard.", "bad");
  }
  if(!st.qualified){
    const minM = Math.floor((st.min_watch_seconds||0)/60);
    return setMsg($("#hub-msg"), `Belum memenuhi syarat menonton. Minimal ${minM} menit.`, "bad");
  }
  if(!takeawaysSaved){
    return setMsg($("#hub-msg"), "Simpan key takeaways dulu sebelum mulai quiz.", "bad");
  }
  await startQuiz();
});

async function startQuiz(){
  setMsg($("#hub-msg"), "Menyiapkan quiz...", "");
  const r = await api("get_quiz", { session_id: sessionId, n: String(QUIZ_QUESTIONS) });
  if(!r?.ok) return setMsg($("#hub-msg"), "Gagal memuat quiz: " + (r?.error || "Unknown"), "bad");

  quiz = r.questions || [];
  quizIdx = 0;
  answers = [];
  quizStartTs = Date.now();

  $("#quiz-attempt").textContent = `Attempt: ${Number(r.attempt_no || 1)} / ${Number(r.max_attempts || 3)}`;

  goto($("#view-quiz"));
  renderQuestion();
}

function renderQuestion(){
  setMsg($("#quiz-msg"), "", "");
  const box = $("#q-box");
  const q = quiz[quizIdx];
  if(!q) return finishQuiz();

  $("#btn-next").disabled = true;

  box.innerHTML = `
    <div class="subtle">Soal ${quizIdx+1} dari ${quiz.length}</div>
    <div style="font-size:18px;font-weight:900;margin-top:8px">${escapeHtml(q.question)}</div>
    ${renderChoice("A", q.choices?.A)}
    ${renderChoice("B", q.choices?.B)}
    ${renderChoice("C", q.choices?.C)}
    ${renderChoice("D", q.choices?.D)}
  `;

  box.querySelectorAll(".choice").forEach(el => {
    el.addEventListener("click", () => {
      box.querySelectorAll(".choice").forEach(x => x.classList.remove("selected"));
      el.classList.add("selected");
      $("#btn-next").disabled = false;

      const ans = el.getAttribute("data-choice");
      answers[quizIdx] = { q_id: q.q_id, answer: ans };
    });
  });

  startTimer(QUIZ_TIMER_SECONDS, () => {
    if(!answers[quizIdx]) answers[quizIdx] = { q_id: q.q_id, answer: "" };
    nextQuestion();
  });

  $("#btn-next").onclick = () => nextQuestion();
}

function renderChoice(letter, text){
  return `
    <div class="choice" data-choice="${letter}">
      <div class="pill"><b>${letter}</b></div>
      <div>${escapeHtml(text || "")}</div>
    </div>
  `;
}

function nextQuestion(){
  stopTimer();
  quizIdx += 1;
  renderQuestion();
}

function startTimer(sec, onEnd){
  qTimer = sec;
  $("#timer").textContent = String(qTimer);

  timerInt = setInterval(() => {
    qTimer -= 1;
    $("#timer").textContent = String(qTimer);
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
  const durationSeconds = Math.round((Date.now() - quizStartTs)/1000);
  setMsg($("#quiz-msg"), "Mengirim jawaban & menghitung skor...", "");

  const r = await api("submit_score", {
    session_id: sessionId,
    answers_json: JSON.stringify(answers),
    duration_seconds: String(durationSeconds)
  });

  if(!r?.ok){
    setMsg($("#quiz-msg"), "Gagal submit: " + (r?.error || "Unknown"), "bad");
    return;
  }

  const rb = $("#result-box");
  rb.classList.remove("hidden");
  rb.innerHTML = `
    <div style="font-size:18px;font-weight:900">Skor attempt #${r.attempt_no}: ${r.total_score}</div>
    <div class="subtle">Base: ${r.base_score} · Bonus: ${r.bonus_score} · Benar: ${r.correctCount}/${r.total}</div>
    <div class="subtle">Attempts used: ${r.attempts_used}/${r.max_attempts} · Best score kamu: ${r.best_score}</div>
  `;

  await openLeaderboard();
}

/** leaderboard */
$("#btn-open-leaderboard")?.addEventListener("click", async () => openLeaderboard());
$("#btn-back-hub")?.addEventListener("click", async () => {
  const st = await fetchStatus(true);
  if(st?.ok && !st.locked){
    goto($("#view-hub"));
    return;
  }
  await openLeaderboard();
});

$("#btn-group-unit")?.addEventListener("click", async () => {
  activeGroupBy = "unit";
  $("#btn-group-unit").classList.add("active");
  $("#btn-group-subunit").classList.remove("active");
  await loadLeaderboard(activeGroupBy);
});

$("#btn-group-subunit")?.addEventListener("click", async () => {
  activeGroupBy = "sub_unit";
  $("#btn-group-subunit").classList.add("active");
  $("#btn-group-unit").classList.remove("active");
  await loadLeaderboard(activeGroupBy);
});

async function openLeaderboard(){
  stopTimer();
  await flushSend();
  goto($("#view-leaderboard"));
  await loadLeaderboard(activeGroupBy);
}

async function loadLeaderboard(groupBy="unit"){
  const r = await api("leaderboard", { group_by: groupBy });
  if(!r?.ok){
    $("#lb").innerHTML = `<div class="subtle" style="padding:12px">Gagal memuat leaderboard: ${escapeHtml(r?.error||"Unknown")}</div>`;
    $("#group-board").innerHTML = "";
    $("#top5-units").innerHTML = "";
    return;
  }

  const fastSet = new Set(r.fast_thinker_uids || []);
  const top = r.top || [];

  const head = `
    <div class="tr head">
      <div>Rank</div><div>Nama</div><div>Unit</div><div>Skor</div><div>Durasi</div>
    </div>
  `;
  const rows = top.map(x => `
    <div class="tr">
      <div>#${x.rank}</div>
      <div>
        ${escapeHtml(x.name)}
        ${fastSet.has(x.user_id) ? `<span class="pill" style="margin-left:8px;border-color:rgba(0,229,255,.55)">⚡ Fast Thinker</span>` : ""}
      </div>
      <div>${escapeHtml(x.unit || "-")}</div>
      <div><b>${x.score}</b></div>
      <div>${x.duration_seconds}s</div>
    </div>
  `).join("");
  $("#lb").innerHTML = head + rows;

  const units = r.top5_units || [];
  $("#top5-units").innerHTML = units.length
    ? units.map(u => `<span class="chip"><b>#${u.rank}</b> ${escapeHtml(u.unit)} · top ${u.top_score}</span>`).join("")
    : `<span class="subtle">Belum ada data.</span>`;

  const groups = r.top_groups || [];
  const gHead = `
    <div class="tr head simple">
      <div>Rank</div>
      <div>${groupBy==="sub_unit" ? "Sub Unit" : "Unit"}</div>
      <div>Completion</div>
      <div>Top Score</div>
    </div>
  `;
  const gRows = groups.map(g => `
    <div class="tr simple">
      <div>#${g.rank}</div>
      <div>${escapeHtml(g.group)}</div>
      <div>${g.completion_pct}%</div>
      <div><b>${g.top_score}</b></div>
    </div>
  `).join("");
  $("#group-board").innerHTML = gHead + gRows;
}

/** login binding */
document.addEventListener("DOMContentLoaded", async () => {
  const btn = $("#btn-login");
  const uEl = $("#login-user");
  const pEl = $("#login-pass");
  const loginMsg = $("#login-msg");

  btn.addEventListener("click", async () => {
    setMsg(loginMsg, "Memeriksa akun...", "");
    const u = uEl.value.trim();
    const p = pEl.value.trim();
    if(!u || !p) return setMsg(loginMsg, "Lengkapi user dan password.", "bad");

    const r = await api("login", { user: u, password: p, ua: navigator.userAgent });
    if(!r?.ok) return setMsg(loginMsg, "Login gagal: " + (r?.error || "Unknown"), "bad");

    sessionId = r.session_id;
    user = r.user;

    localStorage.setItem("session_id", sessionId);
    localStorage.setItem("user", JSON.stringify(user));

    setMsg(loginMsg, "Login berhasil ✅", "ok");
    takeawaysSaved = false;
    statusCache = null;
    lastStatusAt = 0;

    await initHub();
    initVideo();
  });

  [uEl, pEl].forEach(el => el.addEventListener("keydown", (ev) => {
    if(ev.key === "Enter") btn.click();
  }));

  const ping = await api("ping", {});
  if(!ping?.ok){
    setMsg(loginMsg, "API belum bisa diakses: " + (ping?.error || "Unknown"), "bad");
    goto($("#view-login"));
    return;
  }

  if(sessionId && user){
    await initHub();
    initVideo();
  } else {
    goto($("#view-login"));
  }
});

