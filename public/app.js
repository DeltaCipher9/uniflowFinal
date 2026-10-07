/**
 * UniFlow - Intelligent University Life Operating System
 * FULL JAVASCRIPT ENGINE (app.js)
 * 
 * Features:
 * 1. UniFlowStore: per-user data kept in memory and saved to the backend (SQLite) via /api/data.
 * 2. AIEngine: Daily action planner ("3 assignments + 1 lab this week") & Notice NLP regex extractor.
 * 3. CalendarEngine: Dynamic monthly calendar matrix with deadline event badges.
 * 4. Page Initializers: Automatically renders and handles events on each individual page.
 */

// =============================================================================
// 0. API HELPERS + SESSION (talks to the backend in /server)
// =============================================================================
const Api = {
  async request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    let payload = null;
    try { payload = await res.json(); } catch (e) { /* no JSON body */ }
    if (!res.ok) {
      const err = new Error((payload && payload.error) || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return payload;
  }
};

const Session = { user: null };

function showSaveWarning() {
  if (document.getElementById('saveWarning')) return;
  const el = document.createElement('div');
  el.id = 'saveWarning';
  el.textContent = "⚠️ Couldn't save your latest change. Check that the UniFlow server is running.";
  el.style.cssText = 'position:fixed;bottom:16px;right:16px;background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;padding:10px 14px;border-radius:10px;font-weight:700;font-size:0.82rem;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.12);cursor:pointer;';
  el.onclick = () => el.remove();
  document.body.appendChild(el);
}

function showServerDownMessage() {
  document.documentElement.style.visibility = '';
  document.body.innerHTML = `
    <div style="max-width:520px;margin:12vh auto;padding:28px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;font-family:system-ui,sans-serif;">
      <h2 style="margin-bottom:8px;">Can't reach the UniFlow server</h2>
      <p style="color:#64748b;line-height:1.6;">Start it from the project folder with <code>npm start</code>, then open
      <strong>http://localhost:3000</strong> in your browser (don't open the .html files directly or with Live Server).</p>
    </div>`;
}

function initUserUI() {
  const u = Session.user;
  if (!u) return;
  const initials = u.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
  const avatar = document.querySelector('.user-profile .avatar');
  const nameEl = document.querySelector('.user-profile .name');
  const roleEl = document.querySelector('.user-profile .role');
  if (avatar) avatar.textContent = initials;
  if (nameEl) nameEl.textContent = u.name;
  if (roleEl) roleEl.textContent = u.program || 'Student';

  const actions = document.querySelector('.topbar-actions');
  if (actions && !document.getElementById('logoutBtn')) {
    const btn = document.createElement('button');
    btn.id = 'logoutBtn';
    btn.className = 'btn btn-secondary';
    btn.style.cssText = 'padding: 6px 12px; font-size: 0.8rem;';
    btn.textContent = 'Log out';
    btn.onclick = handleLogout;
    actions.appendChild(btn);
  }
}

async function handleLogout() {
  try { await UniFlowStore.flush(); await Api.request('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
  window.location.replace('login.html');
}

// =============================================================================
// 1. DATA STORE (LocalStorage with Realistic Fallback Seeds)
// =============================================================================
const UniFlowStore = {
  // ---- Server-backed storage -------------------------------------------------
  // Data is loaded from the backend once per page load into _cache, then every
  // change is saved to the backend (per logged-in user).
  _cache: null,
  _saveChain: Promise.resolve(),

  emptyData() {
    return { courses: [], tasks: [], projects: [], profile: {}, routine: null };
  },

  async load() {
    const { data } = await Api.request('GET', '/api/data');
    this._cache = {
      courses: Array.isArray(data.courses) ? data.courses : [],
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      projects: Array.isArray(data.projects) ? data.projects : [],
      profile: data.profile && typeof data.profile === 'object' ? data.profile : {},
      routine: data.routine && typeof data.routine === 'object' ? data.routine : null
    };
  },

  getData() {
    if (!this._cache) this._cache = this.emptyData();
    return this._cache;
  },

  saveData(data) {
    this._cache = data;
    // Snapshot now, send in order (so quick successive changes can't overwrite each other)
    const body = JSON.stringify({ data });
    this._saveChain = this._saveChain
      .then(() => fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'same-origin',
        keepalive: body.length < 60000 // lets the save finish even if the page navigates away
      }))
      .then(res => {
        if (res.status === 401) { window.location.replace('login.html'); return; }
        if (!res.ok) throw new Error('save failed');
      })
      .catch(() => showSaveWarning());
  },

  // Resolves when all pending saves have reached the server
  flush() {
    return this._saveChain;
  },

  // Courses
  getCourses() {
    return this.getData().courses || [];
  },

  addCourse(course) {
    const data = this.getData();
    const newCourse = { id: "c_" + Date.now(), ...course };
    data.courses.push(newCourse);
    this.saveData(data);
    return newCourse;
  },

  deleteCourse(id) {
    const data = this.getData();
    data.courses = data.courses.filter(c => c.id !== id);
    this.saveData(data);
  },

  // Tasks
  getTasks() {
    const tasks = this.getData().tasks || [];
    return tasks.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  },

  addTask(task) {
    const data = this.getData();
    const newTask = {
      id: "t_" + Date.now(),
      status: "pending",
      priority: task.priority || "Medium",
      ...task
    };
    data.tasks.push(newTask);
    this.saveData(data);
    return newTask;
  },

  addTasksBatch(tasksArray) {
    const data = this.getData();
    const added = tasksArray.map(t => ({
      id: "t_" + Math.random().toString(36).substr(2, 9),
      status: "pending",
      priority: t.priority || "Medium",
      ...t
    }));
    data.tasks.push(...added);
    this.saveData(data);
    return added;
  },

  updateTask(id, updates) {
    const data = this.getData();
    const index = data.tasks.findIndex(t => t.id === id);
    if (index !== -1) {
      data.tasks[index] = { ...data.tasks[index], ...updates };
      this.saveData(data);
      return data.tasks[index];
    }
    return null;
  },

  deleteTask(id) {
    const data = this.getData();
    data.tasks = data.tasks.filter(t => t.id !== id);
    this.saveData(data);
  },

  // Projects
  getProjects() {
    return this.getData().projects || [];
  },

  addProject(project) {
    const data = this.getData();
    const newProj = {
      id: "p_" + Date.now(),
      tasks: [],
      ...project
    };
    data.projects.push(newProj);
    this.saveData(data);
    return newProj;
  },

  addSubtask(projectId, subtask) {
    const data = this.getData();
    const proj = data.projects.find(p => p.id === projectId);
    if (proj) {
      const newSub = {
        id: "pt_" + Date.now(),
        status: "pending",
        ...subtask
      };
      proj.tasks.push(newSub);
      this.saveData(data);
      return newSub;
    }
  },

  getProfile() {
    return this.getData().profile || {};
  },

  saveProfile(profile) {
    const data = this.getData();
    data.profile = profile || {};
    this.saveData(data);
  },

  getRoutine() {
    return this.getData().routine || null;
  },

  toggleSubtask(projectId, subtaskId) {
    const data = this.getData();
    const proj = data.projects.find(p => p.id === projectId);
    if (proj) {
      const task = proj.tasks.find(t => t.id === subtaskId);
      if (task) {
        task.status = task.status === 'completed' ? 'pending' : 'completed';
        this.saveData(data);
      }
    }
  }
};

// =============================================================================
// 2. AI ENGINE: DAILY ACTION PLANNER & NLP NOTICE EXTRACTOR
// =============================================================================
const AIEngine = {
  // Generates Daily Action Plan Summary
  generateDailyActionPlan() {
    const tasks = UniFlowStore.getTasks().filter(t => t.status !== 'completed');
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    let dueToday = [];
    let dueIn3Days = [];
    let dueThisWeek = [];

    let assignments = 0;
    let labs = 0;
    let cts = 0;
    let exams = 0;

    tasks.forEach(t => {
      const due = new Date(t.dueDate);
      due.setHours(0, 0, 0, 0);
      const diffDays = Math.ceil((due - now) / (1000 * 60 * 60 * 24));

      if (diffDays <= 0) dueToday.push(t);
      else if (diffDays <= 3) dueIn3Days.push(t);

      if (diffDays <= 7) {
        dueThisWeek.push(t);
        const type = (t.type || '').toLowerCase();
        if (type.includes('assignment')) assignments++;
        else if (type.includes('lab')) labs++;
        else if (type.includes('ct') || type.includes('quiz')) cts++;
        else if (type.includes('exam')) exams++;
      }
    });

    const parts = [];
    if (assignments > 0) parts.push(`${assignments} assignment${assignments > 1 ? 's' : ''}`);
    if (labs > 0) parts.push(`${labs} lab${labs > 1 ? 's' : ''}`);
    if (cts > 0) parts.push(`${cts} CT preparation${cts > 1 ? 's' : ''}`);
    if (exams > 0) parts.push(`${exams} exam${exams > 1 ? 's' : ''}`);

    const workloadSummary = parts.length > 0
      ? parts.join(' + ') + ' this week'
      : 'All caught up! No urgent university deadlines this week.';

    const topTask = dueToday[0] || dueIn3Days[0] || dueThisWeek[0];
    const recommendation = topTask
      ? `Focus on '${topTask.title}' for ${topTask.courseCode}. It has high urgency and is due on ${topTask.dueDate}.`
      : 'Great job! You have no immediate deadlines. Use this time to read course notes or advance group projects.';

    return {
      workloadSummary,
      recommendation,
      topTask,
      stats: {
        totalPending: tasks.length,
        dueThisWeek: dueThisWeek.length,
        assignments,
        labs,
        cts,
        exams
      },
      actionList: [...dueToday, ...dueIn3Days, ...dueThisWeek.filter(t => !dueToday.includes(t) && !dueIn3Days.includes(t))]
    };
  },

  // NLP Heuristic Notice Parser
  extractDeadlinesFromText(text) {
    const chunks = text.match(/[^.!?\n]+[.!?\n]+/g) || text.split(/\r?\n/);
    const extracted = [];

    const courseRegex = /\b([A-Z]{2,4})[\s-]?(\d{3})\b/gi;
    const typePatterns = [
      { regex: /\b(assignment|homework|hw|problem\s?set)\b/i, type: "Assignment" },
      { regex: /\b(class\s?test|c\.?t\.?|quiz|assessment)\b/i, type: "CT" },
      { regex: /\b(lab\s?report|experiment|lab)\b/i, type: "Lab" },
      { regex: /\b(midterm|final\s?exam|semester\s?final|exam)\b/i, type: "Exam" }
    ];

    const standardDateRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[.\s]+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/i;
    const isoDateRegex = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/;

    const monthMap = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
      january: '01', february: '02', march: '03', april: '04', june: '06',
      july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
    };

    const now = new Date();
    const currentYear = now.getFullYear();

    for (const chunk of chunks) {
      const clean = chunk.trim();
      if (clean.length < 8) continue;

      let detectedType = null;
      for (const p of typePatterns) {
        if (p.regex.test(clean)) {
          detectedType = p.type;
          break;
        }
      }

      const courseMatch = clean.match(courseRegex);
      const detectedCourse = courseMatch ? courseMatch[0].toUpperCase().replace('-', ' ') : null;

      let detectedDate = null;
      const stdMatch = clean.match(standardDateRegex);
      const isoMatch = clean.match(isoDateRegex);

      if (stdMatch) {
        const monthKey = stdMatch[1].toLowerCase().replace('.', '');
        const monthNum = monthMap[monthKey] || '01';
        const day = String(parseInt(stdMatch[2], 10)).padStart(2, '0');
        const year = stdMatch[3] ? stdMatch[3] : currentYear;
        detectedDate = `${year}-${monthNum}-${day}`;
      } else if (isoMatch) {
        detectedDate = `${isoMatch[1]}-${String(isoMatch[2]).padStart(2, '0')}-${String(isoMatch[3]).padStart(2, '0')}`;
      } else if (/tomorrow/i.test(clean)) {
        const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        detectedDate = d.toISOString().split('T')[0];
      } else if (/next week|friday/i.test(clean)) {
        const d = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
        detectedDate = d.toISOString().split('T')[0];
      }

      if (detectedType || (detectedCourse && detectedDate) || (detectedDate && /due|submit|held|exam/i.test(clean))) {
        let title = clean.replace(/^(dear students|notice|announcement)[:,-]?\s*/i, '').trim();
        if (title.length > 80) title = title.substring(0, 77) + '...';

        let priority = "Medium";
        if (/strict|urgent|mandatory|exam|midterm/i.test(clean)) priority = "Urgent";
        else if (detectedType === "Assignment" || detectedType === "CT") priority = "High";

        extracted.push({
          title: title || `${detectedCourse || 'Academic'} ${detectedType || 'Task'}`,
          courseCode: detectedCourse || "General",
          type: detectedType || "Assignment",
          dueDate: detectedDate || new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          priority
        });
      }
    }

    return extracted;
  }
};

