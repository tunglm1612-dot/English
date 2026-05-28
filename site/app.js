import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const $ = id => document.getElementById(id);
const qsa = selector => [...document.querySelectorAll(selector)];
const config = window.APP_CONFIG || {};
const readyForCloud = config.SUPABASE_URL && config.SUPABASE_ANON_KEY &&
  !config.SUPABASE_URL.includes("PASTE_") && !config.SUPABASE_ANON_KEY.includes("PASTE_");
const db = readyForCloud ? createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY) : null;
const DISPLAY_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2", "Custom"];
const DB_PAGE_SIZE = 1000;
const TRANSLATE_BATCH_SIZE = 8;
let vocabularyRealtimeTimer = null;

const state = {
  seed: [], words: [], filtered: [], progress: {}, attempts: [], passages: [],
  personalMeanings: loadLocal("oxford_personal_meanings", {}),
  session: null, profile: null, isAdmin: false, dbHasWords: false,
  deck: [], cardIndex: 0, historyTab: "learning",
  quizMode: "abcd", quiz: [], quizIndex: 0, score: 0, answered: false,
  activePassage: null, readingAnswers: {}, readingResult: null, readingSubmitting: false,
  meaningLoading: new Set(), meaningAttempted: new Set(), adminTranslating: false,
  bulkUpdating: false
};

function loadLocal(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch { return fallback; } }
function saveLocal(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
function normalize(value) { return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s-]/g," ").replace(/\s+/g," ").trim(); }
function escapeHtml(value) { return String(value || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function shuffle(list) { const a=[...list]; for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]];} return a; }
function toast(message) { $("toast").textContent = message; $("toast").classList.remove("hidden"); clearTimeout(toast.t); toast.t=setTimeout(()=>$("toast").classList.add("hidden"),3600); }
function meaning(word) { return word.meaning_vi || state.personalMeanings[word.id]?.vi || ""; }
function statusOf(word) { return state.progress[word.id]?.status || "new"; }
function displayWord(word) { return `${escapeHtml(word.word)}${word.hint ? ` <small>(${escapeHtml(word.hint)})</small>` : ""}`; }
function translationQuery(word) { return word.hint ? `${word.word} (${word.hint})` : word.word; }
function today(value) { return value ? new Date(value).toLocaleDateString("vi-VN") : "—"; }
function levelClass(level) { return `level-${String(level || "custom").toLowerCase().replace(/[^a-z0-9]/g, "")}`; }
function cloudWordPayload(word, vi) {
  return {id:word.id, entry_key:word.entry_key, word:word.word, meaning_vi:vi, pos:word.pos || "", level:word.level || "Custom", hint:word.hint || "", source:word.source || "Admin"};
}

async function init() {
  state.seed = await fetch("/data/words.json").then(r => r.json());
  if (!db) {
    state.words = state.seed.map(w => ({...w, entry_key:`oxford_${w.id}`, meaning_vi:"", isSeed:true}));
    state.progress = loadLocal("oxford_local_progress", {});
    state.attempts = loadLocal("oxford_local_attempts", []);
    $("syncStatus").textContent = "Chế độ xem trước";
    $("syncNote").textContent = "Điền Supabase trong config.js để bật đăng nhập và đồng bộ.";
    applyFilters();
    renderAll();
    return;
  }
  $("syncStatus").textContent = "Đang kết nối...";
  const { data: { session } } = await db.auth.getSession();
  state.session = session;
  await refreshCloudData();
  subscribeRealtime();
  db.auth.onAuthStateChange(async (_event, sessionNow) => {
    state.session = sessionNow;
    await refreshCloudData();
    renderAll();
  });
}

async function refreshCloudData() {
  await loadProfile();
  await loadVocabulary();
  await Promise.all([loadProgress(), loadAttempts(), loadPassages()]);
  $("syncStatus").textContent = state.session ? "Đã đồng bộ database" : "Database online";
  $("syncNote").textContent = state.session ? "Tiến độ đang lưu theo tài khoản của bạn." : "Đăng nhập để lưu tiến độ học.";
  updateAccountUI();
  applyFilters();
}

async function loadProfile() {
  state.profile = null; state.isAdmin = false;
  if (!state.session) return;
  const { data } = await db.from("profiles").select("*").eq("id", state.session.user.id).maybeSingle();
  state.profile = data || {email: state.session.user.email, role:"student"};
  state.isAdmin = state.profile.role === "admin";
}

async function loadVocabulary() {
  // Supabase mặc định chỉ trả tối đa 1.000 dòng mỗi truy vấn.
  // Lấy tuần tự từng trang để dashboard luôn hiển thị đủ kho từ.
  const allRows = [];
  for (let start = 0; ; start += DB_PAGE_SIZE) {
    const { data, error } = await db.from("vocabulary")
      .select("*")
      .order("word", { ascending:true })
      .order("entry_key", { ascending:true })
      .range(start, start + DB_PAGE_SIZE - 1);
    if (error) {
      toast("Không đọc được kho từ: " + error.message);
      state.words = state.seed;
      state.dbHasWords = false;
      return;
    }
    allRows.push(...(data || []));
    if (!data || data.length < DB_PAGE_SIZE) break;
  }
  state.dbHasWords = allRows.length > 0;
  state.words = allRows.length ? allRows : state.seed.map(w => ({...w, entry_key:`oxford_${w.id}`, meaning_vi:"", isSeed:true}));
  if (!allRows.length && state.isAdmin) toast("Database chưa có từ. Vào Admin để nhập bộ Oxford.");
}

