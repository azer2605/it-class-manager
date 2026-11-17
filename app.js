(() => {
  'use strict';
  const cfg = window.APP_CONFIG || {};
  const configured = Boolean(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
    !String(cfg.SUPABASE_URL).includes('BU_YERGA') &&
    !String(cfg.SUPABASE_ANON_KEY).includes('BU_YERGA'));
  const $ = id => document.getElementById(id);
  const sections = ['Doska', 'Qog‘oz', 'Kompyuter'];
  let db = null, user = null, currentSession = null;
  let records = [], sessions = [], editingRecord = null;
  let modalMode = 'batch', batchSection = 'Kompyuter', roster = [], batchRecords = [];
  let timer = null, remaining = 15 * 60, running = false, batchPhase = 'adding', gradeIndex = 0;
  let activeBatch = null, activeBatches = [];
  const batchStorageKey = () => 'itcm_active_batches_' + (user?.id || 'guest');
  function persistBatches() { try { localStorage.setItem(batchStorageKey(), JSON.stringify(activeBatches)); } catch (e) { console.warn('Timer storage unavailable', e); } }
  function readBatches() { try { const value = JSON.parse(localStorage.getItem(batchStorageKey()) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; } }
  function formatTime(ms) { const total = Math.max(0, Math.ceil(ms / 1000)); return String(Math.floor(total / 60)).padStart(2,'0') + ':' + String(total % 60).padStart(2,'0'); }
  function batchRemaining(batch) { return batch.phase === 'running' ? Math.max(0, batch.endAt - Date.now()) : Math.max(0, batch.remainingMs || 0); }
  function findBatchForRecord(id) { return activeBatches.find(batch => (batch.ids || []).includes(id)); }

  const today = () => {
    const d = new Date();
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  };
  $('lessonDate').value = today();

  function toast(message) {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => $('toast').classList.remove('show'), 3200);
  }
  function showAuth(message = '') {
    $('authView').classList.remove('hidden'); $('appView').classList.add('hidden'); $('logoutBtn').classList.add('hidden'); $('authMsg').textContent = message;
  }
  function showApp() { $('authView').classList.add('hidden'); $('appView').classList.remove('hidden'); $('logoutBtn').classList.remove('hidden'); }
  function showError(error, target = 'authMsg') {
    console.error(error);
    const message = error?.message || 'Noma’lum xatolik yuz berdi.';
    if ($(target)) $(target).textContent = message; else toast(message);
  }
  function setBusy(button, busy, normalLabel) {
    button.disabled = busy;
    button.textContent = busy ? 'Saqlanmoqda…' : normalLabel;
  }

  async function init() {
    if (!configured) {
      $('cloudStatus').textContent = 'Supabase sozlanmagan';
      showAuth('config.js faylida Supabase URL va Publishable key tekshirilishi kerak.');
      $('loginBtn').disabled = true; $('signupBtn').disabled = true; return;
    }
    if (!window.supabase?.createClient) {
      $('cloudStatus').textContent = 'Kutubxona yuklanmadi';
      showAuth('Supabase kutubxonasi yuklanmadi. Internet aloqasini tekshirib, sahifani yangilang.'); return;
    }
    db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    $('cloudStatus').textContent = 'Supabase ulandi';
    const { data, error } = await db.auth.getSession();
    if (error) showError(error);
    if (data?.session?.user) { user = data.session.user; await enterApp(); } else showAuth();
    db.auth.onAuthStateChange((event, session) => {
      user = session?.user || null;
      if (user) setTimeout(() => enterApp(), 0);
      else if (event === 'SIGNED_OUT') showAuth('Hisobdan chiqdingiz.');
    });
  }

  $('loginBtn').onclick = async () => {
    if (!db) return;
    const email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) return $('authMsg').textContent = 'Email va parolni kiriting.';
    setBusy($('loginBtn'), true, 'Kirish');
    const { error } = await db.auth.signInWithPassword({ email, password });
    setBusy($('loginBtn'), false, 'Kirish'); if (error) showError(error);
  };
  $('signupBtn').onclick = async () => {
    if (!db) return;
    const email = $('email').value.trim(), password = $('password').value;
    if (!email || !password) return $('authMsg').textContent = 'Email va parolni kiriting.';
    if (password.length < 6) return $('authMsg').textContent = 'Parol kamida 6 belgidan iborat bo‘lsin.';
    setBusy($('signupBtn'), true, 'Hisob yaratish');
    const { data, error } = await db.auth.signUp({ email, password });
    setBusy($('signupBtn'), false, 'Hisob yaratish');
    $('authMsg').textContent = error ? error.message : (data.session ? 'Hisob yaratildi. Tizimga kirishingiz mumkin.' : 'Hisob yaratildi. Emailingizga tasdiqlash havolasi yuborildi. Emailni tasdiqlab, keyin kiring.');
  };
  $('logoutBtn').onclick = async () => { if (db) await db.auth.signOut(); };

  async function enterApp() { showApp(); activeBatches = readBatches(); await loadSessions(); await restoreActiveSession(); startTicker(); }
  async function restoreActiveSession() {
    const candidate = activeBatches.slice().sort((a,b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
    if (!candidate) { renderStationTimers(); return; }
    const session = sessions.find(item => item.id === candidate.lessonId);
    if (!session) { renderStationTimers(); return; }
    currentSession = session; $('lessonTopic').value = session.title; $('groupName').value = session.group_name; $('lessonDate').value = session.lesson_date; $('sessionBadge').textContent = session.group_name + ' • ' + session.lesson_date;
    await loadRecords();
    activeBatches.forEach(batch => { if (batch.phase === 'running' && batch.endAt <= Date.now()) { batch.phase = 'finished'; batch.remainingMs = 0; batch.updatedAt = Date.now(); } });
    persistBatches(); renderStationTimers();
  }
  async function loadSessions() {
    const { data, error } = await db.from('lessons').select('*').order('created_at', { ascending: false });
    if (error) return showError(error, 'sessionMsg');
    sessions = data || []; renderHistory();
  }
  async function loadRecords() {
    if (!currentSession) return;
    const { data, error } = await db.from('student_tasks').select('*').eq('lesson_id', currentSession.id).order('created_at', { ascending: true });
    if (error) return showError(error, 'sessionMsg');
    records = data || []; renderRecords(); renderStationTimers();
  }
  function resetFields() {
    currentSession = null; records = [];
    $('lessonTopic').value = ''; $('groupName').value = ''; $('lessonDate').value = today();
    $('sessionBadge').textContent = 'Yangi dars'; $('sessionMsg').textContent = ''; renderRecords(); renderStationTimers();
  }
  $('newSessionBtn').onclick = () => { resetFields(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  $('resetSessionBtn').onclick = () => {
    if (confirm('Yangi guruh uchun yangi dars ochilsinmi? Avvalgi darslar saqlanib qoladi.')) resetFields();
  };
  $('saveSessionBtn').onclick = async () => {
    if (!user) return toast('Avval tizimga kiring.');
    const title = $('lessonTopic').value.trim(), group = $('groupName').value.trim(), date = $('lessonDate').value;
    if (!title || !group || !date) return $('sessionMsg').textContent = 'Mavzu, guruh va sanani kiriting.';
    const payload = { title, group_name: group, lesson_date: date, owner_id: user.id };
    const result = currentSession
      ? await db.from('lessons').update(payload).eq('id', currentSession.id).select().single()
      : await db.from('lessons').insert(payload).select().single();
    if (result.error) return showError(result.error, 'sessionMsg');
    currentSession = result.data; $('sessionBadge').textContent = group + ' • ' + date; $('sessionMsg').textContent = 'Dars saqlandi.';
    await loadSessions(); toast('Dars ma’lumotlari saqlandi.');
  };

  document.querySelectorAll('[data-open]').forEach(button => { button.onclick = () => openBatchModal(button.dataset.open); });
  $('closeModal').onclick = closeModal;
  $('taskModal').onclick = event => { if (event.target === $('taskModal')) closeModal(); };

  function openBatchModal(section) {
    if (!currentSession) return toast('Avval dars mavzusi va guruhni saqlang.');
    modalMode = 'batch'; batchSection = section; gradeIndex = 0; batchPhase = 'adding';
    activeBatch = activeBatches.find(batch => batch.lessonId === currentSession.id && batch.section === section && ['running','paused'].includes(batch.phase)) || null;
    roster = []; batchRecords = [];
    $('modalSection').textContent = section.toUpperCase(); $('modalTitle').textContent = activeBatch ? 'Davom etayotgan guruh mashg‘uloti' : 'Yangi guruh mashg‘ulotini tashkil qilish';
    $('batchPanel').classList.remove('hidden'); $('editPanel').classList.add('hidden'); $('gradingPanel').classList.add('hidden'); $('batchDone').classList.add('hidden');
    $('batchTask').disabled = false; $('batchDuration').disabled = false; $('batchStudentName').disabled = false; $('addBatchStudent').disabled = false;
    $('modalMsg').textContent = ''; $('startBatch').classList.remove('hidden'); $('startBatch').disabled = false; $('startBatch').textContent = '▶ Guruh taymerini boshlash';
    $('pauseTimer').classList.add('hidden'); $('resetTimer').classList.add('hidden'); $('gradeNow').classList.add('hidden');
    $('gradingPanel').classList.add('hidden'); $('batchDone').classList.add('hidden');
    if (activeBatch) {
      batchRecords = records.filter(record => activeBatch.ids.includes(record.id));
      roster = batchRecords.map(record => record.student_name);
      batchPhase = activeBatch.phase;
      $('batchTask').value = activeBatch.task || ''; $('batchDuration').value = activeBatch.duration || 15;
      $('batchTask').disabled = true; $('batchDuration').disabled = true; $('batchStudentName').disabled = true; $('addBatchStudent').disabled = true;
      $('startBatch').classList.add('hidden'); $('pauseTimer').classList.remove('hidden'); $('resetTimer').classList.remove('hidden');
      $('pauseTimer').textContent = activeBatch.phase === 'paused' ? '▶ Davom ettirish' : 'Ⅱ Pauza';
      $('gradeNow').classList.remove('hidden');
      if (activeBatch.phase === 'finished') { $('pauseTimer').classList.add('hidden'); $('resetTimer').classList.add('hidden'); $('modalMsg').textContent = 'Vaqt tugadi. O‘quvchilarni hozir yoki keyin bittalab baholashingiz mumkin.'; }
      else $('modalMsg').textContent = 'Taymer modal oynadan chiqqaningizda ham ishlashda davom etadi.';
      remaining = batchRemaining(activeBatch) / 1000;
    } else {
      $('batchTask').value = ''; $('batchStudentName').value = ''; $('batchDuration').value = 15; remaining = 15 * 60;
    }
    updateTimer(); renderRoster(); $('taskModal').classList.remove('hidden');
    setTimeout(() => { if (!activeBatch) $('batchStudentName').focus(); }, 50);
  }
  function openEditModal(record) {
    modalMode = 'edit'; editingRecord = record;
    $('modalSection').textContent = 'O‘QUVCHI MA’LUMOTI'; $('modalTitle').textContent = record.score == null ? 'O‘quvchini baholash' : 'O‘quvchi natijasini tahrirlash';
    $('batchPanel').classList.add('hidden'); $('editPanel').classList.remove('hidden');
    $('editSection').value = record.section; $('editStudentName').value = record.student_name || '';
    $('editTask').value = record.task || ''; $('editDuration').value = record.duration_minutes || 15;
    $('editScore').value = record.score ?? ''; $('editNote').value = record.note || ''; $('editMsg').textContent = '';
    $('taskModal').classList.remove('hidden');
  }
  function closeModal() {
    // Taymer modal yopilganda ham ishlashda davom etadi.
    $('taskModal').classList.add('hidden');
  }

  function renderRoster() {
    const container = $('batchRoster'); container.innerHTML = '';
    $('rosterCount').textContent = roster.length + ' nafar';
    if (!roster.length) { container.innerHTML = '<div class="empty">Hali o‘quvchi qo‘shilmadi.</div>'; return; }
    roster.forEach((name, index) => {
      const row = document.createElement('div'); row.className = 'roster-row';
      const number = document.createElement('span'); number.className = 'roster-number'; number.textContent = String(index + 1);
      const label = document.createElement('b'); label.textContent = name;
      const remove = document.createElement('button'); remove.className = 'roster-remove'; remove.type = 'button'; remove.textContent = 'Olib tashlash';
      remove.hidden = batchPhase !== 'adding';
      remove.onclick = () => { if (batchPhase !== 'adding') return; roster.splice(index, 1); renderRoster(); };
      row.append(number, label, remove); container.append(row);
    });
  }
  function addRosterStudent() {
    if (batchPhase !== 'adding') return;
    const name = $('batchStudentName').value.trim();
    if (!name) { $('modalMsg').textContent = 'Avval o‘quvchi ismini kiriting.'; $('batchStudentName').focus(); return; }
    if (roster.some(item => item.toLocaleLowerCase() === name.toLocaleLowerCase())) { $('modalMsg').textContent = 'Bu o‘quvchi ro‘yxatda bor.'; $('batchStudentName').focus(); return; }
    roster.push(name); $('batchStudentName').value = ''; $('modalMsg').textContent = name + ' ro‘yxatga qo‘shildi.'; renderRoster(); $('batchStudentName').focus();
  }
  $('addBatchStudent').onclick = addRosterStudent;
  $('batchStudentName').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addRosterStudent(); } });

  function updateTimer() {
    const ms = activeBatch ? batchRemaining(activeBatch) : remaining * 1000;
    $('timerDisplay').textContent = formatTime(ms);
  }
  function stopTimer() { if (timer) clearInterval(timer); timer = null; running = false; }
  function startTicker() {
    if (timer) return;
    timer = setInterval(() => {
      let changed = false;
      activeBatches.forEach(batch => {
        if (batch.phase === 'running') {
          batch.remainingMs = Math.max(0, batch.endAt - Date.now());
          if (batch.remainingMs <= 0) { batch.phase = 'finished'; batch.remainingMs = 0; batch.updatedAt = Date.now(); changed = true; toast(batch.section + ' bo‘limida vaqt tugadi. Baholash mumkin.'); }
        }
      });
      if (changed) persistBatches();
      if (activeBatch) {
        remaining = batchRemaining(activeBatch) / 1000; running = activeBatch.phase === 'running'; updateTimer();
        if (activeBatch.phase === 'finished' && !$('taskModal').classList.contains('hidden') && modalMode === 'batch') {
          $('pauseTimer').classList.add('hidden'); $('resetTimer').classList.add('hidden'); $('gradeNow').classList.remove('hidden');
          $('modalMsg').textContent = 'Vaqt tugadi. Endi o‘quvchilarni istalgan tartibda bittalab baholashingiz mumkin.';
        }
      }
      renderRecords(); renderStationTimers();
    }, 1000);
  }
  function setBatchPause(batch, pause) {
    if (pause && batch.phase === 'running') { batch.remainingMs = Math.max(0, batch.endAt - Date.now()); batch.phase = 'paused'; batch.endAt = null; }
    else if (!pause && batch.phase === 'paused') { batch.endAt = Date.now() + Math.max(0, batch.remainingMs || 0); batch.phase = 'running'; }
    batch.updatedAt = Date.now(); persistBatches(); renderStationTimers();
    if (activeBatch?.key === batch.key) { remaining = batchRemaining(batch) / 1000; $('pauseTimer').textContent = batch.phase === 'paused' ? '▶ Davom ettirish' : 'Ⅱ Pauza'; updateTimer(); }
  }
  function runTimer() { if (!activeBatch) return; setBatchPause(activeBatch, false); }
  $('pauseTimer').onclick = () => { if (activeBatch) setBatchPause(activeBatch, activeBatch.phase === 'running'); };
  $('resetTimer').onclick = () => {
    if (!activeBatch || !['running','paused'].includes(activeBatch.phase)) return;
    activeBatch.phase = 'paused'; activeBatch.remainingMs = activeBatch.duration * 60000; activeBatch.endAt = null; activeBatch.updatedAt = Date.now(); persistBatches(); remaining = activeBatch.duration * 60; updateTimer(); $('pauseTimer').textContent = '▶ Davom ettirish'; renderStationTimers();
  };
  $('batchDuration').onchange = () => {
    const value = Math.min(180, Math.max(1, Number($('batchDuration').value) || 15));
    $('batchDuration').value = value;
    if (batchPhase === 'adding') { remaining = value * 60; updateTimer(); }
  };

  async function startBatch() {
    if (!currentSession || !user) return toast('Avval darsni saqlang va tizimga kiring.');
    if (!roster.length) { $('modalMsg').textContent = 'Taymerni boshlashdan oldin kamida bitta o‘quvchi qo‘shing.'; return; }
    const duration = Math.min(180, Math.max(1, Number($('batchDuration').value) || 15));
    const task = $('batchTask').value.trim();
    const payload = roster.map(student_name => ({ lesson_id: currentSession.id, owner_id: user.id, student_name, section: batchSection, task, duration_minutes: duration, score: null, note: '' }));
    $('startBatch').disabled = true; $('startBatch').textContent = 'Ro‘yxat saqlanmoqda…';
    const { data, error } = await db.from('student_tasks').insert(payload).select();
    $('startBatch').disabled = false; $('startBatch').textContent = '▶ Guruh taymerini boshlash';
    if (error) { $('modalMsg').textContent = 'O‘quvchilarni saqlashda xatolik: ' + error.message; return; }
    batchRecords = (data || []).slice().sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
    const now = Date.now();
    activeBatch = { key: (window.crypto?.randomUUID?.() || String(now) + Math.random()), lessonId: currentSession.id, section: batchSection, ids: batchRecords.map(r => r.id), duration, task, phase: 'running', remainingMs: duration * 60000, endAt: now + duration * 60000, updatedAt: now };
    activeBatches.push(activeBatch); persistBatches();
    await loadRecords();
    $('batchTask').disabled = true; $('batchDuration').disabled = true; $('batchStudentName').disabled = true; $('addBatchStudent').disabled = true;
    $('startBatch').classList.add('hidden'); $('pauseTimer').classList.remove('hidden'); $('resetTimer').classList.remove('hidden'); $('gradeNow').classList.remove('hidden');
    $('pauseTimer').textContent = 'Ⅱ Pauza'; remaining = duration * 60; batchPhase = 'running'; running = true; updateTimer();
    $('modalMsg').textContent = roster.length + ' nafar o‘quvchi saqlandi. Taymer modal oynani yopsangiz ham ishlaydi.';
    toast(roster.length + ' nafar o‘quvchi saqlandi. Taymer boshlandi.'); startTicker(); renderStationTimers();
  }
  $('startBatch').onclick = startBatch;
  $('gradeNow').onclick = () => {
    if (activeBatch) {
      if (activeBatch.phase === 'running' || activeBatch.phase === 'paused') {
        if (!confirm('Guruh taymerini hozir yakunlab, baholashga o‘tamizmi?')) return;
        activeBatch.phase = 'finished'; activeBatch.remainingMs = 0; activeBatch.endAt = null; activeBatch.updatedAt = Date.now(); persistBatches(); renderStationTimers();
      }
      batchRecords = records.filter(record => activeBatch.ids.includes(record.id) && record.score == null);
      beginGrading('O‘quvchilarni bittalab baholang.');
    }
  };

  function beginGrading(message) {
    batchPhase = 'grading';
    $('pauseTimer').classList.add('hidden'); $('resetTimer').classList.add('hidden'); $('gradeNow').classList.add('hidden');
    $('gradingPanel').classList.remove('hidden'); $('modalMsg').textContent = message;
    gradeIndex = 0; renderCurrentGrade();
  }
  function renderCurrentGrade() {
    const pending = batchRecords.filter(record => record.score === null || record.score === undefined);
    if (!pending.length) {
      $('gradingPanel').classList.add('hidden'); $('batchDone').classList.remove('hidden'); $('gradingProgress').textContent = batchRecords.length + ' / ' + batchRecords.length;
      $('modalMsg').textContent = 'Barcha baholar saqlandi.'; batchPhase = 'done';
      loadRecords(); return;
    }
    const record = pending[0];
    $('gradingStudentName').textContent = record.student_name;
    $('gradingProgress').textContent = (batchRecords.length - pending.length + 1) + ' / ' + batchRecords.length;
    $('gradingTask').textContent = (record.task || 'Topshiriq: ko‘rsatilmagan') + ' · ' + record.duration_minutes + ' daqiqa';
    $('gradeScore').value = ''; $('gradeNote').value = '';
    $('saveGradeNext').textContent = pending.length === 1 ? 'Bahoni saqlash va yakunlash ✓' : 'Bahoni saqlash va keyingisi →';
    $('saveGradeNext').disabled = false;
  }
  async function saveGrade() {
    const pending = batchRecords.filter(record => record.score === null || record.score === undefined);
    if (!pending.length) return renderCurrentGrade();
    const record = pending[0], scoreValue = $('gradeScore').value;
    if (!scoreValue) { $('modalMsg').textContent = 'Davom etish uchun bahoni tanlang.'; $('gradeScore').focus(); return; }
    setBusy($('saveGradeNext'), true, 'Bahoni saqlash');
    const { error } = await db.from('student_tasks').update({ score: Number(scoreValue), note: $('gradeNote').value.trim() }).eq('id', record.id);
    setBusy($('saveGradeNext'), false, pending.length === 1 ? 'Bahoni saqlash va yakunlash ✓' : 'Bahoni saqlash va keyingisi →');
    if (error) { $('modalMsg').textContent = 'Bahoni saqlab bo‘lmadi: ' + error.message; return; }
    const index = batchRecords.findIndex(item => item.id === record.id);
    if (index >= 0) { batchRecords[index] = { ...batchRecords[index], score: Number(scoreValue), note: $('gradeNote').value.trim() }; }
    activeBatches.forEach(batch => { batch.ids = batch.ids.filter(id => id !== record.id); }); activeBatches = activeBatches.filter(batch => batch.ids.length); persistBatches(); activeBatch = null;
    await loadRecords(); renderStationTimers();
    renderCurrentGrade();
    if (batchPhase === 'done') toast('Barcha o‘quvchilar baholandi.');
  }
  $('saveGradeNext').onclick = saveGrade;

  async function saveEditedRecord() {
    if (!editingRecord) return;
    const name = $('editStudentName').value.trim();
    if (!name) { $('editMsg').textContent = 'O‘quvchi ismini kiriting.'; return; }
    const score = $('editScore').value === '' ? null : Number($('editScore').value);
    const payload = {
      student_name: name, section: $('editSection').value, task: $('editTask').value.trim(),
      duration_minutes: Math.min(180, Math.max(1, Number($('editDuration').value) || 15)),
      score, note: $('editNote').value.trim()
    };
    setBusy($('saveEditRecord'), true, 'O‘zgarishni saqlash');
    const { error } = await db.from('student_tasks').update(payload).eq('id', editingRecord.id);
    setBusy($('saveEditRecord'), false, 'O‘zgarishni saqlash');
    if (error) { $('editMsg').textContent = error.message; return; }
    if (score !== null) { activeBatches.forEach(batch => { batch.ids = batch.ids.filter(id => id !== editingRecord.id); }); activeBatches = activeBatches.filter(batch => batch.ids.length); if (activeBatch && !activeBatches.some(batch => batch.key === activeBatch.key)) activeBatch = null; persistBatches(); }
    $('taskModal').classList.add('hidden'); editingRecord = null; await loadRecords(); renderStationTimers(); toast('O‘quvchi natijasi yangilandi.');
  }
  $('saveEditRecord').onclick = saveEditedRecord;
  $('deleteRecord').onclick = async () => {
    if (!editingRecord || !confirm('Ushbu o‘quvchi topshirig‘i o‘chirilsinmi?')) return;
    const { error } = await db.from('student_tasks').delete().eq('id', editingRecord.id);
    if (error) return showError(error, 'editMsg');
    $('taskModal').classList.add('hidden'); editingRecord = null; await loadRecords(); toast('Natija o‘chirildi.');
  };

  function renderRecords() {
    sections.forEach(section => {
      const list = records.filter(record => record.section === section);
      $('count' + section).textContent = list.length + ' ta o‘quvchi';
      const container = $('list' + section); container.innerHTML = '';
      if (!list.length) { container.innerHTML = '<div class="empty">Hozircha o‘quvchi qo‘shilmagan</div>'; return; }
      list.forEach(record => {
        const item = document.createElement('div'); item.className = 'student-item';
        const info = document.createElement('div');
        const name = document.createElement('b'); name.textContent = record.student_name;
        const detail = document.createElement('small'); detail.textContent = (record.task || 'Topshiriq kiritilmagan') + ' · ' + (record.duration_minutes || 15) + ' daq.';
        info.append(name, detail);
        const batch = findBatchForRecord(record.id);
        if (batch) { const clock = document.createElement('span'); clock.className = 'student-timer' + (batch.phase === 'finished' ? ' finished' : batch.phase === 'paused' ? ' paused' : ''); clock.textContent = batch.phase === 'finished' ? 'Vaqt tugadi · baholash kutilmoqda' : batch.phase === 'paused' ? 'Pauza · ' + formatTime(batchRemaining(batch)) : 'Qolgan vaqt: ' + formatTime(batchRemaining(batch)); info.append(clock); }
        const right = document.createElement('div'); right.className = 'row student-actions';
        const badge = document.createElement('span'); badge.className = 'score-badge' + (record.score == null ? ' pending-badge' : '');
        badge.textContent = record.score == null ? (batch?.phase === 'finished' ? 'Baholash kerak' : 'Kutilmoqda') : record.score + '/5';
        const edit = document.createElement('button'); edit.className = 'btn secondary'; edit.textContent = record.score == null ? 'Baholash' : 'Tahrirlash'; edit.onclick = () => openEditModal(record);
        right.append(badge, edit); item.append(info, right); container.append(item);
      });
    });
  }
  function renderStationTimers() {
    sections.forEach(section => {
      const host = $('timers' + section); if (!host) return; host.innerHTML = '';
      const batches = activeBatches.filter(batch => batch.lessonId === currentSession?.id && batch.section === section);
      batches.forEach(batch => {
        const card = document.createElement('div'); card.className = 'station-timer' + (batch.phase === 'finished' ? ' finished' : '');
        const info = document.createElement('div'); const title = document.createElement('b'); title.textContent = batch.phase === 'finished' ? 'Vaqt tugadi — baholashga tayyor' : batch.phase === 'paused' ? 'Taymer pauzada' : 'Guruh taymeri ishlayapti';
        const sub = document.createElement('small'); sub.textContent = batch.ids.length + ' nafar baholanmagan o‘quvchi'; info.append(title, sub);
        const controls = document.createElement('div'); controls.className = 'timer-state';
        const time = document.createElement('span'); time.className = 'timer-value'; time.textContent = batch.phase === 'finished' ? '00:00' : formatTime(batchRemaining(batch)); controls.append(time);
        if (batch.phase !== 'finished') { const pause = document.createElement('button'); pause.className = 'btn secondary'; pause.textContent = batch.phase === 'paused' ? '▶ Davom' : 'Ⅱ Pauza'; pause.onclick = () => setBatchPause(batch, batch.phase === 'running'); controls.append(pause); }
        const grade = document.createElement('button'); grade.className = 'btn primary'; grade.textContent = 'Baholash'; grade.onclick = () => { const rec = records.find(record => batch.ids.includes(record.id) && record.score == null); if (rec) openEditModal(rec); }; controls.append(grade);
        card.append(info, controls); host.append(card);
      });
    });
  }


  function renderHistory() {
    const query = $('historySearch').value.toLowerCase().trim(), container = $('historyList'); container.innerHTML = '';
    const filtered = sessions.filter(session => (session.title + ' ' + session.group_name).toLowerCase().includes(query));
    if (!filtered.length) { container.innerHTML = '<div class="empty">Saqlangan darslar topilmadi.</div>'; return; }
    filtered.forEach(session => {
      const row = document.createElement('div'); row.className = 'history-row';
      const info = document.createElement('div'), title = document.createElement('b'), detail = document.createElement('small');
      title.textContent = session.title; detail.textContent = session.group_name + ' · ' + session.lesson_date; info.append(title, detail);
      const actions = document.createElement('div'); actions.className = 'row';
      const open = document.createElement('button'); open.className = 'btn secondary'; open.textContent = 'Ochish';
      open.onclick = async () => {
        currentSession = session; $('lessonTopic').value = session.title; $('groupName').value = session.group_name;
        $('lessonDate').value = session.lesson_date; $('sessionBadge').textContent = session.group_name + ' • ' + session.lesson_date;
        await loadRecords(); window.scrollTo({ top: 0, behavior: 'smooth' });
      };
      const exportButton = document.createElement('button'); exportButton.className = 'btn ghost'; exportButton.textContent = 'Excel'; exportButton.onclick = () => exportSession(session);
      actions.append(open, exportButton); row.append(info, actions); container.append(row);
    });
  }
  $('historySearch').oninput = renderHistory;

  function exportRows(list, filename) {
    if (!window.XLSX) return toast('Excel kutubxonasi yuklanmadi. Internetni tekshiring.');
    const rows = list.map(record => ({
      'Sana': record.lesson_date, 'Guruh': record.group_name, 'Umumiy mavzu': record.title,
      'O‘quvchi': record.student_name, 'Bo‘lim': record.section, 'Topshiriq': record.task,
      'Vaqt (daqiqa)': record.duration_minutes, 'Baho (1-5)': record.score ?? '', 'Izoh': record.note || ''
    }));
    const detailSheet = XLSX.utils.json_to_sheet(rows);
    detailSheet['!cols'] = [{wch:13},{wch:18},{wch:35},{wch:24},{wch:15},{wch:38},{wch:15},{wch:13},{wch:38}];
    const aggregates = new Map();
    list.forEach(record => {
      const key = record.group_name + '||' + record.student_name;
      if (!aggregates.has(key)) aggregates.set(key, { group: record.group_name, name: record.student_name, total: 0, scored: 0, sum: 0 });
      const item = aggregates.get(key); item.total++;
      if (record.score !== null && record.score !== undefined) { item.scored++; item.sum += Number(record.score); }
    });
    const summaryRows = [...aggregates.values()].map(item => ({
      'Guruh': item.group, 'O‘quvchi': item.name, 'Topshiriqlar soni': item.total,
      'Baholangan topshiriqlar': item.scored, 'O‘rtacha baho': item.scored ? Number((item.sum / item.scored).toFixed(2)) : '',
      'Bilim darajasi': item.scored ? (item.sum / item.scored >= 4.5 ? 'A’lo' : item.sum / item.scored >= 3.5 ? 'Yaxshi' : item.sum / item.scored >= 2.5 ? 'Qoniqarli' : 'Qo‘shimcha mashq kerak') : 'Hali baholanmagan'
    }));
    const summarySheet = XLSX.utils.json_to_sheet(summaryRows); summarySheet['!cols'] = [{wch:18},{wch:24},{wch:18},{wch:22},{wch:16},{wch:28}];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'Barcha natijalar'); XLSX.utils.book_append_sheet(workbook, summarySheet, 'Oquvchi tahlili');
    XLSX.writeFile(workbook, filename);
  }
  async function exportSession(session) {
    const { data, error } = await db.from('student_tasks').select('*').eq('lesson_id', session.id).order('created_at');
    if (error) return showError(error);
    exportRows((data || []).map(record => ({ ...record, title: session.title, group_name: session.group_name, lesson_date: session.lesson_date })), 'IT_Class_' + session.lesson_date + '.xlsx');
  }
  $('exportAllBtn').onclick = async () => {
    const all = [];
    for (const session of sessions) {
      const { data, error } = await db.from('student_tasks').select('*').eq('lesson_id', session.id);
      if (error) return showError(error);
      (data || []).forEach(record => all.push({ ...record, title: session.title, group_name: session.group_name, lesson_date: session.lesson_date }));
    }
    if (!all.length) return toast('Excelga chiqarish uchun natijalar yo‘q.');
    exportRows(all, 'IT_Class_Barcha_natijalar.xlsx');
  };

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderStationTimers(); renderRecords(); } });

  init().catch(error => {
    $('cloudStatus').textContent = 'Ulanishda xatolik';
    showAuth('Supabase bilan ulanishda xatolik: ' + (error?.message || 'Sahifani yangilang.')); console.error(error);
  });
})();