// =============================================================================
// 3. COMMON PAGE HELPERS (Header, Active Nav, Notification Count)
// =============================================================================
function initCommonUI() {
  // Update Notification Badge Count (< 3 days due)
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const urgentCount = UniFlowStore.getTasks().filter(t => {
    if (t.status === 'completed') return false;
    const due = new Date(t.dueDate);
    due.setHours(0, 0, 0, 0);
    const diff = Math.ceil((due - now) / (1000 * 60 * 60 * 24));
    return diff <= 3;
  }).length;

  const badgeEl = document.querySelector('.notification-badge');
  if (badgeEl) {
    badgeEl.textContent = urgentCount;
    badgeEl.style.display = urgentCount > 0 ? 'flex' : 'none';
  }

  // Update current active link in sidebar
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.nav-item').forEach(link => {
    const href = link.getAttribute('href');
    if (href === currentPage || (currentPage === '' && href === 'index.html')) {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });
}

// =============================================================================
// 4. PAGE INITIALIZERS
// =============================================================================

// --- PAGE: Dashboard (index.html) ---
function initDashboardPage() {
  const plan = AIEngine.generateDailyActionPlan();

  // Populate AI Banner
  const bannerHeadline = document.getElementById('aiBannerHeadline');
  const bannerFocus = document.getElementById('aiBannerFocus');
  if (bannerHeadline) bannerHeadline.textContent = plan.workloadSummary;
  if (bannerFocus) bannerFocus.textContent = plan.recommendation;

  // Populate Metrics
  const courses = UniFlowStore.getCourses();
  const elCoursesCount = document.getElementById('metricCoursesCount');
  const elDueWeek = document.getElementById('metricDueThisWeek');
  const elPending = document.getElementById('metricPending');
  const elCts = document.getElementById('metricUpcomingCts');

  if (elCoursesCount) elCoursesCount.textContent = courses.length;
  if (elDueWeek) elDueWeek.textContent = plan.stats.dueThisWeek;
  if (elPending) elPending.textContent = plan.stats.totalPending;
  if (elCts) elCts.textContent = plan.stats.cts;

  // Render Action Checklist
  const checklistContainer = document.getElementById('dashboardChecklist');
  if (checklistContainer) {
    if (plan.actionList.length === 0) {
      checklistContainer.innerHTML = `
        <div style="text-align:center; padding: 32px; color: #94a3b8;">
          <div style="font-size: 2rem;">🎉</div>
          <p style="font-weight: 700; margin-top: 8px;">All tasks completed!</p>
          <p style="font-size: 0.8rem;">You have zero urgent deadlines this week.</p>
        </div>
      `;
    } else {
      checklistContainer.innerHTML = plan.actionList.map(task => `
        <div class="action-item ${task.status === 'completed' ? 'done' : ''}" id="item-${task.id}">
          <div style="display: flex; align-items: center; gap: 12px;">
            <input type="checkbox" class="task-checkbox" 
                   ${task.status === 'completed' ? 'checked' : ''} 
                   onchange="handleChecklistToggle('${task.id}', this)">
            <div>
              <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px;">
                <span class="course-tag">${task.courseCode}</span>
                <span class="badge badge-${task.priority.toLowerCase()}">${task.priority}</span>
                <span class="badge badge-${task.type.toLowerCase()}">${task.type}</span>
              </div>
              <div class="task-title" style="font-weight: 600; font-size: 0.92rem;">
                ${task.title}
              </div>
            </div>
          </div>
          <div style="font-size: 0.78rem; font-weight: 700; color: #ef4444;">
            Due ${task.dueDate}
          </div>
        </div>
      `).join('');
    }
  }

  // Render Courses Mini List
  const miniCoursesContainer = document.getElementById('dashboardCoursesMini');
  if (miniCoursesContainer) {
    miniCoursesContainer.innerHTML = courses.slice(0, 4).map(c => `
      <div style="padding: 10px 12px; border-left: 4px solid ${c.color || '#2563eb'}; background: #f8fafc; border-radius: 6px; margin-bottom: 8px;">
        <div style="font-weight: 700; font-size: 0.85rem; color: #0f172a;">${c.code} - ${c.name}</div>
        <div style="font-size: 0.74rem; color: #64748b; margin-top: 2px;">${c.instructor} • ${c.schedule}</div>
      </div>
    `).join('');
  }
}

