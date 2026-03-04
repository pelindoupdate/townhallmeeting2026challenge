/** =========================================================
 * app.js - UI glass + full logic update (NO hardcode watch gate)
 * - API_URL: Apps Script Web App /exec
 * - Video watch tracking: robust (delta currentTime), anti-seek
 * - Gate quiz: status.min_watch_seconds & status.qualified
 * - Lock: status.locked (after submit)
 * - Leaderboard: unit/sub_unit switch, fast thinker + top5 unit
 * ========================================================= */

const API_URL =
  "https://script.google.com/macros/s/AKfycbx09vBniHE2vISKuPPCwZluhhgJET7ZK8_eDdmUnQiQfRV9dKdJ53QdB19Yz4GgL0hSAw/exec";

// YouTube Video ID (pastikan video bisa di-embed; kalau embed diblok, pakai Drive/Vimeo)
const YT_VIDEO_ID = "yRSJhttHmqc";

// Quiz settings
const QUIZ_QUESTIONS = 10;
const QUIZ_TIMER_SECONDS = 20;

// Watch batch send
const WATCH_BATCH_SECONDS = 5;

// State
let sessionId = localStorage.getItem("session_id") || "";
let user = safeJson(localStorage.getItem("user"));
let takeawaysSaved = false;

let ytPlayer = null;
let statusCache = null;
let lastStatusAt = 0;

let watchSeconds = Number(localStorage.getItem("watch_seconds") || 0);

// Robust watch polling
let watchPoll = null;
let lastPlayerTime = null;
let pendingAddSeconds = 0;
let lastSendAt = 0;

// Quiz state
let quiz = [];
let quizIdx = 0;
let answers = [];
let timerInt = null;
let qTimer = QUIZ_TIMER_SECONDS;
let quizStartTs = 0;

// Leaderboard grouping
let activeGroupBy = "unit";

/** ===== Global error trap (anti silent) ===== */
window.addEventListener("error", (e) => {
  const el = document.querySelector("#login-msg") || document.querySelector("#hub-msg") || document.querySelector("#quiz-msg");
  const msg = "JS Error: " + (e.message || "Unknown");
  if (el) { el.textContent = msg; el.className = "msg bad"; }
  console.error(e);
});
window.addEventListener("unhandledrejection", (e) => {
  const el = document.querySelector("#login-msg") || document.querySelector("#hub-msg") || document.querySelector("#quiz-msg");
  const msg = "Promise Error: " + (e.reason?.message || String(e.reason || "Unknown"));
  if (el) { el.textContent = msg; el.className = "msg bad"; }
  console.error(e);
});

/** ===== DOM ===== */
const vLogin = $("#view-login");
const vHub = $("#view-hub");
const vQuiz = $("#view-quiz");
const vLB = $("#view-leaderboard");

const loginMsg = $("#login-msg");
const hubMsg = $("#hub-msg");
const quizMsg = $("#quiz-msg");

const elWatchSec = $("#watch-sec");
const elWatchMin = $("#watch-min");
const elWatchStatus = $("#watch-status");
const elProgressFill = $("#progress-fill");
const elProgressText = $("#progress-text");

const userBadge = $("#user-badge");

/** ===== Helpers ===== */
function $(sel){ return document.querySelector(sel); }
function safeJson(str){ try{ return str ? JSON.parse(str) : null; } catch { return null; } }
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }
function goto(view){ [vLogin, vHub, vQuiz, vLB].forEach(hide); show(view); }
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

/** ===== API ===== */
async function api(action, params = {}) {
  try {
    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), { method:"GET", cache:"no-store" });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); }
    catch { return { ok:false, error:"Response bukan JSON: " + text.slice(0,180) }; }
    return json;
  } catch (err) {
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
  }
  return st;
}