async function loadProgress() {
  if (!state.session || !state.dbHasWords) { state.progress = loadLocal("oxford_local_progress", {}); return; }
  const { data } = await db.from("user_progress").select("*").eq("user_id", state.session.user.id);
  state.progress = Object.fromEntries((data || []).map(row => [row.vocab_id, row]));
}

async function loadAttempts() {
  if (!state.session || !state.dbHasWords) { state.attempts = loadLocal("oxford_local_attempts", []); return; }
  const { data } = await db.from("attempts").select("*, vocabulary(word, meaning_vi)").eq("user_id", state.session.user.id).order("created_at",{ascending:false}).limit(80);
  state.attempts = data || [];
}

async function loadPassages() {
  if (!db) { state.passages = []; return; }
  const { data } = await db.from("reading_passages").select("*").order("created_at", {ascending:false});
  state.passages = data || [];
}

function queueVocabularyRealtimeRefresh() {
  // Trong lúc nhập/dịch hàng nghìn dòng, không tải lại kho từ sau mỗi dòng.
  // Khi thao tác kết thúc, hàm admin sẽ tải lại đúng một lần.
  if (state.bulkUpdating) return;
  clearTimeout(vocabularyRealtimeTimer);
  vocabularyRealtimeTimer = setTimeout(async () => {
    await loadVocabulary();
    applyFilters();
    toast("Kho từ vừa được cập nhật.");
  }, 700);
}
function subscribeRealtime() {
  db.channel("classroom-live")
    .on("postgres_changes", {event:"*", schema:"public", table:"vocabulary"}, queueVocabularyRealtimeRefresh)
    .on("postgres_changes", {event:"*", schema:"public", table:"reading_passages"}, async () => { await loadPassages(); renderReading(); toast("Có bài reading mới."); })
    .subscribe();
}

function updateAccountUI() {
  const logged = !!state.session;
  $("loginOpen").classList.toggle("hidden", logged);
  $("logoutBtn").classList.toggle("hidden", !logged);
  $("userLabel").textContent = logged ? `${state.profile?.email || state.session.user.email}${state.isAdmin ? " · Admin" : ""}` : "Khách";
  qsa(".admin-only").forEach(el => el.classList.toggle("hidden", !state.isAdmin));
  if (!state.isAdmin && $("admin").classList.contains("active")) goto("dashboard");
}

function applyFilters() {
  const level = $("levelFilter").value;
  const status = $("statusFilter").value;
  const search = normalize($("filterSearch").value);
  state.filtered = state.words.filter(w => (level==="ALL" || w.level===level) &&
    (status==="ALL" || statusOf(w)===status) &&
    (!search || normalize(`${w.word} ${meaning(w)}`).includes(search)));
  state.deck = shuffle(state.filtered.length ? state.filtered : state.words);
  state.cardIndex = 0;
  renderAll();
}

function renderAll() { renderDashboard(); renderCard(); renderHistory(); renderReading(); }
function renderDashboard() {
  const total = state.words.length;
  const learned = state.words.filter(w => statusOf(w)==="learned").length;
  const learning = state.words.filter(w => statusOf(w)==="learning").length;
  const fresh = Math.max(0,total-learned-learning);
  $("totalCount").textContent = total.toLocaleString("vi-VN");
  $("learnedCount").textContent = learned.toLocaleString("vi-VN");
  $("learningCount").textContent = learning.toLocaleString("vi-VN");
  $("newCount").textContent = fresh.toLocaleString("vi-VN");
  $("dashPercent").textContent = total ? `${Math.round(learned/total*100)}%` : "0%";
  const levelCounts = DISPLAY_LEVELS.map(level => ({level, count:state.words.filter(w => (w.level || "Custom") === level).length})).filter(item => item.count);
  $("levelStats").innerHTML = levelCounts.map(item => `<button class="level-pill ${levelClass(item.level)}" data-level-shortcut="${item.level}"><b>${item.level}</b><span>${item.count.toLocaleString("vi-VN")} từ</span></button>`).join("");
  qsa("[data-level-shortcut]").forEach(button => button.onclick=()=>{$("levelFilter").value=button.dataset.levelShortcut; applyFilters(); goto("cards");});
  const review = state.words.filter(w=>statusOf(w)==="learning").slice(0,10);
  $("reviewPreview").innerHTML = review.length ? review.map(w=>`<span class="chip">${escapeHtml(w.word)}</span>`).join("") : '<span class="muted">Chưa có từ cần ôn.</span>';
  const recent = state.attempts.slice(0,5);
  $("recentPreview").className = recent.length ? "activity" : "activity empty";
  $("recentPreview").innerHTML = recent.length ? recent.map(a => `<div class="activity-row"><span>${escapeHtml(a.vocabulary?.word || wordById(a.vocab_id)?.word || "Từ vựng")} · ${escapeHtml(a.exercise_type || "flashcard")}</span><b>${a.is_correct ? "✓" : "✗"}</b></div>`).join("") : "Chưa có lịch sử làm bài.";
}

