"use strict";

const assignmentFields = ["inv1", "inv2"];
const MAX_MONITORING_GAP = 1;
let activeDistribution = null;

function monitoringRoster() {
  return [
    ...state.trainers.map(trainer => ({trainer, max: trainer.max ?? 999, group: null})),
    ...leaders().map(entry => ({trainer: entry.trainer, max: entry.max, group: leadershipGroup(entry)}))
  ];
}

function monitoringOwnExamAllowed(trainer) {
  const policy = state.meta?.ownExamMonitoringMode;
  return policy === "allow" || (policy !== "block" && trainer.allowOwnExamMonitoring === true);
}

function validEmployeeId(value) {
  const id = canonicalTrainerId(value);
  return id && !["-", "—"].includes(id) && !/^0+$/.test(id) ? id : "";
}

function distributionPeople(strict = true) {
  const roster = new Map(), byName = new Map(), byEmployee = new Map();
  for (const entry of monitoringRoster()) {
    const trainer = entry.trainer;
    const employee = validEmployeeId(trainer.id);
    const id = employee ? "staff:" + employee : "record:" + (trainer.key || norm(trainer.name));
    const name = norm(trainer.name);
    if (!name || name === "-") {
      if (strict) throw new Error("تحقق من أسماء المدربين والقيادات قبل التوزيع.");
      continue;
    }
    if (roster.has(id) || byName.has(name)) {
      if (strict) throw new Error(`يوجد سجل مكرر للمدرب ${trainer.name}. صحح السجل قبل التوزيع.`);
      continue;
    }
    const max = Number(entry.max);
    if (strict && (!Number.isSafeInteger(max) || max < 0)) throw new Error(`الحد الأعلى للمراقب ${trainer.name} غير صالح.`);
    const person = {
      id, name: trainer.name, trainer, max, group: entry.group, active: activeTrainer(trainer),
      departments: [...new Set(String(trainer.dept || "").split(/[،,]/)
        .map(x => norm(normalizeDepartment(x.trim()))).filter(Boolean))],
      allowThree: trainer.allowThreeConsecutive === true
    };
    roster.set(id, person);
    byName.set(name, person);
    if (employee) byEmployee.set(employee, person);
  }
  return {roster, byName, byEmployee};
}

function distributionRoomId(value) {
  if (!value) return null;
  return roomCode(roomRecord(value)) || "unknown:" + value;
}

function courseOwnership(working, people) {
  const {byName, byEmployee} = people;
  const headers = fieldMap(state.ss01Headers);
  const courseRows = new Map();
  for (const row of state.ss01) {
    const section = norm(row[headers.section]);
    if (!courseRows.has(section)) courseRows.set(section, []);
    courseRows.get(section).push(row);
  }
  const slots = new Map(), records = new Map();
  for (const exam of working) {
    const owners = new Set(), departments = new Set();
    function register(person) {
      owners.add(person.id);
      for (const department of person.departments) departments.add(department);
    }
    for (const row of courseRows.get(norm(exam.section)) || []) {
      const employee = validEmployeeId(row[headers.trainerId]);
      const named = byName.get(norm(row[headers.trainer]));
      const person = employee ? byEmployee.get(employee) || (named && !validEmployeeId(named.trainer.id) ? named : null) : named;
      if (person) register(person);
      else if (employee) owners.add("ss01:" + employee);
    }
    const recordedName = norm(exam.courseTrainer);
    if (!owners.size && recordedName && !["-", "—"].includes(recordedName)) {
      const person = byName.get(recordedName);
      if (person) register(person);
      else owners.add("name:" + recordedName);
    }
    records.set(exam, {owners:[...owners], departments});
    const slot = slotKey(exam);
    if (!slots.has(slot)) slots.set(slot, {exam, owners:new Set()});
    for (const owner of owners) slots.get(slot).owners.add(owner);
  }
  return {slots, records, byName};
}