function updateWatchUI(st){
  const total = Number(st?.video_total_seconds || 0);
  const minW  = Number(st?.min_watch_seconds || 0);

  elWatchSec.textContent = String(watchSeconds);
  elWatchMin.textContent = String(minW);

  const pct = toPercent(watchSeconds, total);
  elProgressFill.style.width = pct + "%";
  elProgressText.textContent = `${pct}% dari durasi video`;

  const qualified = !!st?.qualified;
  elWatchStatus.textContent = qualified ? "Syarat nonton terpenuhi ✅" : "Belum memenuhi syarat";
  elWatchStatus.style.borderColor = qualified ? "rgba(52,211,153,.55)" : "rgba(255,255,255,.12)";
  elWatchStatus.style.color = qualified ? "rgba(52,211,153,.95)" : "rgba(255,255,255,.78)";
}

function setQuizButtonLocked(){
  const btn = $("#btn-start-quiz");
  btn.disabled = true;
  btn.textContent = "Quiz sudah disubmit";
}

async function unlockQuizIfReady(){
  const btn = $("#btn-start-quiz");
  const st = await fetchStatus();

  if(!st?.ok){
    btn.disabled = true;
    return;
  }

  if(st.locked || localStorage.getItem("quiz_locked")==="true"){
    localStorage.setItem("quiz_locked","true");
    setQuizButtonLocked();
    return;
  }

  btn.disabled = !(st.qualified && takeawaysSaved);
  btn.textContent = "Mulai Quiz";
}

/** ===== YouTube embed setup ===== */
function setYouTubeSrc(){
  const iframe = $("#yt");
  // origin diset agar API stabil
  const origin = encodeURIComponent(location.origin);
  iframe.src = `https://www.youtube.com/embed/${YT_VIDEO_ID}?enablejsapi=1&playsinline=1&rel=0&origin=${origin}`;
}

/** ===== Watch tracking (robust) ===== */
function onYtStateChange(e){
  // 1 playing, 2 paused, 3 buffering, 0 ended
  if(e.data === 1) startWatchPoll();
  else stopWatchPoll(true);
}

function startWatchPoll(){
  if(watchPoll) return;
  if(!ytPlayer || typeof ytPlayer.getCurrentTime !== "function") return;

  lastPlayerTime = ytPlayer.getCurrentTime();
  lastSendAt = Date.now();

  watchPoll = setInterval(async () => {
    try {
      const state = ytPlayer.getPlayerState();
      if(state !== 1) return;

      const t = ytPlayer.getCurrentTime();
      if(lastPlayerTime == null) lastPlayerTime = t;

      const delta = t - lastPlayerTime;
      lastPlayerTime = t;

      // anti-seek: ignore jumps/rewind
      if(delta > 0 && delta < 2.2){
        pendingAddSeconds += delta;

        // update UI lokal cepat
        watchSeconds = Math.floor((watchSeconds || 0) + delta);
        localStorage.setItem("watch_seconds", String(watchSeconds));
        if(statusCache?.ok) updateWatchUI(statusCache);
      }

      const now = Date.now();
      if(pendingAddSeconds >= WATCH_BATCH_SECONDS || (now - lastSendAt) >= 5000){
        const add = Math.floor(pendingAddSeconds);
        if(add > 0 && sessionId){
          pendingAddSeconds -= add;

          await api("log_watch", {
            session_id: sessionId,
            add_seconds: String(add),
            events_json: ""
          });

          const st = await fetchStatus(true);
          if(st?.ok) updateWatchUI(st);

          if(st?.locked){
            localStorage.setItem("quiz_locked","true");
            setQuizButtonLocked();
          }
          await unlockQuizIfReady();
        }
        lastSendAt = now;
      }
    } catch(err){
      console.error("watchPoll error", err);
    }
  }, 1000);
}

function stopWatchPoll(flush=false){
  if(watchPoll){
    clearInterval(watchPoll);
    watchPoll = null;
  }

  if(flush){
    const add = Math.floor(pendingAddSeconds);
    pendingAddSeconds -= add;
    if(add > 0 && sessionId){
      api("log_watch", { session_id: sessionId, add_seconds: String(add), events_json:"" })
        .then(()=>fetchStatus(true))
        .then(st=>{ if(st?.ok) updateWatchUI(st); })
        .catch(console.error);
    }
  }
  lastPlayerTime = null;
}