function currentWord() { return state.deck[state.cardIndex] || state.words[0]; }
function renderCard() {
  const w = currentWord(); if (!w) return;
  $("flashcard").classList.remove("flipped");
  $("cardLevel").textContent = w.level || "Custom";
  $("backLevel").textContent = w.level || "Custom";
  $("cardLevel").className = `tag ${levelClass(w.level)}`;
  $("backLevel").className = `tag ${levelClass(w.level)}`;
  $("cardWord").innerHTML = displayWord(w);
  $("backWord").innerHTML = displayWord(w);
  $("cardPos").textContent = w.pos || "";
  $("cardMeaning").textContent = meaning(w) || (state.meaningLoading.has(w.id) ? "Đang tải nghĩa…" : "Đang tự động tải nghĩa…");
  $("deckCount").textContent = `${state.cardIndex+1} / ${state.deck.length} · ${statusLabel(statusOf(w))}`;
  if (!meaning(w) && !state.meaningAttempted.has(w.id)) loadMeaningForCard(w);
}
function statusLabel(s){ return ({learned:"Đã nhớ",learning:"Chưa nhớ",new:"Chưa học"})[s] || s; }
function wordById(id){ return state.words.find(w=>w.id===id); }

async function setStatus(word, status, exerciseType="flashcard", correct=null) {
  const existing = state.progress[word.id] || {};
  state.progress[word.id] = {...existing, status, last_reviewed_at:new Date().toISOString()};
  if (state.session && state.dbHasWords && !word.isSeed) {
    const row = {
      user_id: state.session.user.id, vocab_id: word.id, status,
      seen_count: (existing.seen_count || 0) + 1,
      correct_count: (existing.correct_count || 0) + (correct===true ? 1 : 0),
      wrong_count: (existing.wrong_count || 0) + (correct===false ? 1 : 0),
      last_reviewed_at: new Date().toISOString()
    };
    const { error } = await db.from("user_progress").upsert(row, {onConflict:"user_id,vocab_id"});
    if (error) toast("Không lưu được tiến độ: " + error.message);
    if (correct !== null) {
      await db.from("attempts").insert({user_id:state.session.user.id, vocab_id:word.id, exercise_type:exerciseType, is_correct:correct});
    }
    await loadAttempts();
  } else {
    saveLocal("oxford_local_progress", state.progress);
    if (correct !== null) {
      state.attempts.unshift({vocab_id:word.id, exercise_type:exerciseType, is_correct:correct, created_at:new Date().toISOString()});
      saveLocal("oxford_local_attempts", state.attempts.slice(0,100));
    }
  }
  renderAll();
}

async function requestTranslations(list) {
  if (!list.length) return [];
  const response = await fetch("/.netlify/functions/translate", {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({items:list.slice(0,20).map(w=>({id:w.id || w.entry_key, query:translationQuery(w)}))})
  });
  if (!response.ok) throw new Error("Không kết nối được dịch tự động.");
  const data = await response.json();
  return data.results || [];
}
async function ensureMeanings(list, {saveShared=false, quiet=false}={}) {
  const missing = list.filter(w => !meaning(w));
  if (!missing.length) return 0;
  let translated = 0;
  try {
    for (let i=0; i<missing.length; i+=20) {
      const batch = missing.slice(i, i+20);
      const results = await requestTranslations(batch);
      const resultMap = new Map(results.filter(r=>r.vi).map(r=>[String(r.id), r.vi]));
      const changed = batch.filter(w=>resultMap.has(String(w.id || w.entry_key))).map(w=>({word:w, vi:resultMap.get(String(w.id || w.entry_key))}));
      if (saveShared && state.isAdmin && state.dbHasWords) {
        const persistent = changed.filter(item=>!item.word.isSeed).map(item=>cloudWordPayload(item.word, item.vi));
        if (persistent.length) {
          const {error} = await db.from("vocabulary").upsert(persistent, {onConflict:"id"});
          if (error) throw error;
          persistent.forEach(row=>{ const target=wordById(row.id); if(target) target.meaning_vi=row.meaning_vi; });
        }
      } else {
        changed.forEach(item=>{ state.personalMeanings[item.word.id || item.word.entry_key] = {vi:item.vi}; });
        saveLocal("oxford_personal_meanings", state.personalMeanings);
      }
      translated += changed.length;
    }
    return translated;
  } catch(error) {
    if(!quiet) toast("Không tải được nghĩa tự động: " + (error.message || "Lỗi không xác định"));
    return translated;
  }
}
async function loadMeaningForCard(word) {
  if (!word || meaning(word) || state.meaningLoading.has(word.id)) return;
  state.meaningAttempted.add(word.id); state.meaningLoading.add(word.id); renderCard();
  await ensureMeanings([word], {quiet:true});
  state.meaningLoading.delete(word.id);
  if(currentWord()?.id===word.id) renderCard();
}