function distributionInput(mode) {
  const working = eligibleExams();
  if (!working.length) throw new Error("أضف اختبارات إلى الجدول أولًا.");
  const monitors = mode !== "rooms", rooms = mode !== "monitors";
  const peopleIndex = distributionPeople();
  const {roster, byName} = peopleIndex;
  const {slots, records} = courseOwnership(working, peopleIndex);
  const periods = [...new Set(state.periods.map(p => Number(p.id)))].sort((a,b) => a-b);
  const rawById = new Map();
  const enrollment = sectionEnrollments();
  const homes = sectionDepartmentBuildings();
  const unknownOwners = [];
  const exams = working.map(e => {
    if (!e.id || rawById.has(e.id)) throw new Error("يوجد معرّف اختبار مكرر أو مفقود. راجع نسخة العمل.");
    rawById.set(e.id, e);
    const period = Number(e.period), date = dayKey(e), slot = slotKey(e);
    if (!e.date || calendarTime(e.date) === null || !periods.includes(period)) {
      throw new Error(`أدخل تاريخًا وفترة صحيحين للشعبة ${e.section}.`);
    }
    const {owners, departments} = records.get(e);
    if (!owners.length) unknownOwners.push(e.section);
    const home = departments.size === 1 ? homes.get([...departments][0]) || "" : "";
    const previous = {room: distributionRoomId(e.room)};
    for (const field of assignmentFields) {
      previous[field] = e[field] ? byName.get(norm(e[field]))?.id || "unknown:" + e[field] : null;
    }
    const n = enrollment.get(norm(e.section));
    return {id:e.id, section:e.section, date, period, slot, home,
      department:norm(normalizeDepartment(e.dept)), owners,
      enrollment:Number.isSafeInteger(n) && n >= 0 ? n : null,
      previous, pins:Object.fromEntries(["room", ...assignmentFields].map(f => [f, isLocked(e,f)]))};
  });
  // The same normalized date/frequency and candidate set are sent to the verifier.
  const people = [...roster.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(p => {
    const {trainer, ...entry} = p;
    const eligible = [];
    if (monitors && p.active && p.max > 0) for (const [slot, context] of slots) {
      const own = context.owners.has(p.id);
      if (trainerAvailable(trainer, context.exam) && (!own || monitoringOwnExamAllowed(trainer))) eligible.push(slot);
    }
    return {...entry, eligible};
  });
  const roomList = new Map();
  for (const r of state.rooms) {
    const id = roomCode(r);
    if (!id) continue;
    const current = roomList.get(id);
    if (current?.enabled && r.enabled !== false && rooms) throw new Error(`رمز القاعة ${id} مكرر.`);
    if (current?.enabled) continue;
    const capacity = Number(r.capacity);
    roomList.set(id, {id, enabled:r.enabled !== false, building:buildingOfRoom(r),
      capacity:Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null});
  }
  return {input:{exams, periods, people, rooms:[...roomList.values()]},
    rawById, roster, unknownOwners};
}

function validateDistribution(input, result, mode) {
  const applyMonitors = mode !== "rooms", applyRooms = mode !== "monitors";
  const rows = new Map(result.rows.map(r => [r.id, r]));
  if (rows.size !== input.exams.length || result.rows.length !== rows.size) throw new Error("نتيجة التوزيع لا تطابق جدول الاختبارات.");
  const rooms = new Map(input.rooms.map(r => [r.id, r]));
  const people = new Map(input.people.map(p => [p.id, p]));
  const allowed = new Map(input.people.map(p => [p.id, new Set(p.eligible)]));
  const counts = new Map(input.people.map(p => [p.id, 0]));
  const occupiedRooms = new Set(), occupiedPeople = new Set(), occupiedGroups = new Set();
  const buildings = new Map(), peopleDays = new Map();
  let roomCount = 0, filled = 0, complete = 0, inside = 0, outside = 0, leadership = 0;
  let overCapacity = 0;
  function claim(taken, key, message) {
    if (taken.has(key)) throw new Error(message);
    taken.add(key);
  }
  for (const exam of input.exams) {
    const row = rows.get(exam.id);
    if (!row) throw new Error("لم تشمل النتيجة كل الاختبارات.");
    if (applyRooms) {
      if (exam.pins.room && row.room !== exam.previous.room) throw new Error("تغيرت قاعة مثبتة.");
      if (row.room) {
        const room = rooms.get(row.room);
        if (!room?.enabled) throw new Error("تضمنت النتيجة قاعة غير متاحة.");
        claim(occupiedRooms, JSON.stringify([exam.slot, row.room]), "تعارض قاعة في التاريخ والفترة نفسيهما.");
        roomCount++;
        if (room.capacity !== null && exam.enrollment !== null && exam.enrollment > room.capacity) overCapacity++;
        for (const owner of exam.owners) {
          const key = JSON.stringify([owner, exam.slot]);
          if (!buildings.has(key)) buildings.set(key, new Set());
          const set = buildings.get(key);
          set.add(room.building);
          if (set.size > 2) throw new Error("وزعت شعب مدرب واحد على أكثر من مبنيين في الفترة نفسها.");
        }
      }
    }
    if (applyMonitors) for (const field of assignmentFields) {
      if (exam.pins[field] && row[field] !== exam.previous[field]) throw new Error("تغير مراقب مثبت.");
      const person = people.get(row[field]);
      if (!row[field]) continue;
      if (!person || !allowed.get(person.id).has(exam.slot)) throw new Error("تضمنت النتيجة مراقبًا غير مؤهل في هذه الفترة.");
      claim(occupiedPeople, JSON.stringify([person.id, exam.slot]), `تعارض مراقبة للمدرب ${person.name}.`);
      const key = JSON.stringify([person.id, exam.date]);
      if (!peopleDays.has(key)) peopleDays.set(key, {person, periods:new Set()});
      peopleDays.get(key).periods.add(exam.period);
      filled++;
      counts.set(person.id, counts.get(person.id) + 1);
      if (person.group) {
        claim(occupiedGroups, JSON.stringify([person.group, exam.slot]), "تزامن تكليفات قيادية متعارضة.");
        leadership++;
      } else if (exam.department && person.departments.length) {
        if (person.departments.includes(exam.department)) inside++;
        else outside++;
      }
    }
    if ((!applyRooms || row.room) && (!applyMonitors || row.inv1 && row.inv2)) complete++;
  }
  if (applyMonitors) {
    for (const [id, count] of counts) if (count > people.get(id).max) throw new Error("تجاوز نصاب مراقب حده الأعلى.");
    for (const {person, periods} of peopleDays.values()) {
      if (person.allowThree) continue;
      for (let i = 2; i < input.periods.length; i++) {
        if (input.periods.slice(i-2,i+1).every(p => periods.has(p))) throw new Error("وجد تكليف بثلاث فترات متتالية دون سماح.");
      }
    }
  }
  const standard = (result.policy?.peers || []).map(id => counts.get(id));
  const max = standard.length ? Math.max(...standard) : null;
  const min = standard.length ? Math.min(...standard) : null;
  return {rows, roomCount, filled, complete, inside, outside, leadership, overCapacity,
    min, max, gap:standard.length ? max-min : null, standard:standard.length,
    limited:result.policy?.limited.length || 0,
    certified:result.stages.every(stage => stage.status === "optimal")};
}

function runDistributionWorker(input, mode, onProgress) {
  return new Promise((resolve, reject) => {
    const runtime = globalThis.examHighsRuntime;
    if (!runtime || typeof Worker !== "function") {
      reject(new Error("محرك التوزيع غير متاح. فك الضغط كاملًا وافتح النظام في Chrome أو Edge."));
      return;
    }
    const workerEntry = function() {
      self.onmessage = async ({data}) => {
        try {
          const bytes = Uint8Array.from(atob(data.wasm), c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], {type:"application/wasm"}));
          let highs;
          try { highs = await Module({locateFile: () => url}); }
          finally { URL.revokeObjectURL(url); }
          const result = createExamOptimizer().solve(highs, data.input, data.mode,
            stage => self.postMessage({stage}));
          self.postMessage({result});
        } catch (error) { self.postMessage({error:error.message}); }
      };
    };
    const url = URL.createObjectURL(new Blob([
      runtime.code, "\n", createExamOptimizer.toString(), "\n(", workerEntry.toString(), ")();"
    ], {type:"text/javascript"}));
    let worker;
    try { worker = new Worker(url); }
    catch (error) { URL.revokeObjectURL(url); reject(error); return; }
    const finish = (fn, value) => {
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error("انتهت مهلة التوزيع قبل التحقق من النتيجة. أعد المحاولة.")), 45000);
    worker.onerror = () => finish(reject, new Error("تعذر تشغيل محرك التوزيع المحلي. افتح الملف في Chrome أو Edge بعد فك الضغط."));
    worker.onmessage = ({data}) => {
      if (data.stage) { onProgress(data.stage); return; }
      if (data.error) finish(reject, new Error(data.error));
      else finish(resolve, data.result);
    };
    worker.postMessage({input, mode, wasm:runtime.wasm});
  });
}

