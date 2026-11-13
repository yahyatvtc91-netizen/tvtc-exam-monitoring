"use strict";

// Kept in a factory so the same solver runs in Node and in a portable Blob Worker.
function createExamOptimizer() {
  const fields = ["inv1", "inv2"];
  function group(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
      const key = keyOf(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    return groups;
  }

  function add(terms, index, value = 1) {
    terms.set(index, (terms.get(index) || 0) + value);
    return terms;
  }

  function sum(indices, value = 1) {
    const result = new Map();
    for (const index of indices) add(result, index, value);
    return result;
  }

  class Linear {
    constructor() {
      this.columns = [];
      this.rows = [];
    }
    variable(lower = 0, upper = 1) {
      this.columns.push([lower, upper]);
      return this.columns.length - 1;
    }
    row(terms, lower, upper) {
      this.rows.push({terms, lower, upper});
    }
    eq(terms, value) {
      this.row(terms, value, value);
    }
  }

  function and(linear, indices) {
    const output = linear.variable();
    for (const index of indices) linear.row(new Map([[output, 1], [index, -1]]), undefined, 0);
    linear.row(add(sum(indices), output, -1), undefined, indices.length - 1);
    return output;
  }

  function evaluate(values, terms) {
    let score = 0;
    for (const [index, weight] of terms) score += values[index] * weight;
    return score;
  }

  class Stages {
    constructor(highs, linear, deadline, notify, logs) {
      this.highs = highs;
      this.deadline = deadline;
      this.notify = notify;
      this.logs = logs;
      this.values = null;
      const starts = [0], indices = [], values = [];
      for (const row of linear.rows) {
        for (const [index, weight] of row.terms) {
          if (!weight) continue;
          indices.push(index);
          values.push(weight);
        }
        starts.push(indices.length);
      }
      this.size = linear.columns.length;
      const rows = linear.rows.length;
      this.model = highs.createModel({
        numCols: this.size, numRows: rows,
        colCost: new Float64Array(this.size),
        colLower: linear.columns.map(c => c[0]), colUpper: linear.columns.map(c => c[1]),
        integrality: new Int32Array(this.size).fill(1),
        rowLower: linear.rows.map(r => r.lower ?? -highs.infinity),
        rowUpper: linear.rows.map(r => r.upper ?? highs.infinity),
        matrix: {format: "csr", numCols: this.size, numRows: rows, starts, indices, values}
      });
      this.model.options.set({output_flag: false, mip_rel_gap: 0, mip_abs_gap: 0});
    }
    step(label, terms) {
      if (!terms.size && this.values) return 0;
      const remaining = (this.deadline - performance.now()) / 1000;
      if (remaining <= 0 && this.values) {
        const value = evaluate(this.values, terms);
        this.logs.push({label, status: "timeLimit", value});
        return value;
      }
      const costs = new Float64Array(this.size);
      for (const [i, c] of terms) costs[i] = c;
      this.model.changeColsCost({kind: "range", from: 0, to: this.size - 1}, costs);
      if (this.values) this.model.setSolution({colValue: this.values});
      this.model.zeroAllClocks();
      // Each phase also respects a shared time budget for the run.
      this.model.options.set("time_limit", Math.min(12, Math.max(0.25, remaining)));
      this.notify(label);
      this.model.run();
      const code = this.model.getModelStatus();
      const status = Object.keys(this.highs.constants.modelStatus)
        .find(key => this.highs.constants.modelStatus[key] === code);
      if (status === "infeasible") {
        throw new Error("تعذر الحل مع التثبيتات والقيود الحالية. راجع السقوف والتفريغ والتزامن.");
      }
      const feasible = this.model.info.get("primal_solution_status") === this.highs.constants.solutionStatus.feasible;
      if (feasible) {
        const values = Array.from(this.model.getSolution().colValue, Math.round);
        if (!this.values || evaluate(values, terms) <= evaluate(this.values, terms)) this.values = values;
      }
      if (!this.values) throw new Error("تعذر إيجاد توزيع قابل للتطبيق خلال المهلة. أعد المحاولة بعد مراجعة البيانات.");
      const value = evaluate(this.values, terms);
      const bound = this.model.info.get("mip_dual_bound");
      this.logs.push({label, status, value, bound: Number.isFinite(bound) ? bound : null});
      if (terms.size) this.model.addRow(value, value, {
        indices: [...terms.keys()], values: [...terms.values()]
      });
      return value;
    }
    // Later fairness rows depend on the coverage and leadership totals.
    variable(lower, upper) {
      this.model.addVar(lower, upper);
      this.model.changeColIntegrality(this.size, this.highs.constants.variableType.integer);
      return this.size++;
    }
    row(terms, lower, upper) {
      this.model.addRow(lower ?? -this.highs.infinity, upper ?? this.highs.infinity, {
        indices: [...terms.keys()], values: [...terms.values()]
      });
    }
    dispose() {
      this.model.dispose();
    }
  }

  function calendar(input) {
    const slots = group(input.exams, e => e.slot);
    const dates = group([...slots.values()].map(exams => exams[0]), e => e.date);
    const sequences = [...dates.keys()].map(date => input.periods.map(period => date + "|" + period));
    return {slots, sequences};
  }

  function roomProblem(linear, input, timing) {
    const rooms = new Map(input.rooms.filter(room => room.enabled).map(room => [room.id, room]));
    const typeOf = room => JSON.stringify([room.building, room.capacity]);
    const types = group(rooms.values(), typeOf);
    const bySlot = new Map(), assigned = new Map(), choices = new Map(), used = new Map();
    const home = new Map(), big = new Map(), split = new Map(), travel = new Map();
    const warnings = new Map(), overflow = new Map(), idle = new Map();
    for (const [slot, exams] of timing.slots) {
      const reserved = new Map();
      for (const e of exams) {
        if (!e.pins.room || !e.previous.room) continue;
        const id = e.previous.room;
        if (!rooms.has(id)) throw new Error(`القاعة المثبتة للشعبة ${e.section} غير متاحة أو غير معروفة.`);
        if (reserved.has(id)) throw new Error(`القاعة المثبتة مشتركة في الفترة نفسها بين الشعبتين ${reserved.get(id).section} و${e.section}.`);
        reserved.set(id, e);
      }
      const free = new Map([...types].map(([type, pool]) => [type, pool.filter(r => !reserved.has(r.id))]));
      const openDemand = new Map([...types.keys()].map(type => [type, []]));
      for (const e of exams) {
        const fixed = e.pins.room && rooms.get(e.previous.room);
        const hasRoom = linear.variable(fixed ? 1 : 0, e.pins.room && !fixed ? 0 : 1);
        assigned.set(e.id, hasRoom);
        const options = [];
        choices.set(e.id, options);
        const available = fixed ? [typeOf(fixed)] : e.pins.room ? [] : [...types.keys()].filter(key => free.get(key).length);
        for (const key of available) {
          const {building, capacity} = types.get(key)[0];
          const x = linear.variable();
          options.push({key, building, x});
          if (!e.pins.room) openDemand.get(key).push(x);
          if (e.home && e.home !== building) home.set(x, 1);
          if (e.enrollment !== null && capacity !== null) {
            const diff = e.enrollment - capacity;
            if (diff > 0) { warnings.set(x, 1); overflow.set(x, diff); }
            else if (diff < 0) idle.set(x, -diff);
          }
        }
        linear.eq(add(sum(options.map(c => c.x)), hasRoom, -1), 0);
      }
      for (const [key, vars] of openDemand) {
        if (vars.length) linear.row(sum(vars), undefined, free.get(key).length);
      }
      bySlot.set(slot, {exams, free});
      const owners = new Map();
      for (const e of exams) for (const owner of e.owners) {
        if (!owners.has(owner)) owners.set(owner, []);
        owners.get(owner).push(e);
      }
      const buildingsUsed = new Map();
      used.set(slot, buildingsUsed);
      for (const [owner, members] of owners) {
        const variables = group(members.flatMap(e => choices.get(e.id)), choice => choice.building);
        const flags = new Map();
        for (const [building, opts] of variables) {
          const u = linear.variable();
          flags.set(building, u);
          for (const {x} of opts) linear.row(new Map([[x, 1], [u, -1]]), undefined, 0);
          linear.row(add(sum(opts.map(c => c.x), -1), u), undefined, 0);
        }
        if (flags.size) buildingsUsed.set(owner, flags);
        if (flags.size > 1 && members.length > 1) {
          const d = linear.variable();
          linear.row(add(sum(flags.values()), d, -1), undefined, 1);
          linear.row(add(sum(flags.values(), -1), d, 2), undefined, 0);
          big.set(d, members.length * (members.length - 1) / 2);
          split.set(d, 1);
        }
      }
    }
    for (const sequence of timing.sequences) for (let i = 1; i < sequence.length; i++) {
      const first = used.get(sequence[i - 1]), second = used.get(sequence[i]);
      if (!first || !second) continue;
      for (const [owner, a] of first) {
        const b = second.get(owner);
        if (!b) continue;
        const shared = [...a].filter(([building]) => b.has(building))
          .map(([building, index]) => and(linear, [index, b.get(building)]));
        const movement = linear.variable();
        for (const x of a.values()) for (const y of b.values()) {
          const terms = sum(shared, -1);
          add(add(add(terms, x), y), movement, -1);
          linear.row(terms, undefined, 1);
        }
        linear.row(add(sum(a.values(), -1), movement), undefined, 0);
        linear.row(add(sum(b.values(), -1), movement), undefined, 0);
        for (const sharedBuilding of shared) linear.row(new Map([[movement, 1], [sharedBuilding, 1]]), undefined, 1);
        travel.set(movement, 1);
      }
    }
    return {assigned, choices, bySlot, home, big, split, travel, warnings, overflow, idle,
      count: sum(assigned.values(), -1), uniform: new Set([...rooms.values()].map(r => r.capacity)).size <= 1};
  }

  function monitorProblem(linear, input, timing) {
    const roster = new Map(input.people.map(t => [t.id, t]));
    const fixed = new Map(input.people.map(t => [t.id, new Set()]));
    const groups = new Map();
    const outside = new Map(), leader = new Map(), third = new Map(), adjacent = new Map();
    for (const [slot, exams] of timing.slots) {
      const byDepartment = new Map();
      groups.set(slot, byDepartment);
      for (const e of exams) {
        if (!byDepartment.has(e.department)) byDepartment.set(e.department, {exams: [], open: 0, picks: []});
        const section = byDepartment.get(e.department);
        section.exams.push(e);
        for (const field of fields) {
          if (!e.pins[field]) { section.open++; continue; }
          const id = e.previous[field];
          if (!id) continue;
          const person = roster.get(id);
          if (!person?.eligible.includes(slot)) {
            throw new Error(`المراقب المثبت في الشعبة ${e.section} غير متاح وفق التفريغ والسقف وإعداد اختبار المقرر.`);
          }
          if (fixed.get(id).has(slot)) throw new Error(`تثبيت مكرر للمراقب ${person.name} في الفترة نفسها.`);
          fixed.get(id).add(slot);
        }
      }
    }
    const occupancy = new Map(), loads = new Map(), limits = new Map();
    const groupUse = new Map();
    let committeeLoad = 0;
    for (const person of input.people) {
      const work = new Map(), fixedSlots = fixed.get(person.id);
      occupancy.set(person.id, work);
      for (const slot of person.eligible) {
        const locked = fixedSlots.has(slot);
        const destinations = [...groups.get(slot)].filter(([, team]) => team.open > 0);
        if (!locked && !destinations.length) continue;
        const u = linear.variable(locked ? 1 : 0, 1);
        work.set(slot, u);
        if (!locked) {
          const links = new Map([[u, -1]]);
          for (const [department, team] of destinations) {
            const x = linear.variable();
            team.picks.push([person.id, x]);
            links.set(x, 1);
            if (!person.group && department && person.departments.length && !person.departments.includes(department)) {
              outside.set(x, 1);
            }
          }
          linear.eq(links, 0);
        }
        if (person.group) {
          leader.set(u, -1);
          if (timing.slots.get(slot)[0].period === 3) third.set(u, -1);
          const key = JSON.stringify([person.group, slot]);
          if (!groupUse.has(key)) groupUse.set(key, []);
          groupUse.get(key).push(u);
        }
      }
      let possible = 0;
      for (const sequence of timing.sequences) {
        let run = 0;
        for (let i = 0; i < sequence.length; i++) {
          const current = work.get(sequence[i]);
          if (current === undefined) {
            possible += run - Math.floor(run / 3);
            run = 0;
            continue;
          }
          run++;
          const previous = work.get(sequence[i - 1]);
          if (previous === undefined) continue;
          adjacent.set(and(linear, [previous, current]), 1);
          const first = work.get(sequence[i - 2]);
          if (first === undefined) continue;
          if (sequence.slice(i - 2, i + 1).every(slot => fixedSlots.has(slot))) {
            throw new Error(`المراقب ${person.name} مثبت في ثلاث فترات متتالية. فك تثبيت إحدى الفترات ثم أعد التوزيع.`);
          }
          linear.row(sum([first, previous, current]), undefined, 2);
        }
        possible += run - Math.floor(run / 3);
      }
      const cap = Math.min(person.max, possible);
      if (fixedSlots.size > cap) throw new Error(`تثبيتات ${person.name} تتجاوز حده الأعلى أو فتراته المتاحة.`);
      const required = person.active && person.committee ? person.max : 0;
      if (required > cap) {
        throw new Error(`يتطلب عضو اللجنة ${person.name} ${required} مراقبة، وتسمح الفترات المتاحة والقيود بـ ${cap} فقط.`);
      }
      const load = linear.variable(required, cap);
      committeeLoad += required;
      linear.eq(add(sum(work.values()), load, -1), 0);
      loads.set(person.id, load);
      if (person.active && !person.group && !person.committee) limits.set(person.id, cap);
    }
    for (const vars of groupUse.values()) if (vars.length > 1) linear.row(sum(vars), undefined, 1);
    for (const byDepartment of groups.values()) for (const team of byDepartment.values()) {
      if (team.picks.length) linear.row(sum(team.picks.map(pair => pair[1])), undefined, team.open);
    }
    return {loads, limits, groups, outside, leader, third, adjacent, committeeLoad,
      count: sum(loads.values(), -1)};
  }

  function completion(linear, monitors, rooms) {
    const completed = new Map();
    for (const departments of monitors.groups.values()) for (const group of departments.values()) {
      const demand = sum(group.picks.map(pair => pair[1]), -1);
      for (const e of group.exams) {
        const z = linear.variable(0, fields.some(f => e.pins[f] && !e.previous[f]) ? 0 : 1);
        completed.set(e.id, z);
        if (rooms) linear.row(new Map([[z, 1], [rooms.assigned.get(e.id), -1]]), undefined, 0);
        const open = fields.filter(f => !e.pins[f]).length;
        if (open) demand.set(z, open);
      }
      linear.row(demand, undefined, 0);
    }
    return completed;
  }

  function workloadPolicy(limits, total) {
    const ranked = [...limits].sort((a, b) => a[1] - b[1]);
    const limited = [];
    let remaining = total;
    for (let i = 0; i < ranked.length; i++) {
      if (ranked[i][1] >= remaining / (ranked.length - i)) {
        return {limited, peers: ranked.slice(i).map(([id]) => id)};
      }
      limited.push(ranked[i][0]);
      remaining -= ranked[i][1];
    }
    return {limited, peers: []};
  }

  function optimizeMonitoring(stages, timing, plan, filled) {
    const leads = -stages.step("تكليف القيادات", plan.leader);
    stages.step("أولوية الفترة الثالثة للقيادات", plan.third);
    const availableLoad = filled - leads - plan.committeeLoad;
    const policy = workloadPolicy(plan.limits, availableLoad);
    const limitedLoad = policy.limited.length ?
      -stages.step("أنصبة أصحاب السقوف المنخفضة", sum(policy.limited.map(id => plan.loads.get(id)), -1)) : 0;
    if (policy.peers.length > 1) {
      const largest = timing.slots.size;
      const average = (availableLoad - limitedLoad) / policy.peers.length;
      const lower = stages.variable(0, Math.floor(average));
      const spread = stages.variable(Number(!Number.isInteger(average)), largest);
      // Seed the new columns using the existing feasible assignment.
      const counts = policy.peers.map(id => stages.values[plan.loads.get(id)]);
      const min = Math.min(...counts), max = Math.max(...counts);
      stages.values.push(min, max - min);
      for (const id of policy.peers) {
        const load = plan.loads.get(id);
        stages.row(new Map([[load, 1], [lower, -1]]), 0, undefined);
        stages.row(new Map([[load, 1], [lower, -1], [spread, -1]]), undefined, 0);
      }
      stages.step("موازنة الأنصبة على مستوى الكلية", new Map([[spread, 1]]));
    }
    stages.step("أولوية المراقبة داخل القسم", plan.outside);
    stages.step("تقليل المراقبات المتتابعة", plan.adjacent);
    return policy;
  }

  function optimizeRooms(stages, plan, allAssigned) {
    stages.step("أولوية مباني الأقسام", plan.home);
    stages.step("تجميع الشعب الكبيرة", plan.big);
    stages.step("تجميع شعب المدربين", plan.split);
    stages.step("تقليل التنقل بين المباني", plan.travel);
    if (!allAssigned || !plan.uniform) {
      stages.step("تقليل تحذيرات السعة", plan.warnings);
      stages.step("تقليل تجاوز المقاعد", plan.overflow);
      stages.step("استغلال سعة القاعات", plan.idle);
    }
  }

  function decodeRooms(plan, values, output) {
    for (const {exams, free} of plan.bySlot.values()) {
      const pools = new Map([...free].map(([type, rooms]) => [type, rooms.map(r => r.id)]));
      const pending = [];
      for (const e of exams) {
        const row = output.get(e.id);
        if (e.pins.room) { row.room = e.previous.room; continue; }
        const choice = plan.choices.get(e.id).find(c => values[c.x]);
        if (!choice) continue;
        const pool = pools.get(choice.key);
        const old = pool.indexOf(e.previous.room);
        if (old >= 0) row.room = pool.splice(old, 1)[0];
        else pending.push([row, pool]);
      }
      for (const [row, pool] of pending) row.room = pool.shift();
    }
  }

  function decodeMonitors(plan, values, output, completed) {
    for (const departments of plan.groups.values()) for (const group of departments.values()) {
      const queue = group.picks.filter(([, x]) => values[x]).map(([id]) => id);
      const rank = e => {
        const complete = completed && values[completed.get(e.id)];
        const blocked = fields.some(f => e.pins[f] && !e.previous[f]);
        return (complete ? 0 : 10) + (blocked ? 4 : 0) + fields.filter(f => !e.pins[f]).length;
      };
      for (const e of [...group.exams].sort((a, b) => rank(a) - rank(b))) {
        const row = output.get(e.id);
        for (const f of fields) row[f] = e.pins[f] ? e.previous[f] : queue.shift() ?? null;
      }
    }
  }

  function solve(highs, input, mode, notify = () => {}) {
    const logs = [];
    const deadline = performance.now() + 32000;
    const timing = calendar(input);
    const emptyOutput = () => new Map(input.exams.map(e => [e.id, {id:e.id, ...e.previous}]));

    function solveRooms(probe) {
      const linear = new Linear(), room = roomProblem(linear, input, timing);
      const engine = new Stages(highs, linear, deadline, notify, logs);
      try {
        const n = -engine.step("تغطية القاعات", room.count);
        if (probe && n !== input.exams.length) return null;
        optimizeRooms(engine, room, n === input.exams.length);
        const output = emptyOutput();
        for (const row of output.values()) row.room = null;
        decodeRooms(room, engine.values, output);
        return output;
      } finally { engine.dispose(); }
    }

    function solveMonitors(probe, withRooms, countPairs) {
      const linear = new Linear(), monitor = monitorProblem(linear, input, timing);
      const room = withRooms ? roomProblem(linear, input, timing) : null;
      const complete = countPairs ? completion(linear, monitor, room) : null;
      const engine = new Stages(highs, linear, deadline, notify, logs);
      try {
        if (complete) engine.step("تغطية الاختبارات المكتملة", sum(complete.values(), -1));
        const filled = -engine.step("تغطية خانات المراقبة", monitor.count);
        if (probe && filled !== input.exams.length * 2) return null;
        const halls = room ? -engine.step("تغطية القاعات", room.count) : 0;
        const policy = optimizeMonitoring(engine, timing, monitor, filled);
        if (room) optimizeRooms(engine, room, halls === input.exams.length);
        const output = emptyOutput();
        if (room) {
          for (const row of output.values()) row.room = null;
          decodeRooms(room, engine.values, output);
        }
        decodeMonitors(monitor, engine.values, output, complete);
        return {output, policy};
      } catch (error) {
        if (monitor.committeeLoad && error.message.startsWith("تعذر الحل مع التثبيتات")) {
          throw new Error("تعذر تحقيق الأنصبة المحددة لأعضاء اللجان مع القيود الحالية. راجع نصاب كل عضو، والتفريغ، واختبارات الأقسام، والتثبيتات.");
        }
        throw error;
      } finally { engine.dispose(); }
    }

    let output, policy = null;
    if (mode === "rooms") {
      output = solveRooms(false);
    } else if (mode === "monitors") {
      const result = solveMonitors(true, false, false) ?? solveMonitors(false, false, true);
      ({output, policy} = result);
    } else {
      const rooms = solveRooms(true);
      const monitors = rooms && solveMonitors(true, false, false);
      if (monitors) {
        ({output, policy} = monitors);
        for (const [id, row] of output) row.room = rooms.get(id).room;
      } else {
        ({output, policy} = solveMonitors(false, true, true));
      }
    }
    return {rows: [...output.values()], policy, stages: logs};
  }

  return {solve};
}

if (typeof module !== "undefined" && module.exports) module.exports = createExamOptimizer;
