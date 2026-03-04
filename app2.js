/** =========================================================
 * app.js (FULL UPDATED) - Townhall Meeting 2026 Challenge
 * Perubahan yang sudah diterapkan:
 * - Tidak ada WATCH_MIN_SECONDS hardcode. Semua gate ambil dari API action=status
 * - users: nipp, unit, sub_unit (tanpa subholding/regional)
 * - Gate quiz “fair”: minimal 60% durasi video (backend menghitung min_watch_seconds)
 * - Badge: Fast Thinker + Top 5 Unit (dari API leaderboard)
 * - Submit skor max 3 kali (backend), dan LOCK setelah submit (backend status.locked)
 * - Leaderboard per unit / sub_unit
 * - Setelah submit: tampil leaderboard saja (lock)
 * - Debug anti “sunyi”: error handler + pesan selalu muncul
 * ========================================================= */

/** ====== SET API URL (WAJIB) ====== */
const API_URL =
  "https://script.google.com/macros/s/AKfycbx09vBniHE2vISKuPPCwZluhhgJET7ZK8_eDdmUnQiQfRV9dKdJ53QdB19Yz4GgL0hSAw/exec";

/** ====== QUIZ SETTINGS ====== */
const QUIZ_QUESTIONS = 10;
const QUIZ_TIMER_SECONDS = 20;

/** ====== WATCH TRACKING ======
 * Strategy: tiap 1 detik tambah watchSeconds lokal saat video PLAYING.
 * Kirim batch ke backend tiap WATCH_BATCH_SECONDS.
 */
const WATCH_BATCH_SECONDS = 5;

/** ====== STATE ====== */
let sessionId = localStorage.getItem("session_id") || "";
let user = safeJson(localStorage.getItem("user"));
let takeawaysSaved = false;

let ytPlayer = null;
let watchSeconds = Number(localStorage.getItem("watch_seconds") || 0);
let watchTick = null;

// status dari backend
let statusCache = null; // {min_watch_seconds, video_total_seconds, watch_total, qualified, locked, submissions...}
let lastStatusAt = 0;

let quiz = [];
let quizIdx = 0;
let answers = [];
let timerInt = null;
let qTimer = QUIZ_TIMER_SECONDS;
let quizStartTs = 0;

let activeGroupBy = "unit"; // 'unit' | 'sub_unit'

/** ====== GLOBAL ERROR TRAP (anti sunyi) ====== */
window.addEventListener("error", (e) => {
  const el = document.querySelector("#login-msg") || document.querySelector("#hub-msg") || document.querySelector("#quiz-msg");
  const msg = "JS Error: " + (e.message || "Unknown");
  if (el) {
    el.textContent = msg;
    el.className = "msg bad";
  } else {
    alert(msg);
  }
  console.error(e);
});

window.addEventListener("unhandledrejection", (e) => {
  const el = document.querySelector("#login-msg") || document.querySelector("#hub-msg") || document.querySelector("#quiz-msg");
  const msg = "Promise Error: " + (e.reason?.message || String(e.reason || "Unknown"));
  if (el) {
    el.textContent = msg;
    el.className = "msg bad";
  } else {
    alert(msg);
  }
  console.error(e);
});

/** ====== DOM ====== */
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

/** ====== Helpers ====== */
function $(sel) {
  return document.querySelector(sel);
}

function safeJson(str) {
  try {
    return str ? JSON.parse(str) : null;
  } catch {
    return null;
  }
}

function show(el) {
  el.classList.remove("hidden");
}
function hide(el) {
  el.classList.add("hidden");
}

function goto(view) {
  [vLogin, vHub, vQuiz, vLB].forEach(hide);
  show(view);
}

function setMsg(el, text, type = "") {
  if (!el) return;
  el.textContent = text || "";
  el.className = "msg " + (type || "");
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/** ====== API ====== */
async function api(action, params = {}) {
  try {
    if (!API_URL || API_URL.includes("PASTE_URL")) {
      return { ok: false, error: "API_URL belum diisi (masih placeholder)." };
    }
    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), { method: "GET", cache: "no-store" });
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, error: "Response bukan JSON: " + text.slice(0, 180) };
    }
    return json;
  } catch (err) {
    return { ok: false, error: "Fetch error: " + String(err) };
  }
}