function goto(view) {
  qsa(".page").forEach(page => page.classList.toggle("active", page.id===view));
  qsa(".nav").forEach(button => button.classList.toggle("active", button.dataset.view===view));
  const map = {dashboard:["Tổng quan","Học từ cùng bạn bè và xem lại những từ chưa nhớ"],cards:["Flashcard","Ôn từ và đánh dấu trạng thái nhớ"],quiz:["Bài tập","Kiểm tra nghĩa và chính tả"],history:["Lịch sử học","Các từ đã nhớ, chưa nhớ và bài đã làm"],reading:["Reading","Dùng từ vựng trong đoạn đọc"],admin:["Admin Studio","Quản lý từ vựng và bài đọc real-time"]};
  $("pageTitle").textContent=map[view][0]; $("pageSubtitle").textContent=map[view][1];
  if(view==="history") renderHistory(); if(view==="reading") renderReading();
}

function renderHistory() {
  const host = $("historyList");
  if (state.historyTab === "attempts") {
    host.innerHTML = state.attempts.length ? state.attempts.map(a => `<div class="history-row"><b>${escapeHtml(a.vocabulary?.word || wordById(a.vocab_id)?.word || "Từ")}</b><span>${escapeHtml(a.exercise_type || "")}</span><span class="status ${a.is_correct?"learned":"learning"}">${a.is_correct?"Đúng":"Sai"}</span><span>${today(a.created_at)}</span></div>`).join("") : '<div class="empty">Chưa có bài làm nào.</div>';
    return;
  }
  const list = state.words.filter(w => statusOf(w)===state.historyTab);
  host.innerHTML = list.length ? list.slice(0,500).map(w => `<div class="history-row"><b>${displayWord(w)}</b><span>${escapeHtml(w.level||"")}</span><span class="status ${state.historyTab}">${statusLabel(state.historyTab)}</span><span>${escapeHtml(meaning(w) || "—")}</span></div>`).join("") : '<div class="empty">Không có từ trong mục này.</div>';
}