function renderDistributionStatus(message, level) {
  const status = $("#distributionStatus");
  status.replaceChildren();
  for (const [i, part] of message.split(" · ").entries()) {
    if (i) status.append(" · ");
    status.append(...part.split(/([0-9]+(?:[./–][0-9]+)*(?:%)?)/g).map((word,index) => {
      if (index % 2 === 0) return document.createTextNode(word);
      const number=document.createElement("bdi");
      number.dir="ltr";
      number.textContent=word;
      return number;
    }));
  }
  status.hidden = !message;
  status.dataset.level = level;
}

async function runOptimizedDistribution(mode) {
  if (activeDistribution) return;
  const buttons = ["#assignMonitorsBtn", "#scheduleDistributeBtn", "#assignRoomsBtn", "#clearRoomsBtn", "#scheduleResetMonitorsBtn"].map(id => $(id));
  const started = performance.now();
  activeDistribution = mode;
  for (const button of buttons) button.disabled = true;
  try {
    renderDistributionStatus("جارٍ تجهيز بيانات التوزيع…", "working");
    const snapshot = distributionInput(mode);
    const before = JSON.stringify(snapshot.input);
    const result = await runDistributionWorker(snapshot.input, mode,
      stage => renderDistributionStatus(`جارٍ الحل · ${stage}…`, "working"));
    const latest = distributionInput(mode);
    if (before !== JSON.stringify(latest.input)) throw new Error("تغيّرت بيانات التوزيع أثناء الحل. أعد تشغيل التوزيع على البيانات الحالية.");
    const monitorResult = validateDistribution(latest.input, result, mode);
    const ownedFields = mode === "rooms" ? ["room"] : mode === "monitors" ? assignmentFields : ["room", ...assignmentFields];
    const plan = latest.input.exams.map(e => {
      const exam = latest.rawById.get(e.id), solved = monitorResult.rows.get(e.id);
      const edits = [];
      for (const field of ownedFields) {
        if (e.pins[field]) continue;
        const value = solved[field] ? field === "room" ? formatRoom(solved[field]) : latest.roster.get(solved[field]).name : "";
        edits.push([field, value]);
      }
      if (mode !== "rooms") {
        const notes = stripDistributionNote(exam.notes);
        edits.push(["notes", solved.inv1 && solved.inv2 ? notes : joinNote(notes, "عجز في المراقبين وفق القيود الحالية")]);
      }
      return [exam, edits];
    });
    const rollback = plan.map(([exam, edits]) => [exam, edits.map(([field]) => [field, exam[field]])]);
    try {
      for (const [exam, edits] of plan) for (const [field, value] of edits) exam[field] = value;
      clearTimeout(saveTimer);
      $("#saveState").textContent = "جارٍ الحفظ…";
      await dbSet(STATE_KEY, state);
      $("#saveState").textContent = "محفوظ محليًا";
    } catch (error) {
      for (const [exam, edits] of rollback) for (const [field, value] of edits) {
        if (value === undefined) delete exam[field];
        else exam[field] = value;
      }
      $("#saveState").textContent = "تعذر الحفظ";
      throw error;
    }
    renderMetrics();
    renderLeadership();
    renderSchedule();
    renderReports();
    runAudit();
    const m = monitorResult, total = latest.input.exams.length;
    const parts = [];
    if (mode !== "monitors") parts.push(`القاعات ${m.roomCount}/${total}`, `تحذيرات السعة ${m.overCapacity}`);
    if (mode === "both") parts.push(`الاختبارات المكتملة ${m.complete}/${total}`);
    if (mode !== "rooms") {
      parts.push(`خانات المراقبة ${m.filled}/${total * 2}`);
      if (m.min !== null) parts.push(`النصاب العام ${m.min}–${m.max} لدى ${m.standard} مدربًا (الفرق ${m.gap})`);
      if (m.limited) parts.push(`${m.limited} بسقوف أو إتاحة أقل`);
      if (m.inside + m.outside) parts.push(`داخل القسم ${(m.inside * 100 / (m.inside + m.outside)).toFixed(2)}%`);
    }
    if (mode !== "monitors" && latest.unknownOwners.length) {
      parts.push(`شعب بهوية مدرب غير محسومة: ${latest.unknownOwners.length}`);
    }
    if (m.gap > MAX_MONITORING_GAP) {
      parts.push(m.certified ? `أقل فرق متاح ${m.gap} بسبب القيود الحالية` : `الفرق في النتيجة المتاحة ${m.gap}`);
    }
    if (!m.certified) parts.push("نتيجة مدققة ضمن المهلة");
    parts.push(`${((performance.now() - started) / 1000).toFixed(1)} ثانية`);
    const needsReview = m.gap > MAX_MONITORING_GAP || m.complete < total || !m.certified;
    renderDistributionStatus(parts.join(" · "), needsReview ? "review" : "done");
    notify(`${needsReview?"اكتمل التوزيع مع ملاحظات":"اكتمل التوزيع بنجاح"} · ${parts.join(" · ")}`,needsReview?"warning":"success");
    return monitorResult;
  } catch (error) {
    renderDistributionStatus(error.message, "error");notify(`تعذر إكمال التوزيع: ${error.message}`,"error");
  } finally {
    for (const button of buttons) button.disabled = false;
    activeDistribution = null;
  }
}