function handleChecklistToggle(taskId, checkbox) {
  const newStatus = checkbox.checked ? 'completed' : 'pending';
  UniFlowStore.updateTask(taskId, { status: newStatus });
  const item = document.getElementById(`item-${taskId}`);
  if (item) {
    if (checkbox.checked) item.classList.add('done');
    else item.classList.remove('done');
  }
  initCommonUI();
}

// --- PAGE: Notice Scanner (scanner.html) ---
let extractedTasksCache = [];

function loadSampleNoticeIntoScanner() {
  const textarea = document.getElementById('scannerNoticeText');
  if (textarea) {
    textarea.value = 
`Dear Students of 3rd Year,
Please note the following critical course deadlines:
1. CSE 301 Assignment 2 on Schema Normalization is due on September 15, 2026 at 11:59 PM.
2. Class Test 1 (CT) for MAT 202 covering Propositional Logic will be held on September 18, 2026.
3. PHY 105 Lab Report 3 on Planck's Constant is due next Friday.
4. Midterm Examination for CSE 301 is scheduled for September 28, 2026.
Late submissions will not be accepted.`;
  }
}

function runNoticeExtraction() {
  const textarea = document.getElementById('scannerNoticeText');
  if (!textarea || !textarea.value.trim()) {
    alert("Please paste a notice or click '⚡ Load Sample Notice' first!");
    return;
  }

  extractedTasksCache = AIEngine.extractDeadlinesFromText(textarea.value);
  if (extractedTasksCache.length === 0) {
    alert("No dates or course deadlines found in this text. Try providing clearer dates like 'September 15'.");
  }
  renderExtractedTasks();
}