function selectQuizMode(mode) {
  state.quizMode=mode;
  qsa(".mode").forEach(button=>button.classList.toggle("active",button.dataset.mode===mode));
}
async function beginQuiz() {
  const count = Number($("quizSize").value);
  const pool = state.filtered.length ? state.filtered : state.words;
  state.quiz = shuffle(pool).slice(0,count);
  state.quizIndex=0; state.score=0; state.answered=false;
  $("quizStart").classList.add("hidden"); $("quizResult").classList.add("hidden"); $("quizPlay").classList.remove("hidden");
  // Các dạng bài dựa vào nghĩa tiếng Việt (kể cả Điền chữ) cần nạp nghĩa trước khi hiển thị.
  await ensureMeanings(state.quiz);
  renderQuizQuestion();
}
function maskWord(word) {
  const chars = [...word], positions=chars.map((c,i)=>/[a-z]/i.test(c)&&i>0&&i<chars.length-1?i:null).filter(x=>x!==null);
  shuffle(positions).slice(0,Math.max(1,Math.floor(positions.length*.45))).forEach(i=>chars[i]="_");
  return chars.join(" ");
}
async function renderQuizQuestion() {
  const w=state.quiz[state.quizIndex]; state.answered=false;
  $("quizStep").textContent=`Câu ${state.quizIndex+1}/${state.quiz.length}`; $("quizScore").textContent=state.score;
  $("feedback").classList.add("hidden"); $("nextQuiz").classList.add("hidden"); $("typedBox").classList.add("hidden"); $("options").innerHTML=""; $("answerInput").value="";
  if(state.quizMode==="abcd") {
    const alternatives=shuffle(state.words.filter(x=>x.id!==w.id)).slice(0,3);
    await ensureMeanings([w,...alternatives]);
    $("promptInstruction").textContent="Chọn nghĩa tiếng Việt của:";
    $("promptValue").innerHTML=displayWord(w);
    const choices=shuffle([w,...alternatives]);
    $("options").innerHTML=choices.map(x=>`<button class="option" data-id="${x.id}">${escapeHtml(meaning(x)||"Chưa có nghĩa")}</button>`).join("");
    qsa(".option").forEach(btn=>btn.onclick=()=>chooseOption(btn.dataset.id,w.id));
  } else {
    $("typedBox").classList.remove("hidden");
    if(state.quizMode==="vi-en") { $("promptInstruction").textContent="Nhập từ tiếng Anh có nghĩa:"; $("promptValue").textContent=meaning(w)||"Chưa có nghĩa"; }
    if(state.quizMode==="en-vi") { $("promptInstruction").textContent="Nhập nghĩa tiếng Việt của:"; $("promptValue").innerHTML=displayWord(w); }
    if(state.quizMode==="missing") {
      // Hiển thị gợi ý tiếng Việt để người học biết từ đang cần hoàn thiện.
      $("promptInstruction").textContent="Dựa vào nghĩa tiếng Việt, hoàn thiện từ tiếng Anh:";
      const vi = meaning(w) || "Chưa có nghĩa tiếng Việt";
      $("promptValue").innerHTML = `<span class="missing-meaning">${escapeHtml(vi)}</span><span class="missing-mask">${escapeHtml(maskWord(w.word))}</span><small class="missing-meta">${escapeHtml(w.level || "")} ${w.pos ? ` · ${escapeHtml(w.pos)}` : ""}</small>`;
    }
    setTimeout(()=>$("answerInput").focus(),50);
  }
}
function chooseOption(chosen, correctId) {
  if(state.answered) return;
  qsa(".option").forEach(btn=>{btn.disabled=true; btn.classList.toggle("correct",btn.dataset.id===correctId); btn.classList.toggle("wrong",btn.dataset.id===chosen&&chosen!==correctId);});
  finishQuizAnswer(chosen===correctId);
}
function submitTyped() {
  if(state.answered) return;
  const w=state.quiz[state.quizIndex], answer=normalize($("answerInput").value);
  let ok = false;
  if(state.quizMode==="en-vi") {
    const correct = normalize(meaning(w));
    ok = answer.length>1 && (answer===correct || correct.includes(answer) || answer.includes(correct));
  } else ok = answer === normalize(w.word);
  finishQuizAnswer(ok);
}
async function finishQuizAnswer(ok) {
  state.answered=true; const w=state.quiz[state.quizIndex];
  if(ok) state.score++;
  const nextStatus = ok ? "learned" : "learning";
  await setStatus(w,nextStatus,state.quizMode,ok);
  const solution = state.quizMode==="en-vi" ? meaning(w) : w.word;
  $("feedback").className=`feedback ${ok?"correct":"wrong"}`;
  $("feedback").innerHTML=ok ? "✓ Chính xác!" : `✗ Đáp án đúng: <b>${escapeHtml(solution)}</b>`;
  $("feedback").classList.remove("hidden"); $("nextQuiz").classList.remove("hidden"); $("quizScore").textContent=state.score;
}
function nextQuizQuestion() {
  state.quizIndex++;
  if(state.quizIndex>=state.quiz.length) {
    $("quizPlay").classList.add("hidden"); $("quizResult").classList.remove("hidden");
    $("resultScore").textContent=`${state.score}/${state.quiz.length}`;
    $("resultText").textContent=state.score/state.quiz.length>=.8?"Rất tốt! Từ sai vẫn được giữ trong mục Chưa nhớ để ôn lại.":"Mở Lịch sử học để ôn lại các từ chưa nhớ.";
  } else renderQuizQuestion();
}