/** ====== STATUS (Source of Truth) ====== */
async function fetchStatus(force = false) {
  const now = Date.now();
  // cache 5 detik agar hemat request
  if (!force && statusCache && now - lastStatusAt < 5000) return statusCache;

  const json = await api("status", { session_id: sessionId });
  if (json && json.ok) {
    statusCache = json;
    lastStatusAt = now;

    // sync watchSeconds lokal agar konsisten (backend = source of truth)
    if (typeof json.watch_total === "number") {
      watchSeconds = Number(json.watch_total || 0);
      localStorage.setItem("watch_seconds", String(watchSeconds));
    }
  }
  return json;
}

/** ====== UI: Watch progress ====== */
function toPercent(watchSec, totalSec) {
  if (!totalSec || totalSec <= 0) return 0;
  return clamp(Math.round((watchSec / totalSec) * 100), 0, 100);
}

function updateWatchUIFromStatus(st) {
  const total = Number(st?.video_total_seconds || 0);
  const minW = Number(st?.min_watch_seconds || 0);

  elWatchSec.textContent = String(watchSeconds);
  elWatchMin.textContent = String(minW || 0);

  const pct = toPercent(watchSeconds, total);
  elProgressFill.style.width = pct + "%";
  elProgressText.textContent = `${pct}% dari durasi video`;

  const qualified = !!st?.qualified;
  elWatchStatus.textContent = qualified ? "Syarat nonton terpenuhi ✅" : "Belum memenuhi syarat";
  elWatchStatus.style.borderColor = qualified ? "rgba(52,211,153,.55)" : "rgba(255,255,255,.12)";
  elWatchStatus.style.color = qualified ? "rgba(52,211,153,.95)" : "rgba(255,255,255,.7)";
}

/** ====== LOCK UI ====== */
function setQuizButtonLocked() {
  const btn = $("#btn-start-quiz");
  btn.disabled = true;
  btn.textContent = "Quiz sudah disubmit";
}

async function applyLockIfNeeded() {
  const st = await fetchStatus(true);
  if (!st?.ok) return;

  if (st.locked) {
    localStorage.setItem("quiz_locked", "true");
    setQuizButtonLocked();
  }
}

/** ====== Unlock quiz conditions ======
 * - qualified (backend)
 * - takeawaysSaved (frontend flag)
 * - not locked (backend)
 */
async function unlockQuizIfReady() {
  const btn = $("#btn-start-quiz");
  const st = await fetchStatus();

  if (!st?.ok) {
    btn.disabled = true;
    return;
  }

  if (st.locked || localStorage.getItem("quiz_locked") === "true") {
    localStorage.setItem("quiz_locked", "true");
    setQuizButtonLocked();
    return;
  }

  btn.disabled = !(st.qualified && takeawaysSaved);
  btn.textContent = "Mulai Quiz";
}

/** ====== LOGIN / LOGOUT ====== */
function logout() {
  localStorage.removeItem("session_id");
  localStorage.removeItem("user");
  localStorage.removeItem("watch_seconds");
  localStorage.removeItem("quiz_locked");

  sessionId = "";
  user = null;
  takeawaysSaved = false;
  watchSeconds = 0;
  statusCache = null;

  stopWatchTick();
  stopTimer();

  goto(vLogin);
}

$("#btn-logout")?.addEventListener("click", logout);
$("#btn-logout-2")?.addEventListener("click", logout);

/** ====== INIT HUB ====== */
async function initHub() {
  if (!sessionId || !user) {
    goto(vLogin);
    return;
  }

  // user badge
  const nipp = user.nipp ? `NIPP ${user.nipp}` : "";
  const meta = [nipp, user.unit, user.sub_unit].filter(Boolean).join(" · ");
  userBadge.textContent = `${user.name}${meta ? " · " + meta : ""}`;

  goto(vHub);

  // pull status (source of truth)
  const st = await fetchStatus(true);
  if (st?.ok) {
    updateWatchUIFromStatus(st);
  } else {
    setMsg(hubMsg, st?.error || "Gagal memuat status.", "bad");
  }

  await applyLockIfNeeded();
  await unlockQuizIfReady();
}