function renderExtractedTasks() {
  const tasks = extractedTasksCache;

  const resultContainer = document.getElementById('scannerResultsArea');
  const listContainer = document.getElementById('extractedTasksList');
  const countBadge = document.getElementById('extractedCountBadge');

  if (resultContainer && listContainer) {
    if (tasks.length === 0) {
      resultContainer.style.display = 'none';
      return;
    }

    resultContainer.style.display = 'block';
    if (countBadge) countBadge.textContent = `${tasks.length} Deadlines Detected`;

    listContainer.innerHTML = tasks.map((t, idx) => `
      <div class="action-item" style="display: grid; grid-template-columns: 100px 1fr 120px 130px 40px; gap: 10px; align-items: center;">
        <input type="text" class="form-control" value="${t.courseCode}" onchange="updateExtractedTask(${idx}, 'courseCode', this.value)" style="padding: 6px; font-weight: 700;">
        <input type="text" class="form-control" value="${t.title}" onchange="updateExtractedTask(${idx}, 'title', this.value)" style="padding: 6px;">
        <select class="form-control" onchange="updateExtractedTask(${idx}, 'type', this.value)" style="padding: 6px;">
          <option ${t.type === 'Assignment' ? 'selected' : ''}>Assignment</option>
          <option ${t.type === 'CT' ? 'selected' : ''}>CT</option>
          <option ${t.type === 'Lab' ? 'selected' : ''}>Lab</option>
          <option ${t.type === 'Exam' ? 'selected' : ''}>Exam</option>
        </select>
        <input type="date" class="form-control" value="${t.dueDate}" onchange="updateExtractedTask(${idx}, 'dueDate', this.value)" style="padding: 6px;">
        <button class="btn btn-danger" style="padding: 6px; font-size: 0.8rem;" onclick="removeExtractedTask(${idx})">✕</button>
      </div>
    `).join('');
  }
}

function updateExtractedTask(index, field, value) {
  if (extractedTasksCache[index]) {
    extractedTasksCache[index][field] = value;
  }
}

function removeExtractedTask(index) {
  extractedTasksCache.splice(index, 1);
  renderExtractedTasks();
}

async function saveExtractedTasksToSchedule() {
  if (extractedTasksCache.length === 0) return;
  UniFlowStore.addTasksBatch(extractedTasksCache);
  await UniFlowStore.flush();
  alert(`🎉 Successfully saved ${extractedTasksCache.length} tasks to your calendar & assignments schedule!`);
  window.location.href = 'calendar.html';
}