function renderReading() {
  const selectedLevel = $("readingLevelFilter")?.value || "ALL";
  const visiblePassages = state.passages.filter(p => selectedLevel === "ALL" || (p.level || "Mixed") === selectedLevel);
  $("passageList").innerHTML = visiblePassages.length ? visiblePassages.map(p=>`<button data-passage="${p.id}" class="${state.activePassage?.id===p.id?"active":""}"><b>${escapeHtml(p.title)}</b><br><small class="reading-level ${levelClass(p.level)}">${escapeHtml(p.level||"Mixed")}</small></button>`).join("") : '<div class="empty">Chưa có bài reading ở trình độ này.</div>';
  qsa("[data-passage]").forEach(btn=>btn.onclick=()=>{
    state.activePassage=state.passages.find(p=>p.id===btn.dataset.passage);
    state.readingAnswers={}; state.readingResult=null; state.readingSubmitting=false;
    renderReading();
  });
  if(!state.activePassage) return;
  const p=state.activePassage;
  const questions = Array.isArray(p.questions) ? p.questions : [];
  const submitted = state.readingResult?.passageId === p.id;
  const resultHtml = submitted ? `<div class="reading-result ${state.readingResult.score===questions.length?"perfect":""}">
      <b>Điểm reading: ${state.readingResult.score}/${questions.length}</b>
      <span>${state.readingResult.score===questions.length ? "Chính xác toàn bộ!" : "Đáp án đúng đã được đánh dấu màu xanh."}</span>
      ${state.readingResult.saveError ? `<small>Điểm chưa lưu lên database: ${escapeHtml(state.readingResult.saveError)}</small>` : '<small>Kết quả đã được lưu vào tài khoản của bạn.</small>'}
    </div>` : "";
  $("readingWorkspace").innerHTML = `<span class="tag">${escapeHtml(p.level||"Mixed")}</span><h2>${escapeHtml(p.title)}</h2>
    <div class="passage-text">${highlightVocab(p.content)}</div>
    ${questions.map((q,i)=>`<div class="reading-question"><b>${i+1}. ${escapeHtml(q.question)}</b>${(q.options||[]).map((option,j)=>{
      const selected = state.readingAnswers[i]===j;
      const marked = submitted ? (j===Number(q.answer) ? " correct" : (selected ? " wrong" : "")) : (selected ? " selected" : "");
      return `<button class="reading-option${marked}" data-rq="${i}" data-ra="${j}" ${submitted || state.readingSubmitting ? "disabled" : ""}>${escapeHtml(option)}</button>`;
    }).join("")}</div>`).join("")}
    ${resultHtml}
    ${questions.length && !submitted ? `<button id="submitReading" class="primary" ${state.readingSubmitting ? "disabled" : ""}>${state.readingSubmitting ? "Đang nộp..." : "Nộp bài reading"}</button>` : ""}
    ${submitted ? '<button id="retryReading" class="outline">Làm lại bài reading</button>' : ""}`;
  qsa(".reading-option").forEach(btn=>btn.onclick=()=>{
    if(submitted || state.readingSubmitting) return;
    state.readingAnswers[btn.dataset.rq]=Number(btn.dataset.ra);
    qsa(`[data-rq="${btn.dataset.rq}"]`).forEach(x=>x.classList.remove("selected"));
    btn.classList.add("selected");
  });
  if($("submitReading")) $("submitReading").onclick=submitReading;
  if($("retryReading")) $("retryReading").onclick=()=>{state.readingAnswers={}; state.readingResult=null; renderReading();};
}
function highlightVocab(text) {
  const map = new Map(state.words.map(w=>[normalize(w.word),w]));
  return escapeHtml(text).replace(/\b[A-Za-z][A-Za-z-]*\b/g, token => {
    const w=map.get(normalize(token));
    return w ? `<span class="vocab-hit" title="${escapeHtml(meaning(w)||w.word)}">${token}</span>` : token;
  }).replace(/\n/g,"<br>");
}
async function submitReading() {
  const p=state.activePassage;
  const questions=Array.isArray(p?.questions) ? p.questions : [];
  if(!p || !questions.length || state.readingSubmitting) return;
  const unanswered=questions.filter((_q,i)=>state.readingAnswers[i] === undefined).length;
  if(unanswered) return toast(`Bạn còn ${unanswered} câu chưa chọn đáp án.`);
  let score=0; questions.forEach((q,i)=>{ if(state.readingAnswers[i]===Number(q.answer)) score++; });
  state.readingSubmitting=true; renderReading();
  let saveError="";
  if(state.session && db) {
    try {
      const { error } = await db.from("reading_attempts").insert({user_id:state.session.user.id, passage_id:p.id, score, total:questions.length, answers:state.readingAnswers});
      if(error) saveError=error.message;
    } catch(error) {
      saveError=error.message || "Không thể kết nối database.";
    }
  } else {
    saveError="Bạn cần đăng nhập để lưu kết quả.";
  }
  state.readingSubmitting=false;
  state.readingResult={passageId:p.id, score, total:questions.length, saveError};
  renderReading();
  toast(saveError ? `Điểm reading: ${score}/${questions.length}. Chưa lưu được kết quả.` : `Đã nộp bài. Điểm reading: ${score}/${questions.length}`);
}

async function loginOrSignup(event) {
  event.preventDefault();
  const action = event.submitter.value, form = new FormData(event.currentTarget), email=form.get("email"), password=form.get("password");
  const result = action==="signup" ? await db.auth.signUp({email,password}) : await db.auth.signInWithPassword({email,password});
  if(result.error) { $("authMessage").textContent=result.error.message; return; }
  $("authMessage").textContent = action==="signup" ? "Đã đăng ký. Kiểm tra email xác nhận nếu Supabase yêu cầu." : "Đăng nhập thành công.";
  if(action==="login") $("authModal").classList.add("hidden");
}
async function logout() { await db.auth.signOut(); toast("Đã đăng xuất."); }

async function saveMeaning() {
  const w=currentWord(), vi=$("meaningEdit").value.trim(); if(!vi) return;
  if(state.isAdmin && state.dbHasWords && !w.isSeed) {
    const { error } = await db.from("vocabulary").update({meaning_vi:vi}).eq("id",w.id);
    if(error) return toast(error.message);
    w.meaning_vi=vi; toast("Đã lưu nghĩa chung cho mọi học viên.");
  } else {
    state.personalMeanings[w.id]={vi}; saveLocal("oxford_personal_meanings",state.personalMeanings);
    toast("Đã lưu nghĩa cá nhân trên trình duyệt.");
  }
  $("meaningModal").classList.add("hidden"); renderAll();
}
async function autoTranslateCurrent() {
  const w=currentWord(); await ensureMeanings([w]); $("meaningEdit").value=meaning(w); 
}
function openMeaning() {
  const w=currentWord(); $("meaningTitle").textContent=`Nghĩa: ${w.word}`; $("meaningEdit").value=meaning(w); $("meaningModal").classList.remove("hidden");
}