/** ====== Takeaways ====== */
$("#btn-save-takeaways")?.addEventListener("click", async () => {
  const text = ($("#takeaways").value || "").trim();
  if (text.length < 10) return setMsg(hubMsg, "Takeaways terlalu pendek. Tambahkan poin yang lebih jelas.", "bad");

  setMsg(hubMsg, "Menyimpan takeaways...", "");
  const json = await api("save_takeaways", { session_id: sessionId, takeaways_text: text });

  if (!json?.ok) return setMsg(hubMsg, "Gagal menyimpan: " + (json?.error || "Unknown"), "bad");

  takeawaysSaved = true;
  setMsg(hubMsg, "Takeaways tersimpan ✅", "ok");
  await unlockQuizIfReady();
});

/** ====== Button open leaderboard ====== */
$("#btn-open-leaderboard")?.addEventListener("click", async () => {
  await openLeaderboard();
});

/** ====== Start Quiz ====== */
$("#btn-start-quiz")?.addEventListener("click", async () => {
  const st = await fetchStatus(true);
  if (!st?.ok) return setMsg(hubMsg, st?.error || "Gagal cek status.", "bad");

  if (st.locked) {
    localStorage.setItem("quiz_locked", "true");
    await openLeaderboard();
    return;
  }
  if (!st.qualified) {
    const minM = Math.floor((st.min_watch_seconds || 0) / 60);
    return setMsg(hubMsg, `Belum memenuhi syarat menonton. Minimal ${minM} menit.`, "bad");
  }
  if (!takeawaysSaved) {
    return setMsg(hubMsg, "Simpan takeaways dulu sebelum mulai quiz.", "bad");
  }

  await startQuiz();
});

/** ====== YouTube IFrame API ====== */
window.onYouTubeIframeAPIReady = function () {
  try {
    ytPlayer = new YT.Player("yt", {
      events: { onStateChange: onYtStateChange },
    });
  } catch (e) {
    console.error("YT init error", e);
  }
};

function onYtStateChange(e) {
  // 1=playing, 2=paused, 0=ended
  if (e.data === 1) startWatchTick();
  else stopWatchTick();
}

function startWatchTick() {
  if (watchTick) return;

  watchTick = setInterval(async () => {
    watchSeconds += 1;
    localStorage.setItem("watch_seconds", String(watchSeconds));

    // update UI with cached status if exists
    if (statusCache?.ok) updateWatchUIFromStatus(statusCache);

    // batch send
    if (watchSeconds % WATCH_BATCH_SECONDS === 0) {
      await api("log_watch", {
        session_id: sessionId,
        add_seconds: String(WATCH_BATCH_SECONDS),
        events_json: "",
      });

      // refresh status (qualified may change)
      const st = await fetchStatus(true);
      if (st?.ok) updateWatchUIFromStatus(st);

      await applyLockIfNeeded();
      await unlockQuizIfReady();
    }
  }, 1000);
}

function stopWatchTick() {
  if (!watchTick) return;
  clearInterval(watchTick);
  watchTick = null;
}

/** ====== Quiz flow ====== */
$("#btn-cancel-quiz")?.addEventListener("click", () => {
  stopTimer();
  goto(vHub);
});

async function startQuiz() {
  setMsg(hubMsg, "Menyiapkan quiz...", "");

  const json = await api("get_quiz", { session_id: sessionId, n: String(QUIZ_QUESTIONS) });
  if (!json?.ok) return setMsg(hubMsg, "Gagal memuat quiz: " + (json?.error || "Unknown"), "bad");

  quiz = json.questions || [];
  quizIdx = 0;
  answers = [];
  quizStartTs = Date.now();

  goto(vQuiz);
  renderQuestion();
}