// --- PAGE: Smart Calendar (calendar.html) ---
let calendarYear = new Date().getFullYear();
let calendarMonth = new Date().getMonth();

function initCalendarPage() {
  renderCalendar();
}

function renderCalendar() {
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const titleEl = document.getElementById('calendarMonthYear');
  if (titleEl) titleEl.textContent = `${monthNames[calendarMonth]} ${calendarYear}`;

  const gridEl = document.getElementById('calendarGrid');
  if (!gridEl) return;

  const tasks = UniFlowStore.getTasks();
  const firstDay = new Date(calendarYear, calendarMonth, 1).getDay();
  const totalDays = new Date(calendarYear, calendarMonth + 1, 0).getDate();

  let html = '';
  // Empty slots
  for (let i = 0; i < firstDay; i++) {
    html += `<div style="min-height: 85px; background: #f8fafc40; border-radius: 8px;"></div>`;
  }

  // Days
  const todayStr = new Date().toISOString().split('T')[0];
  for (let d = 1; d <= totalDays; d++) {
    const formattedDate = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayTasks = tasks.filter(t => t.dueDate === formattedDate);
    const isToday = formattedDate === todayStr;

    html += `
      <div class="card" onclick="selectCalendarDay('${formattedDate}')" 
           style="min-height: 90px; padding: 8px; cursor: pointer; border-color: ${isToday ? '#2563eb' : '#e2e8f0'}; background: ${isToday ? '#eff6ff' : '#ffffff'}; display: flex; flex-direction: column; justify-content: space-between;">
        <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 0.82rem; color: ${isToday ? '#2563eb' : '#334155'};">
          <span>${d}</span>
          ${dayTasks.length > 0 ? `<span style="background: #e0e7ff; color: #3730a3; padding: 1px 6px; border-radius: 10px; font-size: 0.65rem;">${dayTasks.length}</span>` : ''}
        </div>
        <div style="display: flex; flex-direction: column; gap: 2px; margin-top: 4px;">
          ${dayTasks.slice(0, 2).map(t => `
            <div style="font-size: 0.65rem; font-weight: 700; padding: 2px 4px; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: ${t.type === 'Exam' ? '#fee2e2' : t.type === 'CT' ? '#fdf4ff' : '#eff6ff'}; color: ${t.type === 'Exam' ? '#dc2626' : t.type === 'CT' ? '#9333ea' : '#2563eb'};">
              ${t.courseCode}: ${t.title}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  gridEl.innerHTML = html;
  selectCalendarDay(todayStr);
}

function prevCalendarMonth() {
  calendarMonth--;
  if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear--;
  }
  renderCalendar();
}

function nextCalendarMonth() {
  calendarMonth++;
  if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear++;
  }
  renderCalendar();
}

function selectCalendarDay(dateStr) {
  const selectedLabel = document.getElementById('selectedDayLabel');
  const detailsArea = document.getElementById('selectedDayTasksArea');
  if (selectedLabel) selectedLabel.textContent = dateStr;

  if (detailsArea) {
    const dayTasks = UniFlowStore.getTasks().filter(t => t.dueDate === dateStr);
    if (dayTasks.length === 0) {
      detailsArea.innerHTML = `<p style="font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 24px;">No deadlines scheduled for this date.</p>`;
    } else {
      detailsArea.innerHTML = dayTasks.map(t => `
        <div style="padding: 12px; border-radius: 8px; background: #f8fafc; border-left: 4px solid #2563eb; margin-bottom: 8px;">
          <div style="display: flex; gap: 6px; margin-bottom: 4px;">
            <span class="course-tag">${t.courseCode}</span>
            <span class="badge badge-${t.type.toLowerCase()}">${t.type}</span>
          </div>
          <div style="font-size: 0.88rem; font-weight: 700;">${t.title}</div>
          ${t.description ? `<p style="font-size: 0.78rem; color: #64748b; margin-top: 4px;">${t.description}</p>` : ''}
        </div>
      `).join('');
    }
  }
}

// --- PAGE: Courses Hub (courses.html) ---
function initCoursesPage() {
  renderCoursesList();
}