async function seedVocabulary() {
  if(!state.isAdmin || state.bulkUpdating) return;
  $("seedVocabBtn").disabled=true;
  state.bulkUpdating=true;
  const rows=state.seed.map(w=>({entry_key:`oxford_${w.id}`,word:w.word,meaning_vi:null,pos:w.pos,level:w.level,hint:w.hint||"",source:w.source || "Oxford 3000 + Oxford 5000"}));
  try {
    for(let i=0;i<rows.length;i+=200) {
      const { error }=await db.from("vocabulary").upsert(rows.slice(i,i+200),{onConflict:"entry_key",ignoreDuplicates:true});
      if(error) throw error;
      $("seedProgress").textContent=`Đã nhập ${Math.min(i+200,rows.length)}/${rows.length} mục từ…`;
    }
    await loadVocabulary();
    applyFilters();
    $("seedProgress").textContent=`Đã nhập/cập nhật xong ${state.words.length.toLocaleString("vi-VN")} mục từ; bấm Tự động điền nghĩa còn thiếu để lưu nghĩa tiếng Việt.`;
    toast("Kho từ đã được cập nhật đầy đủ.");
  } catch(error) {
    toast("Lỗi nhập: " + (error.message || "Không xác định"));
  } finally {
    state.bulkUpdating=false;
    $("seedVocabBtn").disabled=false;
  }
}
async function autoTranslateRows(rows, progressEl=null) {
  const missing = rows.filter(row=>!String(row.meaning_vi || "").trim());
  if (!missing.length) return 0;
  let filled=0;
  for(let i=0;i<missing.length;i+=TRANSLATE_BATCH_SIZE) {
    const batch=missing.slice(i,i+TRANSLATE_BATCH_SIZE);
    try {
      const results=await requestTranslations(batch);
      const resultMap=new Map(results.filter(r=>r.vi).map(r=>[String(r.id), r.vi]));
      batch.forEach(row=>{ const vi=resultMap.get(String(row.id || row.entry_key)); if(vi){ row.meaning_vi=vi; filled++; }});
    } catch(error) { toast("Dịch tự động bị gián đoạn: " + (error.message || "Lỗi")); break; }
    if(progressEl) progressEl.textContent=`Đã dịch ${Math.min(i+TRANSLATE_BATCH_SIZE,missing.length)}/${missing.length} từ đang thiếu nghĩa…`;
  }
  return filled;
}
async function translateMissingVocabulary() {
  if(!state.isAdmin || !state.dbHasWords) return toast("Hãy nhập kho từ vào database trước.");
  if(state.adminTranslating || state.bulkUpdating) return;
  const missing=state.words.filter(w=>!String(w.meaning_vi || "").trim() && !w.isSeed);
  if(!missing.length) return toast("Tất cả từ đã có nghĩa tiếng Việt.");
  const button=$("translateMissingBtn"), progress=$("translateProgress");
  state.adminTranslating=true;
  state.bulkUpdating=true;
  button.disabled=true;
  button.textContent="Đang tự động dịch…";
  let saved=0, failed=0;
  try {
    for(let i=0;i<missing.length;i+=TRANSLATE_BATCH_SIZE) {
      const batch=missing.slice(i,i+TRANSLATE_BATCH_SIZE);
      let results=[];
      try { results=await requestTranslations(batch); } catch { failed+=batch.length; }
      const resultMap=new Map(results.filter(r=>r.vi).map(r=>[String(r.id),r.vi]));
      const translated=batch.filter(w=>resultMap.has(String(w.id))).map(w=>cloudWordPayload(w,resultMap.get(String(w.id))));
      failed += batch.length-translated.length;
      if(translated.length) {
        const {error}=await db.from("vocabulary").upsert(translated,{onConflict:"id"});
        if(error) failed+=translated.length;
        else {
          saved+=translated.length;
          translated.forEach(row=>{ const target=wordById(row.id); if(target) target.meaning_vi=row.meaning_vi; });
        }
      }
      progress.textContent=`Đã lưu nghĩa ${saved}/${missing.length} từ. Chưa lưu: ${missing.length-saved}${failed ? ` · Lỗi tạm thời: ${failed}` : ""}`;
      if (i + TRANSLATE_BATCH_SIZE < missing.length) await new Promise(resolve => setTimeout(resolve, 220));
    }
  } finally {
    state.adminTranslating=false;
    state.bulkUpdating=false;
    button.disabled=false;
    button.textContent="Tự động điền nghĩa còn thiếu";
    await loadVocabulary();
    applyFilters();
  }
  toast(failed ? `Đã lưu ${saved} nghĩa. Bấm lại để thử lại những từ còn thiếu.` : `Đã tự động lưu nghĩa cho ${saved} từ.`);
}
async function addWord(event) {
  event.preventDefault(); const button=event.submitter; const data=Object.fromEntries(new FormData(event.currentTarget).entries());
  data.entry_key=`custom_${Date.now()}_${normalize(data.word).replace(/\s/g,"_")}`; data.source="Admin";
  if(!String(data.meaning_vi || "").trim()) { button.disabled=true; button.textContent="Đang dịch & lưu…"; await autoTranslateRows([data]); }
  const { error }=await db.from("vocabulary").insert(data);
  button.disabled=false; button.textContent="Lưu từ";
  if(error) return toast(error.message);
  event.currentTarget.reset(); toast(data.meaning_vi ? `Đã thêm “${data.word}” kèm nghĩa tiếng Việt.` : `Đã thêm “${data.word}”. Bạn có thể tự động điền nghĩa sau.`);
}
function parseCSV(text) {
  return text.split(/\r?\n/).filter(line=>line.trim()).map((line,index)=>{
    const parts=line.split(",").map(x=>x.trim().replace(/^"|"$/g,""));
    return {entry_key:`upload_${Date.now()}_${index}_${normalize(parts[0]).replace(/\s/g,"_")}`,word:parts[0],meaning_vi:parts[1]||null,pos:parts[2]||"",level:parts[3]||"Custom",hint:parts[4]||"",source:"Admin upload"};
  }).filter(row=>row.word);
}
async function uploadWords() {
  const rows=parseCSV($("bulkWords").value); if(!rows.length) return toast("Chưa có dòng từ vựng hợp lệ.");
  const button=$("uploadWordsBtn"); button.disabled=true; button.textContent="Đang dịch & upload…";
  const filled=await autoTranslateRows(rows, $("translateProgress"));
  const { error }=await db.from("vocabulary").insert(rows);
  button.disabled=false; button.textContent="Dịch & upload lên database";
  if(error) return toast(error.message);
  $("bulkWords").value=""; toast(`Đã upload ${rows.length} từ; tự động điền nghĩa cho ${filled} từ.`);
}
async function addReading(event) {
  event.preventDefault(); const f=new FormData(event.currentTarget);
  let questions; try { questions=JSON.parse(f.get("questions")); } catch { return toast("JSON câu hỏi chưa hợp lệ."); }
  const { error }=await db.from("reading_passages").insert({title:f.get("title"),level:f.get("level"),content:f.get("content"),questions,created_by:state.session.user.id});
  if(error) return toast(error.message);
  event.currentTarget.reset(); toast("Đã đăng bài reading.");
}