/** ===== YouTube IFrame API ready ===== */
window.onYouTubeIframeAPIReady = function(){
  setYouTubeSrc();
  ytPlayer = new YT.Player("yt", { events: { onStateChange: onYtStateChange } });
};

/** ===== Auth ===== */
function logout(){
  localStorage.removeItem("session_id");
  localStorage.removeItem("user");
  localStorage.removeItem("watch_seconds");
  localStorage.removeItem("quiz_locked");

  sessionId = "";
  user = null;
  takeawaysSaved = false;
  statusCache = null;
  lastStatusAt = 0;

  stopWatchPoll(false);
  stopTimer();

  goto(vLogin);
}
$("#btn-logout")?.addEventListener("click", logout);
$("#btn-logout-2")?.addEventListener("click", logout);

/** ===== Hub init ===== */
async function initHub(){
  if(!sessionId || !user){ goto(vLogin); return; }

  const nipp = user.nipp ? `NIPP ${user.nipp}` : "";
  const meta = [nipp, user.unit, user.sub_unit].filter(Boolean).join(" · ");
  userBadge.textContent = `${user.name}${meta ? " · " + meta : ""}`;

  goto(vHub);

  const st = await fetchStatus(true);
  if(st?.ok){
    updateWatchUI(st);
    if(st.locked){
      localStorage.setItem("quiz_locked","true");
      setQuizButtonLocked();
    }
  } else {
    setMsg(hubMsg, st?.error || "Gagal memuat status.", "bad");
  }

  await unlockQuizIfReady();
}

/** ===== Takeaways ===== */
$("#btn-save-takeaways")?.addEventListener("click", async () => {
  const text = ($("#takeaways").value || "").trim();
  if(text.length < 10) return setMsg(hubMsg, "Takeaways terlalu pendek. Tambahkan poin yang lebih jelas.", "bad");

  setMsg(hubMsg, "Menyimpan takeaways...", "");
  const r = await api("save_takeaways", { session_id: sessionId, takeaways_text: text });
  if(!r?.ok) return setMsg(hubMsg, "Gagal menyimpan: " + (r?.error || "Unknown"), "bad");

  takeawaysSaved = true;
  setMsg(hubMsg, "Takeaways tersimpan ✅", "ok");
  await unlockQuizIfReady();
});

/** ===== Quiz ===== */
$("#btn-cancel-quiz")?.addEventListener("click", () => {
  stopTimer();
  goto(vHub);
});

$("#btn-start-quiz")?.addEventListener("click", async () => {
  const st = await fetchStatus(true);
  if(!st?.ok) return setMsg(hubMsg, st?.error || "Gagal cek status.", "bad");

  if(st.locked){
    localStorage.setItem("quiz_locked","true");
    await openLeaderboard();
    return;
  }
  if(!st.qualified){
    const minM = Math.floor((st.min_watch_seconds||0)/60);
    return setMsg(hubMsg, `Belum memenuhi syarat menonton. Minimal ${minM} menit.`, "bad");
  }
  if(!takeawaysSaved){
    return setMsg(hubMsg, "Simpan takeaways dulu sebelum mulai quiz.", "bad");
  }

  await startQuiz();
});

async function startQuiz(){
  setMsg(hubMsg, "Menyiapkan quiz...", "");
  const r = await api("get_quiz", { session_id: sessionId, n: String(QUIZ_QUESTIONS) });
  if(!r?.ok) return setMsg(hubMsg, "Gagal memuat quiz: " + (r?.error || "Unknown"), "bad");

  quiz = r.questions || [];
  quizIdx = 0;
  answers = [];
  quizStartTs = Date.now();

  goto(vQuiz);
  renderQuestion();
}