function renderCoursesList() {
  const listEl = document.getElementById('coursesGrid');
  if (!listEl) return;

  const courses = UniFlowStore.getCourses();
  const tasks = UniFlowStore.getTasks();

  listEl.innerHTML = courses.map(c => {
    const courseTasks = tasks.filter(t => t.courseCode === c.code && t.status !== 'completed');
    return `
      <div class="card" style="border-top: 5px solid ${c.color || '#2563eb'}; display: flex; flex-direction: column; justify-content: space-between; gap: 16px;">
        <div>
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <span class="course-tag" style="background: ${c.color || '#2563eb'}15; color: ${c.color || '#2563eb'}; font-size: 0.82rem;">${c.code}</span>
            <span style="font-size: 0.75rem; font-weight: 700; color: #64748b;">${c.credits} Credits</span>
          </div>
          <h3 style="font-size: 1.1rem; font-weight: 800; color: #0f172a; margin-bottom: 12px;">${c.name}</h3>
          <div style="font-size: 0.82rem; color: #475569; display: flex; flex-direction: column; gap: 6px;">
            <div>👨‍🏫 <strong>Instructor:</strong> ${c.instructor || 'TBD'}</div>
            <div>📍 <strong>Venue:</strong> ${c.room || 'TBD'}</div>
            <div>⏰ <strong>Schedule:</strong> ${c.schedule || 'TBD'}</div>
          </div>
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid #f1f5f9; padding-top: 12px;">
          <span style="font-size: 0.75rem; color: #2563eb; font-weight: 700;">${courseTasks.length} Pending Deadlines</span>
          <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.75rem;" onclick="removeCourse('${c.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function removeCourse(id) {
  if (confirm("Are you sure you want to remove this course?")) {
    UniFlowStore.deleteCourse(id);
    renderCoursesList();
    initCommonUI();
  }
}

function handleAddCourseSubmit(e) {
  e.preventDefault();
  const code = document.getElementById('newCourseCode').value;
  const name = document.getElementById('newCourseName').value;
  const instructor = document.getElementById('newCourseInstructor').value;
  const room = document.getElementById('newCourseRoom').value;
  const credits = document.getElementById('newCourseCredits').value;
  const schedule = document.getElementById('newCourseSchedule').value;

  UniFlowStore.addCourse({ code, name, instructor, room, credits, schedule, color: '#2563eb' });
  document.getElementById('addCourseDialog').close();
  e.target.reset();
  renderCoursesList();
  initCommonUI();
}

// --- PAGE: Tasks & Deadlines (tasks.html) ---
let currentTaskFilter = 'all';

function initTasksPage() {
  renderTasksList();
}

function setTaskFilter(filter) {
  currentTaskFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(b => {
    if (b.dataset.filter === filter) b.classList.add('btn-primary');
    else b.classList.remove('btn-primary');
  });
  renderTasksList();
}

function renderTasksList() {
  const container = document.getElementById('tasksListContainer');
  if (!container) return;

  let tasks = UniFlowStore.getTasks();
  if (currentTaskFilter !== 'all') {
    tasks = tasks.filter(t => t.status === currentTaskFilter || t.type.toLowerCase() === currentTaskFilter.toLowerCase());
  }

  if (tasks.length === 0) {
    container.innerHTML = `<div class="card" style="text-align: center; padding: 40px; color: #94a3b8;">No tasks found in this view.</div>`;
    return;
  }

  container.innerHTML = tasks.map(t => `
    <div class="card action-item ${t.status === 'completed' ? 'done' : ''}" style="margin-bottom: 12px; padding: 18px 20px;">
      <div style="display: flex; align-items: center; gap: 16px;">
        <input type="checkbox" class="task-checkbox" ${t.status === 'completed' ? 'checked' : ''} onchange="handleTaskStatusChange('${t.id}', this)">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
            <span class="course-tag">${t.courseCode}</span>
            <span class="badge badge-${t.priority.toLowerCase()}">${t.priority}</span>
            <span class="badge badge-${t.type.toLowerCase()}">${t.type}</span>
          </div>
          <h3 class="task-title" style="font-size: 1rem; font-weight: 700; color: #0f172a;">${t.title}</h3>
          ${t.description ? `<p style="font-size: 0.82rem; color: #64748b; margin-top: 4px;">${t.description}</p>` : ''}
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 14px;">
        <span style="font-size: 0.82rem; font-weight: 700; color: #334155;">Due ${t.dueDate}</span>
        <button class="btn btn-danger" style="padding: 4px 8px; font-size: 0.75rem;" onclick="removeTask('${t.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

function handleTaskStatusChange(id, checkbox) {
  UniFlowStore.updateTask(id, { status: checkbox.checked ? 'completed' : 'pending' });
  renderTasksList();
  initCommonUI();
}

function removeTask(id) {
  UniFlowStore.deleteTask(id);
  renderTasksList();
  initCommonUI();
}

function handleAddTaskSubmit(e) {
  e.preventDefault();
  const title = document.getElementById('taskTitle').value;
  const courseCode = document.getElementById('taskCourse').value;
  const type = document.getElementById('taskType').value;
  const dueDate = document.getElementById('taskDueDate').value;
  const priority = document.getElementById('taskPriority').value;
  const description = document.getElementById('taskDesc').value;

  UniFlowStore.addTask({ title, courseCode, type, dueDate, priority, description });
  document.getElementById('addTaskDialog').close();
  e.target.reset();
  renderTasksList();
  initCommonUI();
}

// --- PAGE: Group Projects (projects.html) ---
function initProjectsPage() {
  renderProjectsList();
}

function handleAddProject() {
  const title = document.getElementById('newProjTitle').value.trim();
  if (!title) return;
  const courseCode = document.getElementById('newProjCourse').value.trim() || 'General';
  const description = document.getElementById('newProjDesc').value.trim();
  const deadline = document.getElementById('newProjDeadline').value;
  UniFlowStore.addProject({ title, courseCode, description, deadline, members: [Session.user ? Session.user.name : 'You'] });
  renderProjectsList();
}

function renderProjectsList() {
  const container = document.getElementById('projectsContainer');
  if (!container) return;

  const projects = UniFlowStore.getProjects();
  const newProjectForm = `
    <div class="card">
      <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 10px;">＋ Start a new group project</h4>
      <div style="display: grid; grid-template-columns: 1fr 140px 160px; gap: 8px; margin-bottom: 8px;">
        <input type="text" id="newProjTitle" class="form-control" placeholder="Project title" style="padding: 8px 12px;">
        <input type="text" id="newProjCourse" class="form-control" placeholder="Course code" style="padding: 8px 12px;">
        <input type="date" id="newProjDeadline" class="form-control" style="padding: 8px 12px;">
      </div>
      <div style="display: flex; gap: 8px;">
        <input type="text" id="newProjDesc" class="form-control" placeholder="Short description (optional)" style="padding: 8px 12px;">
        <button class="btn btn-primary" onclick="handleAddProject()">Create</button>
      </div>
    </div>`;
  container.innerHTML = projects.map(p => {
    const completed = p.tasks.filter(t => t.status === 'completed').length;
    const total = p.tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    return `
      <div class="card" style="margin-bottom: 20px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span class="course-tag">${p.courseCode}</span>
          <span style="font-size: 0.85rem; font-weight: 800; color: #10b981;">${pct}% Completed</span>
        </div>
        <h2 style="font-size: 1.3rem; font-weight: 800; color: #0f172a;">${p.title}</h2>
        <p style="font-size: 0.88rem; color: #64748b; margin-top: 4px;">${p.description}</p>
        
        <div style="margin: 12px 0 16px;">
          <div style="height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
            <div style="width: ${pct}%; height: 100%; background: #2563eb; transition: width 0.3s;"></div>
          </div>
        </div>

        <h4 style="font-size: 0.95rem; font-weight: 700; margin-bottom: 10px;">Subtasks & Teammate Delegation</h4>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
          ${p.tasks.map(t => `
            <div class="action-item ${t.status === 'completed' ? 'done' : ''}" style="padding: 10px 14px; margin-bottom: 0;">
              <div style="display: flex; align-items: center; gap: 10px;">
                <input type="checkbox" class="task-checkbox" ${t.status === 'completed' ? 'checked' : ''} onchange="toggleProjectSubtask('${p.id}', '${t.id}')">
                <span class="task-title" style="font-size: 0.88rem; font-weight: 600;">${t.title}</span>
              </div>
              <span style="font-size: 0.75rem; background: #f1f5f9; padding: 3px 8px; border-radius: 6px; font-weight: 700;">👤 ${t.assignee}</span>
            </div>
          `).join('')}
        </div>

        <div style="display: flex; gap: 8px;">
          <input type="text" id="newSubTitle-${p.id}" class="form-control" placeholder="New subtask deliverable..." style="padding: 8px 12px;">
          <input type="text" id="newSubAssignee-${p.id}" class="form-control" placeholder="Assignee..." style="width: 140px; padding: 8px 12px;">
          <button class="btn btn-primary" onclick="handleAddSubtask('${p.id}')">Add</button>
        </div>
      </div>
    `;
  }).join('') + newProjectForm;
}

function toggleProjectSubtask(projId, subtaskId) {
  UniFlowStore.toggleSubtask(projId, subtaskId);
  renderProjectsList();
}

function handleAddSubtask(projId) {
  const titleInput = document.getElementById(`newSubTitle-${projId}`);
  const assigneeInput = document.getElementById(`newSubAssignee-${projId}`);
  if (!titleInput || !titleInput.value.trim()) return;

  UniFlowStore.addSubtask(projId, {
    title: titleInput.value.trim(),
    assignee: assigneeInput.value.trim() || 'Unassigned'
  });
  renderProjectsList();
}

// --- PAGE: Study Analytics (analytics.html) ---
function initAnalyticsPage() {
  const tasks = UniFlowStore.getTasks();
  const courses = UniFlowStore.getCourses();

  const total = tasks.length;
  const completed = tasks.filter(t => t.status === 'completed').length;
  const pending = total - completed;
  const rate = total > 0 ? Math.round((completed / total) * 100) : 0;

  const urgent = tasks.filter(t => t.priority === 'Urgent' && t.status !== 'completed').length;
  const high = tasks.filter(t => t.priority === 'High' && t.status !== 'completed').length;
  const stress = Math.min(10, Math.max(1, urgent * 3 + high * 1.5 + pending * 0.4)).toFixed(1);

  const elRate = document.getElementById('metricCompletionRate');
  const elStress = document.getElementById('metricStressIndex');
  const elPending = document.getElementById('metricActiveDeadlines');

  if (elRate) elRate.textContent = `${rate}%`;
  if (elStress) elStress.textContent = `${stress} / 10`;
  if (elPending) elPending.textContent = pending;

  // Render course workload breakdown
  const workloadContainer = document.getElementById('analyticsWorkloadBars');
  if (workloadContainer) {
    workloadContainer.innerHTML = courses.map(c => {
      const cTasks = tasks.filter(t => t.courseCode === c.code && t.status !== 'completed');
      const pct = total > 0 ? Math.round((cTasks.length / total) * 100) : 0;
      return `
        <div style="margin-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; font-size: 0.85rem; font-weight: 700; margin-bottom: 4px;">
            <span>${c.code} - ${c.name}</span>
            <span>${cTasks.length} tasks (${pct}%)</span>
          </div>
          <div style="height: 8px; background: #e2e8f0; border-radius: 4px; overflow: hidden;">
            <div style="width: ${pct}%; height: 100%; background: ${c.color || '#2563eb'};"></div>
          </div>
        </div>
      `;
    }).join('');
  }
}


function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\'':'&#39;','"':'&quot;'}[ch])); }