qsa("[data-view]").forEach(el=>el.onclick=e=>{e.preventDefault(); const v=el.dataset.view; if(v) goto(v);});
["levelFilter","statusFilter"].forEach(id=>$(id).onchange=applyFilters); $("filterSearch").oninput=applyFilters; $("readingLevelFilter").onchange=renderReading;
$("flashcard").onclick=e=>{if(!e.target.closest("button")) $("flashcard").classList.toggle("flipped");};
$("shuffleBtn").onclick=()=>{state.deck=shuffle(state.filtered.length?state.filtered:state.words);state.cardIndex=0;renderCard();};
$("skipBtn").onclick=()=>{state.cardIndex=(state.cardIndex+1)%state.deck.length;renderCard();};
$("rememberBtn").onclick=async()=>{await setStatus(currentWord(),"learned"); $("skipBtn").click();};
$("notRememberBtn").onclick=async()=>{await setStatus(currentWord(),"learning"); $("skipBtn").click();};
$("speakBtn").onclick=()=>{const u=new SpeechSynthesisUtterance(currentWord().word);u.lang="en-US";speechSynthesis.speak(u);};
$("translateBtn").onclick=openMeaning; $("meaningClose").onclick=()=>$("meaningModal").classList.add("hidden"); $("meaningSave").onclick=saveMeaning; $("autoTranslate").onclick=autoTranslateCurrent;
qsa(".mode").forEach(b=>b.onclick=()=>selectQuizMode(b.dataset.mode)); $("quizBegin").onclick=beginQuiz; $("checkAnswer").onclick=submitTyped; $("answerInput").onkeydown=e=>{if(e.key==="Enter")submitTyped();}; $("nextQuiz").onclick=nextQuizQuestion; $("quizAgain").onclick=()=>{$("quizResult").classList.add("hidden");$("quizStart").classList.remove("hidden");};
qsa(".history-tab").forEach(b=>b.onclick=()=>{state.historyTab=b.dataset.hstatus;qsa(".history-tab").forEach(x=>x.classList.toggle("active",x===b));renderHistory();});
$("loginOpen").onclick=()=>{ if(!db) return toast("Hãy cấu hình Supabase trong site/config.js trước."); $("authModal").classList.remove("hidden"); };
$("authClose").onclick=()=>$("authModal").classList.add("hidden"); $("authForm").onsubmit=loginOrSignup; $("logoutBtn").onclick=logout;
$("seedVocabBtn").onclick=seedVocabulary; $("translateMissingBtn").onclick=translateMissingVocabulary; $("addWordForm").onsubmit=addWord; $("uploadWordsBtn").onclick=uploadWords; $("csvFile").onchange=async e=>{const file=e.target.files[0]; if(file) $("bulkWords").value=await file.text();}; $("readingForm").onsubmit=addReading;

init();