function renderQuestion(){
  setMsg(quizMsg, "", "");
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
  setMsg(quizMsg, "Mengirim jawaban & menghitung skor...", "");

  const r = await api("submit_score", {
    session_id: sessionId,
    answers_json: JSON.stringify(answers),
    duration_seconds: String(durationSeconds)
  });

  if(!r?.ok){
    setMsg(quizMsg, "Gagal submit: " + (r?.error || "Unknown"), "bad");
    const st = await fetchStatus(true);
    if(st?.ok && st.locked){
      localStorage.setItem("quiz_locked","true");
      await openLeaderboard();
    }
    return;
  }

  localStorage.setItem("quiz_locked","true");

  const rb = $("#result-box");
  rb.classList.remove("hidden");
  rb.innerHTML = `
    <div style="font-size:18px;font-weight:900">Skor kamu: ${r.score}</div>
    <div class="subtle">Benar: ${r.correctCount}/${r.total} · Durasi: ${durationSeconds}s</div>
    <div class="subtle">Status: Challenge terkunci setelah submit ✅</div>
  `;

  await openLeaderboard();
}

/** ===== Leaderboard ===== */
$("#btn-open-leaderboard")?.addEventListener("click", async () => openLeaderboard());

$("#btn-back-hub")?.addEventListener("click", async () => {
  if(localStorage.getItem("quiz_locked")==="true"){
    await openLeaderboard();
  } else {
    goto(vHub);
  }
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
  stopWatchPoll(true);
  stopTimer();
  goto(vLB);

  const st = await fetchStatus(true);
  if(st?.ok && st.locked){
    localStorage.setItem("quiz_locked","true");
    setQuizButtonLocked();
  }

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
    ? units.map(u => `<span class="chip"><b>#${u.rank}</b> ${escapeHtml(u.unit)} · ${u.total_score}</span>`).join("")
    : `<span class="subtle">Belum ada data.</span>`;

  const groups = r.top_groups || [];
  const gHead = `
    <div class="tr head simple">
      <div>Rank</div><div>${groupBy==="sub_unit" ? "Sub Unit" : "Unit"}</div><div>Member</div><div>Total</div>
    </div>
  `;
  const gRows = groups.map(g => `
    <div class="tr simple">
      <div>#${g.rank}</div>
      <div>${escapeHtml(g.group)}</div>
      <div>${g.members}</div>
      <div><b>${g.total_score}</b></div>
    </div>
  `).join("");
  $("#group-board").innerHTML = gHead + gRows;
}

/** ===== Login binding ===== */
document.addEventListener("DOMContentLoaded", async () => {
  const btn = $("#btn-login");
  const uEl = $("#login-user");
  const pEl = $("#login-pass");

  if(!btn || !uEl || !pEl || !loginMsg){
    alert("DOM tidak lengkap: cek id btn-login/login-user/login-pass/login-msg");
    return;
  }

  btn.addEventListener("click", async () => {
    setMsg(loginMsg, "Memeriksa akun...", "");
    const u = uEl.value.trim();
    const p = pEl.value.trim();
    if(!u || !p) return setMsg(loginMsg, "Lengkapi user dan password/token.", "bad");

    const r = await api("login", { user: u, password: p, ua: navigator.userAgent });
    if(!r?.ok) return setMsg(loginMsg, "Login gagal: " + (r?.error || "Unknown"), "bad");

    sessionId = r.session_id;
    user = r.user;

    localStorage.setItem("session_id", sessionId);
    localStorage.setItem("user", JSON.stringify(user));

    setMsg(loginMsg, "Login berhasil ✅", "ok");

    // reset
    takeawaysSaved = false;
    statusCache = null;
    lastStatusAt = 0;

    await initHub();
  });

  [uEl, pEl].forEach(el => el.addEventListener("keydown", (ev) => {
    if(ev.key === "Enter") btn.click();
  }));

  // boot
  const ping = await api("ping", {});
  if(!ping?.ok){
    setMsg(loginMsg, "API belum bisa diakses: " + (ping?.error || "Unknown"), "bad");
    goto(vLogin);
    return;
  }

  // route
  if(sessionId && user){
    const st = await fetchStatus(true);
    if(st?.ok && st.locked){
      localStorage.setItem("quiz_locked","true");
      goto(vLB);
      await loadLeaderboard(activeGroupBy);
    } else {
      await initHub();
    }
  } else {
    goto(vLogin);
  }
});