// --- PAGE: Student Profile + Routine Intelligence ---------------------------
async function initProfilePage() {
  const profile = UniFlowStore.getProfile();
  const fields = {
    fullName: 'profileFullName',
    studentId: 'profileStudentId',
    department: 'profileDepartment',
    program: 'profileProgram',
    email: 'profileEmail',
    phone: 'profilePhone',
    semester: 'profileSemester',
    section: 'profileSection'
  };
  Object.entries(fields).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.value = profile[key] || Session.user[key] || '';
  });

  const routine = UniFlowStore.getRoutine();
  if (routine) renderRoutineAnalysis(routine.analysis);

  const form = document.getElementById('profileForm');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    const next = {};
    Object.entries(fields).forEach(([key, id]) => {
      next[key] = (document.getElementById(id)?.value || '').trim();
    });
    next.academicYear = document.getElementById('detectedAcademicYear')?.textContent || '';
    UniFlowStore.saveProfile(next);
    try {
      await Api.request('PUT', '/api/profile', { profile: next });
      showProfileStatus('Profile saved successfully.');
    } catch (err) {
      showProfileStatus(err.message || 'Could not save profile.', true);
    }
  };
}

function showProfileStatus(message, error=false) {
  const el = document.getElementById('profileStatus');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
    el.style.color = error ? '#b91c1c' : '#047857';
  }
}