function renderQuestion() {
  setMsg(quizMsg, "", "");
  const box = $("#q-box");
  const q = quiz[quizIdx];
  if (!q) return finishQuiz();

  $("#btn-next").disabled = true;

  box.innerHTML = `
    <div class="muted tiny">Soal ${quizIdx + 1} dari ${quiz.length}</div>
    <div style="font-size:18px;font-weight:900;margin-top:8px">${escapeHtml(q.question)}</div>
    ${renderChoice("A", q.choices?.A)}
    ${renderChoice("B", q.choices?.B)}
    ${renderChoice("C", q.choices?.C)}
    ${renderChoice("D", q.choices?.D)}
  `;

  box.querySelectorAll(".choice").forEach((el) => {
    el.addEventListener("click", () => {
      box.querySelectorAll(".choice").forEach((x) => x.classList.remove("selected"));
      el.classList.add("selected");
      $("#btn-next").disabled = false;

      const ans = el.getAttribute("data-choice");
      answers[quizIdx] = { q_id: q.q_id, answer: ans };
    });
  });

  startTimer(QUIZ_TIMER_SECONDS, () => {
    if (!answers[quizIdx]) answers[quizIdx] = { q_id: q.q_id, answer: "" };
    nextQuestion();
  });

  $("#btn-next").onclick = () => nextQuestion();
}

function renderChoice(letter, text) {
  return `
    <div class="choice" data-choice="${letter}">
      <div class="pill"><b>${letter}</b></div>
      <div>${escapeHtml(text || "")}</div>
    </div>
  `;
}

function nextQuestion() {
  stopTimer();
  quizIdx += 1;
  renderQuestion();
}