function renderRoutineAnalysis(analysis) {
  if (!analysis) return;
  const card = document.getElementById('routineAnalysis');
  if (card) card.style.display = 'block';
  const set = (id, value) => { const el=document.getElementById(id); if(el) el.textContent=value || 'Unknown'; };
  set('detectedAcademicYear', analysis.academicYear);
  set('detectedSeries', analysis.series);
  set('detectedSemester', analysis.semester);
  set('detectedSection', analysis.section);
  set('detectedConfidence', analysis.confidence != null ? `${Math.round(analysis.confidence * 100)}%` : '—');
  const list = document.getElementById('routineCourses');
  if (list) list.innerHTML = (analysis.courses || []).slice(0, 30).map(c =>
    `<div class="action-item" style="margin-bottom:8px;"><div><strong>${escapeHtml(c.code || '')}</strong> ${escapeHtml(c.name || '')}</div><span class="course-tag">${escapeHtml(c.day || '')} ${escapeHtml(c.start || '')}-${escapeHtml(c.end || '')}</span></div>`
  ).join('') || '<p style="color:#64748b;">No class rows were confidently extracted.</p>';
}

async function uploadRoutineFile() {
  const input = document.getElementById('routineFile');
  const status = document.getElementById('routineUploadStatus');
  if (!input?.files?.[0]) return;
  const file = input.files[0];
  if (file.size > 10 * 1024 * 1024) { status.textContent='File is larger than 10 MB.'; status.style.color='#b91c1c'; return; }
  status.textContent = 'Uploading routine and asking Smart AI to detect your academic year…';
  status.style.color = '#475569';
  try {
    const dataUrl = await new Promise((resolve,reject) => {
      const r = new FileReader();
      r.onload=()=>resolve(r.result); r.onerror=reject; r.readAsDataURL(file);
    });
    const result = await Api.request('POST','/api/routine/analyze',{fileName:file.name,dataUrl});
    const storeData = UniFlowStore.getData();
    storeData.routine = { fileName:file.name, mime:file.type, uploadedAt:new Date().toISOString(), analysis:result.analysis };
    storeData.profile = result.profile || UniFlowStore.getProfile();
    // Turn confidently extracted routine rows into reusable course records.
    (result.analysis.courses || []).forEach(c => {
      if (!c.code || storeData.courses.some(existing => existing.code === c.code)) return;
      storeData.courses.push({
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        code: c.code,
        name: c.name || c.code,
        credits: 0,
        instructor: '',
        room: c.room || '',
        schedule: c.day && c.start ? `${c.day} ${c.start}-${c.end || ''}` : ''
      });
    });
    UniFlowStore.saveData(storeData);
    renderRoutineAnalysis(result.analysis);
    status.textContent = `Routine analyzed. Detected ${result.analysis.academicYear || 'academic year'}${result.analysis.series ? ` (${result.analysis.series} series)` : ''}.`;
    status.style.color='#047857';
  } catch (err) {
    status.textContent = err.message || 'Routine analysis failed.';
    status.style.color='#b91c1c';
  }
}

async function syncRutineFromSources() {
  const el=document.getElementById('sourceStatus');
  if (el) el.textContent='RUET sources are connected as official reference links for Smart AI.';
}

// =============================================================================
// 5. GLOBAL BOOTSTRAPPER (Runs on every page load)
// =============================================================================
// Hide the page until we know the user is logged in (prevents a flash of the dashboard)
document.documentElement.style.visibility = 'hidden';

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const me = await Api.request('GET', '/api/auth/me');
    Session.user = me.user;
    await UniFlowStore.load();
  } catch (e) {
    if (e.status === 401) { window.location.replace('login.html'); return; }
    showServerDownMessage();
    return;
  }

  initUserUI();
  initCommonUI();

  // Route to the appropriate page initializer based on the current HTML file
  const page = document.body.dataset.page;
  if (page === 'dashboard') initDashboardPage();
  else if (page === 'scanner') { /* Scanner wait for button clicks */ }
  else if (page === 'calendar') initCalendarPage();
  else if (page === 'courses') initCoursesPage();
  else if (page === 'tasks') initTasksPage();
  else if (page === 'projects') initProjectsPage();
  else if (page === 'analytics') initAnalyticsPage();
  else if (page === 'profile') initProfilePage();

  document.documentElement.style.visibility = '';
});