function startTimer(sec, onEnd) {
  qTimer = sec;
  $("#timer").textContent = String(qTimer);

  timerInt = setInterval(() => {
    qTimer -= 1;
    $("#timer").textContent = String(qTimer);
    if (qTimer <= 0) {
      stopTimer();
      onEnd();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInt) clearInterval(timerInt);
  timerInt = null;
}

/** ====== Submit Score + Lock ====== */
async function finishQuiz() {
  const durationSeconds = Math.round((Date.now() - quizStartTs) / 1000);
  setMsg(quizMsg, "Mengirim jawaban & menghitung skor...", "");

  const json = await api("submit_score", {
    session_id: sessionId,
    answers_json: JSON.stringify(answers),
    duration_seconds: String(durationSeconds),
  });

  if (!json?.ok) {
    setMsg(quizMsg, "Gagal submit: " + (json?.error || "Unknown"), "bad");
    // jika backend sudah lock, arahkan ke leaderboard
    const st = await fetchStatus(true);
    if (st?.ok && st.locked) {
      localStorage.setItem("quiz_locked", "true");
      await openLeaderboard();
    }
    return;
  }

  // lock after submit
  localStorage.setItem("quiz_locked", "true");

  // tampilkan ringkas hasil
  const rb = $("#result-box");
  rb.classList.remove("hidden");
  rb.innerHTML = `
    <div style="font-size:18px;font-weight:900">Skor kamu: ${json.score}</div>
    <div class="muted tiny">Benar: ${json.correctCount}/${json.total} · Durasi: ${durationSeconds}s</div>
    <div class="muted tiny">Status: Challenge terkunci setelah submit ✅</div>
  `;

  await openLeaderboard();
}

/** ====== Leaderboard ====== */
$("#btn-back-hub")?.addEventListener("click", async () => {
  // requirement: lock => leaderboard only
  if (localStorage.getItem("quiz_locked") === "true") {
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

async function openLeaderboard() {
  stopWatchTick();
  stopTimer();
  goto(vLB);

  // kalau lock, pastikan tombol quiz di hub nanti ikut lock juga
  await applyLockIfNeeded();

  await loadLeaderboard(activeGroupBy);
}

async function loadLeaderboard(groupBy = "unit") {
  const json = await api("leaderboard", { group_by: groupBy });
  if (!json?.ok) {
    $("#lb").innerHTML = `<div class="muted tiny" style="padding:12px">Gagal memuat leaderboard: ${escapeHtml(json?.error || "Unknown")}</div>`;
    $("#group-board").innerHTML = "";
    $("#top5-units").innerHTML = "";
    return;
  }

  // Top 10 Individual + Fast Thinker
  const fastSet = new Set(json.fast_thinker_uids || []);
  const top = json.top || [];

  const head = `
    <div class="tr head">
      <div>Rank</div><div>Nama</div><div>Unit</div><div>Skor</div><div>Durasi</div>
    </div>
  `;
  const rows = top
    .map(
      (r) => `
    <div class="tr">
      <div>#${r.rank}</div>
      <div>
        ${escapeHtml(r.name)}
        ${
          fastSet.has(r.user_id)
            ? `<span class="pill" style="margin-left:8px;border-color:rgba(34,211,238,.55)">⚡ Fast Thinker</span>`
            : ""
        }
      </div>
      <div>${escapeHtml(r.unit || "-")}</div>
      <div><b>${r.score}</b></div>
      <div>${r.duration_seconds}s</div>
    </div>
  `
    )
    .join("");
  $("#lb").innerHTML = head + rows;

  // Top 5 Unit
  const units = json.top5_units || [];
  $("#top5-units").innerHTML = units.length
    ? units.map((u) => `<span class="chip"><b>#${u.rank}</b> ${escapeHtml(u.unit)} · ${u.total_score}</span>`).join("")
    : `<span class="muted tiny">Belum ada data.</span>`;

  // Group leaderboard (unit/sub_unit)
  const groups = json.top_groups || [];
  const gHead = `
    <div class="tr head simple">
      <div>Rank</div><div>${groupBy === "sub_unit" ? "Sub Unit" : "Unit"}</div><div>Member</div><div>Total</div>
    </div>
  `;
  const gRows = groups
    .map(
      (g) => `
    <div class="tr simple">
      <div>#${g.rank}</div>
      <div>${escapeHtml(g.group)}</div>
      <div>${g.members}</div>
      <div><b>${g.total_score}</b></div>
    </div>
  `
    )
    .join("");
  $("#group-board").innerHTML = gHead + gRows;
}

/** ====== LOGIN BINDING (Anti Sunyi) ====== */
document.addEventListener("DOMContentLoaded", () => {
  const btn = $("#btn-login");
  const uEl = $("#login-user");
  const pEl = $("#login-pass");

  if (!btn || !uEl || !pEl || !loginMsg) {
    alert("DOM tidak lengkap: cek id btn-login/login-user/login-pass/login-msg di index.html");
    return;
  }

  btn.addEventListener("click", async () => {
    setMsg(loginMsg, "Memeriksa akun...", "");

    const u = uEl.value.trim();
    const p = pEl.value.trim();
    if (!u || !p) return setMsg(loginMsg, "Lengkapi user dan password/token.", "bad");

    const json = await api("login", { user: u, password: p, ua: navigator.userAgent });
    if (!json?.ok) return setMsg(loginMsg, "Login gagal: " + (json?.error || "Unknown"), "bad");

    sessionId = json.session_id;
    user = json.user;

    localStorage.setItem("session_id", sessionId);
    localStorage.setItem("user", JSON.stringify(user));

    setMsg(loginMsg, "Login berhasil ✅", "ok");

    // reset some local state
    takeawaysSaved = false;
    statusCache = null;
    lastStatusAt = 0;

    await initHub();
  });

  // Enter to login
  [uEl, pEl].forEach((el) =>
    el.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") btn.click();
    })
  );

  // boot routing
  boot();
});

/** ====== BOOT ====== */
async function boot() {
  // Always verify backend alive (optional, helpful)
  const ping = await api("ping", {});
  if (!ping?.ok) {
    setMsg(loginMsg, "API belum bisa diakses: " + (ping?.error || "Unknown"), "bad");
    goto(vLogin);
    return;
  }

  // If session exist, go hub or leaderboard if locked
  if (sessionId && user) {
    const st = await fetchStatus(true);
    if (st?.ok && st.locked) {
      localStorage.setItem("quiz_locked", "true");
      goto(vLB);
      await loadLeaderboard(activeGroupBy);
    } else {
      goto(vHub);
      await initHub();
    }
  } else {
    goto(vLogin);
  }
}
