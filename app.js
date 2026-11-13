"use strict";

const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const DB_NAME = "monitoring_portable_v1";
const STORE = "app";
const STATE_KEY = "state";
const AR_DAYS = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس"];
let state;
let db;
let auditRows = [];
let sectionCache;

function uid(prefix = "id") { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function norm(v) { return String(v ?? "").trim().replace(/\s+/g, " ").toLowerCase().replace(/[أإآ]/g,"ا").replace(/ة/g,"ه").replace(/ى/g,"ي"); }
function arabicDigits(v) { return String(v).replace(/\d/g, d => "٠١٢٣٤٥٦٧٨٩"[Number(d)]); }
function westernDigits(v) { return String(v??"").replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))); }
function hijriDate(v) {
  const raw=westernDigits(v).trim().replace(/[.\-]/g,"/");
  const m=raw.match(/^(1[34]\d{2})\/(\d{1,2})\/(\d{1,2})$/);
  if(!m || +m[2]<1 || +m[2]>12 || +m[3]<1 || +m[3]>30) return "";
  return `${m[1]}/${m[2].padStart(2,"0")}/${m[3].padStart(2,"0")}`;
}
function displayDate(v) { return arabicDigits(String(v??"")); }
function periodTime(exam) { return state.periods.find(p=>Number(p.id)===Number(exam.period))?.time||"غير محدد"; }
function trainingTermLabel(){
  const code=westernDigits(state.meta.term||"").replace(/\D/g,"");
  const full=code.match(/^(1[34]\d{2})(10|20)$/);
  if(full)return `الفصل التدريبي ${full[2]==="10"?"الأول":"الثاني"} ${arabicDigits(Number(full[1])+1)}`;
  // الصيغة المختصرة مثل 14420 لا تحمل سنة كاملة؛ نستمد السنة من تواريخ الاختبارات.
  const short=code.match(/^\d{3}(10|20)$/);
  if(short){
    const date=state.exams.map(e=>westernDigits(e.date).match(/^(1[34]\d{2})\//)?.[1]).find(Boolean)
      ||state.days.map(d=>westernDigits(d.date).match(/^(1[34]\d{2})\//)?.[1]).find(Boolean)
      ||new Intl.DateTimeFormat("en-u-ca-islamic-umalqura",{year:"numeric"}).format(new Date()).match(/1[34]\d{2}/)?.[0];
    return date?`الفصل التدريبي ${short[1]==="10"?"الأول":"الثاني"} ${arabicDigits(date)}`:"";
  }
  return state.meta.term?`الفصل التدريبي: ${state.meta.term}`:"";
}
function scheduleNotes(exam){
  const notes=[];
  if(!exam.room)notes.push("لم تُعيّن قاعة");
  else if(!validRoomLabel(exam.room))notes.push("قاعة غير معروفة");
  else if(roomRecord(exam.room)?.enabled===false)notes.push("القاعة مستبعدة");
  if(!exam.inv1&&!exam.inv2)notes.push("لم يُعيّن مراقبان");
  else if(!exam.inv1||!exam.inv2)notes.push("نقص مراقب");
  return notes.join("؛ ")||"مكتمل";
}
// Unified, accessible notifications. Success auto-closes after 8s; warnings/errors remain until dismissed.
let notificationTimer;
function notify(message, kind="success") {
  if (typeof document === "undefined") return;
  const host=$("#toast");if(!host)return;
  const type=["success","warning","error","info","working"].includes(kind)?kind:"success";
  clearTimeout(notificationTimer);
  host.className=`toast show toast-${type}`;
  host.setAttribute("role",type==="error"?"alert":"status");
  host.setAttribute("aria-live",type==="error"?"assertive":"polite");
  host.replaceChildren();
  const content=document.createElement("span");content.className="toast-message";content.textContent=String(message);host.append(content);
  const close=document.createElement("button");close.type="button";close.className="toast-close";close.setAttribute("aria-label","إغلاق الإشعار");close.textContent="×";
  close.addEventListener("click",()=>{clearTimeout(notificationTimer);host.classList.remove("show");});host.append(close);
  if(type==="success"||type==="info")notificationTimer=setTimeout(()=>host.classList.remove("show"),8000);
}
function toast(msg,kind="success"){notify(msg,kind);}
function notifyError(message){notify(message,"error");}

function todayStamp() { return new Date().toLocaleString("ar-SA", {dateStyle:"medium", timeStyle:"short"}); }
function dayKey(exam) { const time=exam.date?calendarTime(exam.date):null;return time!==null?hijriFromTime(time):westernDigits(exam.date||"").replace(/[.\-]/g,"/") || `${exam.week||""}|${exam.day||""}`; }
function slotKey(exam) { return `${dayKey(exam)}|${Number(exam.period)}`; }
function num(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }

function defaultDays() {
  const out = [];
  for (let w = 1; w <= 4; w++) for (const day of AR_DAYS) out.push({id:uid("day"), week:w, day, date:"", active:true});
  return out;
}
function defaultState() {
  return {
    version: 1,
    meta: {term:"", ownExamMonitoringMode:"allow", announcementTerm:"", announcementInstructions:"", ss01Name:"", ss01ImportedAt:"", examName:"", examImportedAt:""},
    auditExceptions: {}, availabilityPinned: {},
    ss01: [], ss01Headers: [],
    trainers: [], leadership: [], rooms: [], exams: [], availability: {},
    periods: [
      {id:1, name:"الفترة الأولى", time:"08:00 ص", active:true},
      {id:2, name:"الفترة الثانية", time:"10:00 ص", active:true},
      {id:3, name:"الفترة الثالثة", time:"12:00 م", active:true}
    ],
    days: defaultDays()
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function dbGet(key) { return new Promise((resolve, reject) => { const r = db.transaction(STORE).objectStore(STORE).get(key); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
function dbSet(key, value) { return new Promise((resolve, reject) => { const tx=db.transaction(STORE,"readwrite"); tx.objectStore(STORE).put(value,key); tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); }); }
let saveTimer;
function saveSoon() {
  if (typeof document === "undefined") return;
  $("#saveState").textContent = "جارٍ الحفظ…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { await dbSet(STATE_KEY, state); $("#saveState").textContent = "محفوظ محليًا"; renderMetrics(); }, 250);
}

function parseCsv(text) {
  // SS01 may be exported with semicolons (Saudi Excel) rather than commas.
  // Detect the separator outside quoted cells, including UTF-8 BOM files.
  text = String(text??"").replace(/^\uFEFF/, "");
  const firstLine = text.split(/\r?\n/,1)[0]||"";
  const separators=[",",";","\t"];
  const counts=separators.map(sep=>{
    let quoted=false,count=0;
    for(let i=0;i<firstLine.length;i++){
      const c=firstLine[i];
      if(c==='"'&&firstLine[i+1]==='"'&&quoted){i++;continue;}
      if(c==='"')quoted=!quoted;
      else if(!quoted&&c===sep)count++;
    }
    return count;
  });
  const separator=separators[counts.indexOf(Math.max(...counts))];
  const rows=[];let row=[],cell="",quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){
      if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}
      else if(c==='"')quoted=false;
      else cell+=c;
    }else if(c==='"')quoted=true;
    else if(c===separator){row.push(cell);cell="";}
    else if(c==='\n'){row.push(cell.replace(/\r$/, ""));rows.push(row);row=[];cell="";}
    else cell+=c;
  }
  if(cell||row.length){row.push(cell);rows.push(row);}
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}
async function unzipXlsx(buffer) {
  const b = new Uint8Array(buffer), dv = new DataView(buffer);
  let eocd=-1;
  for (let i=b.length-22;i>=Math.max(0,b.length-65557);i--) if (dv.getUint32(i,true)===0x06054b50) { eocd=i; break; }
  if (eocd<0) throw new Error("ملف XLSX غير صالح");
  const count=dv.getUint16(eocd+10,true), cdOffset=dv.getUint32(eocd+16,true), dec=new TextDecoder("utf-8");
  const files={}; let p=cdOffset;
  for (let n=0;n<count;n++) {
    if (dv.getUint32(p,true)!==0x02014b50) break;
    const method=dv.getUint16(p+10,true), size=dv.getUint32(p+20,true), nameLen=dv.getUint16(p+28,true), extraLen=dv.getUint16(p+30,true), commentLen=dv.getUint16(p+32,true), local=dv.getUint32(p+42,true);
    const name=dec.decode(b.slice(p+46,p+46+nameLen));
    const localNameLen=dv.getUint16(local+26,true), localExtra=dv.getUint16(local+28,true), start=local+30+localNameLen+localExtra;
    let raw=b.slice(start,start+size);
    if (method===8) {
      const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      raw=new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (method!==0) throw new Error("طريقة ضغط XLSX غير مدعومة");
    files[name]=raw; p+=46+nameLen+extraLen+commentLen;
  }
  return files;
}
function colIndex(ref) { const m=String(ref).match(/[A-Z]+/); if(!m)return 0; let x=0; for(const c of m[0])x=x*26+c.charCodeAt(0)-64; return x-1; }
function decodeXml(v) { return String(v??"").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&").replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))); }
function xmlTexts(fragment) { return [...String(fragment).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m=>decodeXml(m[1])).join(""); }
async function parseXlsx(buffer) {
  const files=await unzipXlsx(buffer), dec=new TextDecoder("utf-8");
  const shared=[];
  if(files["xl/sharedStrings.xml"]) for(const si of dec.decode(files["xl/sharedStrings.xml"]).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) shared.push(xmlTexts(si[1]));
  let sheetName="xl/worksheets/sheet1.xml";
  if(!files[sheetName]) sheetName=Object.keys(files).find(n=>/^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  if(!sheetName) throw new Error("لا توجد ورقة بيانات في الملف");
  const rows=[], sheetXml=dec.decode(files[sheetName]);
  for(const r of sheetXml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const arr=[];
    for(const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs=c[1], body=c[2]||"", ref=(attrs.match(/\br="([^"]+)"/)||[])[1]||"A1", type=(attrs.match(/\bt="([^"]+)"/)||[])[1]||"";
      const idx=colIndex(ref); let val="";
      if(type==="inlineStr") val=xmlTexts(body);
      else { const v=(body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)||[])[1]; val=v?decodeXml(v):""; if(type==="s")val=shared[Number(val)]??""; }
      arr[idx]=val;
    }
    rows.push(arr.map(v=>v??""));
  }
  return rows.filter(r=>r.some(v=>String(v).trim()!==""));
}
async function readTable(file) {
  if(file.name.toLowerCase().endsWith(".csv")) return parseCsv(await file.text());
  if(file.name.toLowerCase().endsWith(".xlsx")) return parseXlsx(await file.arrayBuffer());
  throw new Error("اختر ملف CSV أو XLSX");
}
function rowsToObjects(rows) {
  if(rows.length<2) return {headers:rows[0]||[], records:[]};
  const headers=rows[0].map(v=>String(v).trim());
  return {headers, records:rows.slice(1).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??""])))};
}
function findHeader(headers, patterns) { for(const p of patterns){const h=headers.find(v=>p.test(norm(v)));if(h)return h;}return ""; }
function fieldMap(headers) {
  return {
    term:findHeader(headers,[/الفصل التدريبي/,/الفصل/]), dept:findHeader(headers,[/^القسم$/, /القسم التدريبي/]),
    course:findHeader(headers,[/^اسم المقرر$/, /اسم الماده/, /^المقرر$/]), code:findHeader(headers,[/رمز المقرر/,/كود المقرر/,/^المقرر$/]),
    section:findHeader(headers,[/رقم الشعبه/,/^الشعبه$/, /الرقم المرجعي/]), trainerId:findHeader(headers,[/رقم المدرب/,/الرقم الوظيفي/,/الرقم الوظيفى/]),
    trainer:findHeader(headers,[/اسم المدرب/,/^المدرب$/]), room:findHeader(headers,[/^قاعه$/, /رمز القاعه/,/اسم القاعه/]),
    enrolled:findHeader(headers,[/^مسجلين$/, /عدد المسجلين/]), trainingType:findHeader(headers,[/نوع التدريب/,/نوع الشعبه/,/نوع الجدوله/,/طريقه التدريب/,/تصنيف التدريب/])
  };
}
function trainingIncluded(v) { const s=norm(v); return !/(?:^|[^\p{L}])(عملي|تعاوني|تعاون|عن بعد|ذاتي|افتراضي)(?=$|[^\p{L}])/u.test(s); }
function rowIncluded(row,map){
  const relevant=state.ss01Headers.filter(h=>/نوع الشعبه|نوع التدريب|طريقه التدريب|نمط التدريب|تصنيف التدريب/.test(norm(h)));
  return trainingIncluded([map.trainingType?row[map.trainingType]:"",...relevant.map(h=>row[h]),map.course?row[map.course]:""].join(" "));
}
function eligibleSections(){
  if(sectionCache?.source===state.ss01&&sectionCache.length===state.ss01.length)return sectionCache.included;
  const m=fieldMap(state.ss01Headers),found=new Map();
  for(const r of state.ss01){if(!rowIncluded(r,m))continue;const section=String(r[m.section]||"").trim();if(!section||found.has(norm(section)))continue;
    found.set(norm(section),{section,course:String(r[m.course]||"").trim(),code:String(r[m.code]||"").trim(),type:String(r[m.trainingType]||"").trim(),trainer:String(r[m.trainer]||"").trim()});
  }
  sectionCache={source:state.ss01,length:state.ss01.length,included:found,known:new Set(state.ss01.map(r=>norm(r[m.section])).filter(Boolean))};
  return found;
}
function eligibleExams(){const included=eligibleSections(),known=sectionCache.known;return state.exams.filter(e=>!known.has(norm(e.section))||included.has(norm(e.section)));}
function formatRoom(code) {
  const digits=westernDigits(code).replace(/\D/g,"");
  if(/^\d{10}$/.test(digits)) return `مبنى ${arabicDigits(digits.slice(3,5))} – قاعة ${arabicDigits(digits.slice(-3))}`;
  return String(code??"").trim();
}
function roomCode(room){const digits=westernDigits(room?.original||"").replace(/\D/g,"");return /^\d{10}$/.test(digits)?digits:"";}
function roomRecord(label){const value=westernDigits(label),digits=value.replace(/\D/g,"");const parts=value.match(/مبنى\s*(\d{1,2}).*قاعة\s*(\d{1,3})/);return state.rooms.find(r=>r.name===label||r.original===label||(roomCode(r)&&roomCode(r)===digits)||(parts&&roomCode(r)&&buildingOfRoom(r)===parts[1].padStart(2,"0")&&roomCode(r).slice(-3)===parts[2].padStart(3,"0")));}
function validRoomLabel(label){const r=roomRecord(label);return r&&roomCode(r)?formatRoom(r.original):"";}
function roomAllowed(row, map) {
  const focus=[map.trainingType,map.room].filter(Boolean).map(h=>row[h]).join(" ");
  const type=map.trainingType?norm(row[map.trainingType]):"";
  return rowIncluded(row,map) && /^\d{10}$/.test(westernDigits(row[map.room]).replace(/\D/g,"")) && !/(معمل|مختبر|حاسب|ورشه|ورشة)/.test(norm(focus)) && (!type||/نظري/.test(type));
}

// 4.1: Canonical employee numbers and non-destructive consolidation.
function canonicalTrainerId(id){return westernDigits(String(id||"")).replace(/\s/g,"").replace(/^0+(?=\d)/,"");}
function trainerIdentity(t){return validEmployeeId(t.id)||`name:${norm(t.name)}`;}
function consolidateTrainers(){
  const groups=new Map(),remap=new Map(),old=state.trainers||[];
  for(const t of old){const key=trainerIdentity(t);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(t);}
  const merged=[];
  for(const group of groups.values()){
    // Preserve the most deliberately configured record, not the newly imported default.
    const score=t=>(!activeTrainer(t)?100:0)+(num(t.max,999)!==999?45:0)+(t.allowOwnExamMonitoring===true?20:0)+(Object.keys(state.availability?.[t.key]||{}).length?30:0)+(state.availabilityPinned?.[t.key]?30:0)+(t.source!=="SS01"?3:0);
    group.sort((a,b)=>score(b)-score(a));const main=group[0];main.id=canonicalTrainerId(main.id);const depts=new Set();
    for(const t of group){for(const d of String(t.dept||"").split(/[،,]/).map(x=>x.trim()).filter(Boolean))depts.add(d);if(t!==main){
      remap.set(t.key,main.key);
      if(norm(t.name)!==norm(main.name))for(const e of state.exams||[])for(const f of ["inv1","inv2"])if(norm(e[f])===norm(t.name))e[f]=main.name;
      state.availability??={};state.availability[main.key]??={};Object.assign(state.availability[main.key],state.availability[t.key]||{});delete state.availability[t.key];
      if(state.availabilityPinned?.[t.key]){state.availabilityPinned[main.key]=true;delete state.availabilityPinned[t.key];}
    }}
    main.dept=[...depts].join("، ");merged.push(main);
  }
  state.trainers=merged;return old.length-merged.length;
}
function importReview(message){return typeof window==="undefined"||window.confirm(message);}
function workCounts(v){return `الفصل: ${v.meta?.term||"غير محدد"}\nالاختبارات: ${(v.exams||[]).length}\nالمدربون: ${(v.trainers||[]).length}\nالقاعات: ${(v.rooms||[]).length}`;}
function safeBackup(){download(`نسخة_احتياطية_قبل_الاستيراد_${Date.now()}.json`,JSON.stringify(state));}
function manualConflictRooms(){
  const bySlot=new Map(),bad=new Set();
  for(const e of eligibleExams()){
    const code=roomCode(roomRecord(e.room));if(!code)continue;
    const k=`${slotKey(e)}|${code}`;
    if(!bySlot.has(k))bySlot.set(k,[]);bySlot.get(k).push(e.id);
  }
  for(const ids of bySlot.values())if(ids.length>1)for(const id of ids)bad.add(id);
  return bad;
}
function manualConflictNames(){const seen=new Map(),bad=new Set();for(const e of eligibleExams())for(const name of [e.inv1,e.inv2])if(name){const k=`${slotKey(e)}|${norm(name)}`;if(seen.has(k)){bad.add(`${seen.get(k).id}|${norm(name)}`);bad.add(`${e.id}|${norm(name)}`);}else seen.set(k,e);}return bad;}
function findReplacement(ex) {
  const field = assignmentFields.find(f => !ex[f] && !isLocked(ex,f));
  if (!field) return false;
  const counts = countAssignments();
  const candidates = eligibleMonitorChoices(ex,field);
  candidates.sort((a,b) => Number(sameDepartment(b.trainer,ex))-Number(sameDepartment(a.trainer,ex)) ||
    (counts[a.trainer.name]||0)-(counts[b.trainer.name]||0) || a.trainer.name.localeCompare(b.trainer.name,"ar"));
  if (!candidates.length) return false;
  ex[field] = candidates[0].trainer.name;
  if(ex.manualMonitors)delete ex.manualMonitors[field];
  saveSoon();renderSchedule();renderReports();runAudit();
  return true;
}
async function importSS01(file) {
  const {headers,records}=rowsToObjects(await readTable(file)); if(!records.length) throw new Error("الملف لا يحتوي سجلات");
  const m=fieldMap(headers); if(!m.trainer || !m.course || !m.section || !m.code) throw new Error("تعذر العثور على أعمدة المدرب واسم المقرر ورمز المقرر والشعبة؛ تحقق من تنسيق ملف SS01 وفواصل CSV.");
  const previousSections=new Set((state.ss01||[]).map(r=>norm(r[fieldMap(state.ss01Headers).section]||"")).filter(Boolean));
  const incomingSections=new Set(records.map(r=>norm(r[m.section])).filter(Boolean));
  const overlapping=[...incomingSections].filter(x=>previousSections.has(x)).length;
  const conflicting=records.filter(r=>!r[m.section]||!r[m.code]||!r[m.trainer]).length;
  if(conflicting&&!importReview(`تنبيه: توجد ${conflicting} سجلات ناقصة بيانات أساسية.\nيمكنك إلغاء الاستيراد دون تغيير بياناتك.\nهل تريد المتابعة صراحة؟`))return false;
  if(!importReview(`مراجعة استيراد SS01\nالسجلات الواردة: ${records.length}\nالشعب الجديدة: ${incomingSections.size-overlapping}\nالشعب المتكررة: ${overlapping}\nسجلات ناقصة: ${conflicting}\nسيُستبدل مرجع SS01 وتُحدّث قائمة المدربين والقاعات مع إبقاء جدول الاختبارات الحالي.\nهل توافق؟`))return false;
  state.ss01Headers=headers; state.ss01=records; state.meta.ss01Name=file.name; state.meta.ss01ImportedAt=todayStamp(); state.meta.term=m.term?String(records[0][m.term]||""):"";
  consolidateTrainers();
  const existing=new Map(allMonitoringTrainers().map(t=>[trainerIdentity(t),t]));
  for(const r of records) {
    const name=String(r[m.trainer]||"").trim(), id=String(r[m.trainerId]||"").trim(); if(!name||name==="-")continue;
    const key=canonicalTrainerId(id)||`name:${norm(name)}`, old=existing.get(key), dept=String(r[m.dept]||"").trim();
    if(old) { old.name=name; if(id)old.id=canonicalTrainerId(id); if(dept && !(old.dept||"").split("،").map(norm).includes(norm(dept))) old.dept=old.dept?`${old.dept}، ${dept}`:dept; old.source="SS01"; }
    else { const t={key:uid("tr"),id:canonicalTrainerId(id),name,dept,active:true,max:999,allowOwnExamMonitoring:false,source:"SS01"}; state.trainers.push(t); existing.set(key,t); }
  }
  state.rooms=state.rooms.filter(r=>r.source!=="SS01"||roomCode(r));
  const roomMap=new Map(state.rooms.map(r=>[norm(r.original||r.name),r]));
  if(m.room) for(const r of records) {
    const original=String(r[m.room]||"").trim(); if(!original||original==="-"||!roomAllowed(r,m))continue;
    const key=norm(original); if(!roomMap.has(key)){const room={key:uid("room"),name:formatRoom(original),original,capacity:45,capacityRevision:2,source:"SS01"};state.rooms.push(room);roomMap.set(key,room);}
  }
  syncRoomCapacities(records,m);
  consolidateTrainers();
  state.trainers.sort((a,b)=>a.dept.localeCompare(b.dept,"ar")||a.name.localeCompare(b.name,"ar"));
  state.rooms.sort((a,b)=>String(a.original).localeCompare(String(b.original),"ar",{numeric:true}));
  saveSoon(); renderAll();
}

function syncRoomCapacities(){
  for(const room of state.rooms){
    if(room.capacityManual!==true){
      // Preserve untracked existing capacities and manually created rooms.
      if((room.capacityRevision===undefined||room.source==="يدوي")&&Number.isFinite(Number(room.capacity))&&Number(room.capacity)>0)room.capacityManual=true;
      else room.capacity=45;
    }
    room.capacityRevision=2;delete room.sourceCapacities;delete room.capacityIssue;delete room.capacityLegacy;
  }
}
function setRoomCapacity(room,value){
  room.capacity=num(westernDigits(value),0);room.capacityManual=true;room.capacityRevision=2;room.capacityIssue="";delete room.capacityLegacy;
}
function sectionEnrollments(){
  const map=fieldMap(state.ss01Headers),counts=new Map();if(!map.enrolled)return counts;
  for(const row of state.ss01){const section=norm(row[map.section]),raw=westernDigits(row[map.enrolled]??"").trim();if(!section||raw===""||!Number.isFinite(Number(raw))||Number(raw)<0)continue;counts.set(section,Math.max(counts.get(section)||0,Number(raw)));}return counts;
}

function excelDate(v) {
  if(!v)return "";
  const hijri=hijriDate(v);if(hijri)return hijri;
  if(/^\d{4}-\d{1,2}-\d{1,2}/.test(v))return String(v).slice(0,10);
  const n=Number(v); if(Number.isFinite(n)&&n>20000){const d=new Date(Date.UTC(1899,11,30)+n*86400000);return d.toISOString().slice(0,10);}
  const d=new Date(v); return isNaN(d)?String(v):d.toISOString().slice(0,10);
}
function examMap(headers) { return {day:findHeader(headers,[/^اليوم$/]),date:findHeader(headers,[/التاريخ/]),period:findHeader(headers,[/الفتره/,/الجلسه/]),time:findHeader(headers,[/الوقت/,/الزمن/]),course:findHeader(headers,[/اسم المقرر/,/^المقرر$/, /الماده/]),section:findHeader(headers,[/رقم الشعبه/,/^الشعبه$/, /الرقم المرجعي/]),room:findHeader(headers,[/القاعه/])}; }
function periodNo(v) { const s=norm(v); if(/اول|اولي|1/.test(s))return 1;if(/ثاني|2/.test(s))return 2;if(/ثالث|3/.test(s))return 3;return num(v,1); }
function parseDayDate(v) {
  const s=westernDigits(v).replace(/\r/g,"").trim(), day=AR_DAYS.find(d=>norm(s).includes(norm(d)))||"";
  const date=(s.match(/(?:14\d{2}|20\d{2})[\/-]\d{1,2}[\/-]\d{1,2}/)||[])[0]||"";
  return {day,date};
}
function extractPeriodTime(v) {
  const s=String(v??"").replace(/\s+/g," ").trim();
  const m=s.match(/من\s*([0-9٠-٩:]+)\s*(?:ص|م)?\s*(?:الى|إلى)\s*([0-9٠-٩:]+)/);
  return m?`${m[1]} – ${m[2]}`:"";
}
function parseExamMatrix(rows) {
  let header=-1, starts=[];
  for(let i=0;i<Math.min(rows.length,20);i++){
    const found=[];for(let c=0;c<(rows[i]||[]).length;c++)if(/الرمز/.test(norm(rows[i][c])))found.push(c);
    if(found.length>=2){header=i;starts=found;break;}
  }
  if(header<0)return [];
  const out=[];let currentDay="",currentDate="";
  for(let r=header+1;r<rows.length;r++){
    const row=rows[r]||[], dd=parseDayDate(row[0]);
    if(dd.day)currentDay=dd.day;if(dd.date)currentDate=dd.date;
    for(let i=0;i<starts.length;i++){
      const start=starts[i], code=String(row[start]??"").trim();
      if(!code)continue;
      const room=String(row[start+1]??"").trim();
      out.push({day:currentDay,date:currentDate,period:i+1,time:"",course:"",courseCode:code,section:"",room});
    }
  }
  return out;
}
function parseExamSource(rows) {
  const matrix=parseExamMatrix(rows);if(matrix.length)return matrix;
  const {headers,records}=rowsToObjects(rows),em=examMap(headers);
  const codeHeader=findHeader(headers,[/رمز المقرر/,/^الرمز$/]);
  if(!codeHeader)return [];
  return records.map(r=>({day:String(r[em.day]||"").trim(),date:excelDate(r[em.date]),period:periodNo(r[em.period]),time:"",course:"",courseCode:String(r[codeHeader]||"").trim(),section:em.section?String(r[em.section]||"").trim():"",room:String(r[em.room]||"").trim()})).filter(r=>r.courseCode);
}
async function prepareExamSchedules(files) {
  if(!state.ss01.length) throw new Error("استورد SS01 أولًا");
  const selected=[...files];if(!selected.length)return {selected,added:[],results:[]};
  const sm=fieldMap(state.ss01Headers), added=[], seen=new Map();
  for(const ex of state.exams)if(ex.section)seen.set(norm(ex.section),slotKey(ex));
  const byCode=new Map();
  for(const row of state.ss01)if(rowIncluded(row,sm)){const code=norm(row[sm.code]);if(!byCode.has(code))byCode.set(code,[]);byCode.get(code).push(row);}
  const results=[];
  for(const file of selected){
    const source=parseExamSource(await readTable(file));
    if(!source.length)throw new Error(`لم يُعثر على رموز مقررات في «${file.name}». لم يُضف أي ملف.`);
    let matched=0,duplicates=0,unmatched=0;const unmatchedCodes=[];
    for(const r of source) {
    const section=r.section;
    const matches=(byCode.get(norm(r.courseCode))||[]).filter(row=>!section||norm(row[sm.section])===norm(section));
    const unique=new Map(); for(const s of matches)unique.set(String(s[sm.section]||""),s);
    if(!unique.size){unmatched++;unmatchedCodes.push(`${r.courseCode}${section?` (شعبة ${section})`:""}`);continue;}
    for(const [sec,s] of unique) {
      const knownRoom=state.rooms.find(x=>norm(x.original)===norm(r.room)||norm(x.name)===norm(r.room));
      const ex={id:uid("ex"),day:r.day,date:r.date,period:r.period,time:"",course:String(s[sm.course]||r.courseCode).trim(),section:sec,dept:String(s[sm.dept]||"").trim(),courseTrainer:String(s[sm.trainer]||"").trim(),room:knownRoom?.name||r.room,inv1:"",inv2:"",pinned:false,notes:""};
      const key=norm(sec),slot=slotKey(ex),previous=seen.get(key);
      if(previous&&previous!==slot)throw new Error(`الشعبة ${sec} في «${file.name}» لها موعد آخر موجود في الجدول أو الملفات المختارة. أوقف الاستيراد دون إضافة أي ملف.`);
      if(previous===slot){duplicates++;continue;}
      seen.set(key,slot);added.push(ex);matched++;
    }
    }
    results.push({name:file.name,matched,duplicates,unmatched,unmatchedCodes});
    if(!matched&&!duplicates)throw new Error(`لم تُطابق أي شعبة من «${file.name}» مع SS01. أوقف الاستيراد دون إضافة أي ملف.`);
  }
  return {selected,added,results};
}
async function importExamSchedules(files) {
  const {selected,added,results}=await prepareExamSchedules(files);
  if(!selected.length)return;
  const duplicates=results.reduce((n,r)=>n+r.duplicates,0),unmatched=results.reduce((n,r)=>n+r.unmatched,0);
  if(!importReview(`مراجعة جداول الاختبارات\nملفات: ${selected.length}\nاختبارات جديدة: ${added.length}\nمكررة: ${duplicates}\nغير مطابقة: ${unmatched}\nسيتم إضافة الاختبارات الجديدة فقط مع إبقاء الاختبارات الحالية.\n${unmatched?"تحذير: توجد سجلات غير مطابقة؛ يلزم اختيار المتابعة صراحة.":""}\nهل تريد الدمج؟`))return false;
  const calendar=importedCalendar([...state.exams,...added]);
  state.exams.push(...added);state.meta.examName=selected.map(f=>f.name).join("، ");state.meta.examNames=[...new Set([...(state.meta.examNames||[]),...selected.map(f=>f.name)])];state.meta.examImportedAt=todayStamp();
  if(calendar)applyImportedCalendar(calendar);
  saveSoon();renderAll();runAudit();
  $("#examImportResult").innerHTML=results.map(r=>`<div class="importRow"><strong>${esc(r.name)}</strong><span class="audit-ok">أضيفت ${r.matched} شعبة</span><span>مكررة ${r.duplicates}</span>${r.unmatched?`<span class="audit-warning">لم تُطابق ${r.unmatched} خانة: ${esc([...new Set(r.unmatchedCodes)].join("، "))}</span>`:""}</div>`).join("");
  toast(`تمت إضافة ${added.length} شعبة من ${selected.length} ملف`);
}
async function importExamSchedule(file){return importExamSchedules([file]);}

const hijriFormatter=new Intl.DateTimeFormat("en-u-ca-islamic-umalqura",{year:"numeric",month:"2-digit",day:"2-digit",timeZone:"UTC"});
const calendarCache=new Map();
function hijriFromTime(time){const parts=Object.fromEntries(hijriFormatter.formatToParts(new Date(time)).map(p=>[p.type,p.value]));return `${parts.year}/${parts.month}/${parts.day}`;}
function calendarTime(value){
  const raw=westernDigits(value).trim().replace(/[.\-]/g,"/"),m=raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  if(year>=1700){const t=Date.UTC(year,month-1,day),d=new Date(t);return d.getUTCMonth()===month-1&&d.getUTCDate()===day?t:null;}
  const target=hijriDate(raw);if(!target)return null;
  if(calendarCache.has(target))return calendarCache.get(target);
  const estimated=Math.floor(622+year*0.970224);let low=Math.floor(Date.UTC(estimated-1,0,1)/86400000),high=Math.floor(Date.UTC(estimated+2,11,31)/86400000);
  while(low<=high){const middle=Math.floor((low+high)/2),time=middle*86400000,found=hijriFromTime(time);if(found===target){calendarCache.set(target,time);return time;}if(found<target)low=middle+1;else high=middle-1;}
  return null;
}
function importedCalendar(exams){
  const entries=exams.filter(e=>e.date).map(e=>({exam:e,time:calendarTime(e.date)}));
  if(entries.some(e=>e.time===null))throw new Error("يوجد تاريخ غير صالح في جدول الاختبارات. لم يُضف أي ملف.");
  if(!entries.length)return null;
  entries.sort((a,b)=>a.time-b.time);const first=entries[0],firstIndex=AR_DAYS.indexOf(first.exam.day);
  const start=first.time-(firstIndex>=0?firstIndex:new Date(first.time).getUTCDay())*86400000;
  const enabled=new Set();
  for(const entry of entries){const offset=Math.round((entry.time-start)/86400000),week=Math.floor(offset/7)+1,index=offset%7;
    if(week>4||index>4||offset<0)throw new Error("تواريخ الاختبارات تتجاوز الأسابيع الأربعة أو تتضمن يومًا خارج الأحد إلى الخميس. راجع الجدول قبل الاستيراد.");
    const day=AR_DAYS[index];if(entry.exam.day&&norm(entry.exam.day)!==norm(day))throw new Error(`اليوم والتاريخ غير متوافقين: ${entry.exam.day} ${entry.exam.date}. راجع الملف قبل الاستيراد.`);
    enabled.add(`${week}|${day}`);
  }
  return {days:Array.from({length:20},(_,i)=>{const week=Math.floor(i/5)+1,index=i%5,day=AR_DAYS[index];return {week,day,date:hijriFromTime(start+((week-1)*7+index)*86400000),active:enabled.has(`${week}|${day}`)};}),periods:new Set(exams.map(e=>Number(e.period)))};
}
function applyImportedCalendar(calendar){
  state.days=calendar.days.map(calculated=>({id:state.days.find(d=>d.week===calculated.week&&d.day===calculated.day)?.id||uid("day"),...calculated}));
  for(const period of state.periods)period.active=calendar.periods.has(Number(period.id));
  state.meta.calendarRevision=2;
}
function syncStoredCalendar(){
  if(state.meta.calendarRevision===2||!state.exams.length)return "";
  try{const calendar=importedCalendar(state.exams);if(calendar)applyImportedCalendar(calendar);return "";}catch(error){return `استعيدت بياناتك، لكن تعذر حساب الأيام تلقائيًا: ${error.message}`;}
}

function buildCandidates(code) {
  const m=fieldMap(state.ss01Headers), unique=new Map();
  for(const r of state.ss01) {
    if(!rowIncluded(r,m) || norm(r[m.code])!==norm(code))continue;
    const section=String(r[m.section]||"").trim();if(!section)continue;
    if(!unique.has(norm(section)))unique.set(norm(section),{
      section,course:String(r[m.course]||"").trim(),code,
      dept:String(r[m.dept]||"").trim(),courseTrainer:String(r[m.trainer]||"").trim()
    });
  }
  return [...unique.values()].sort((a,b)=>a.courseTrainer.localeCompare(b.courseTrainer,"ar")||a.section.localeCompare(b.section,"ar",{numeric:true}));
}
function renderBuilder() {
  const m=fieldMap(state.ss01Headers),codeEl=$("#buildCode"),old=codeEl.value;
  const scheduledSections=new Set(eligibleExams().map(e=>norm(e.section))),usedCodes=new Set(state.exams.filter(e=>scheduledSections.has(norm(e.section))).map(e=>norm(e.courseCode||eligibleSections().get(norm(e.section))?.code)).filter(Boolean));
  const codes=[...new Set(state.ss01.filter(r=>rowIncluded(r,m)).map(r=>String(r[m.code]||"").trim()).filter(c=>c&&!usedCodes.has(norm(c))))].sort((a,b)=>a.localeCompare(b,"ar",{numeric:true}));
  codeEl.innerHTML=`<option value="">— اختر رمز المقرر —</option>`+codes.map(c=>`<option value="${esc(c)}">${esc(c)}</option>`).join("");codeEl.value=old;
  const w=$("#buildWeek"),wo=w.value||"1";w.innerHTML=[1,2,3,4].map(n=>`<option value="${n}">الأسبوع ${n}</option>`).join("");w.value=wo;
  const p=$("#buildPeriod"),po=p.value||"1";p.innerHTML=state.periods.filter(x=>x.active).map(x=>`<option value="${x.id}">${esc(x.name)} — ${esc(x.time)}</option>`).join("");p.value=po;
  syncBuilderDate();previewBuilder();
}
function syncBuilderDate(){
  const daySelect=$("#buildDay"),dateSelect=$("#buildDate"),oldDay=daySelect.value;
  const days=state.days.filter(d=>d.week===Number($("#buildWeek").value)&&d.active&&d.date);
  daySelect.innerHTML=days.map(d=>`<option value="${esc(d.day)}">${esc(d.day)}</option>`).join("")||'<option value="">لا توجد أيام مفعلة</option>';
  if(days.some(d=>d.day===oldDay))daySelect.value=oldDay;
  const day=days.find(d=>d.day===daySelect.value);
  dateSelect.innerHTML=days.map(d=>`<option value="${esc(d.date)}">${esc(displayDate(d.date))}</option>`).join("")||'<option value="">لا يوجد تاريخ</option>';
  if(day)dateSelect.value=day.date;
}
function previewBuilder(){const list=buildCandidates($("#buildCode").value);$("#buildTable tbody").innerHTML=list.map(r=>`<tr><td><input type="checkbox" data-section="${esc(r.section)}" checked></td><td>${esc(r.courseTrainer)}</td><td>${esc(r.section)}</td><td>${esc(r.course)}</td><td>${esc(r.dept)}</td></tr>`).join("");$("#buildInfo").textContent=list.length?`${list.length} شعبة مميزة؛ راجع التحديد قبل الإضافة.`:"اختر رمز مقرر موجودًا في SS01.";$("#buildSelectAll").checked=!!list.length;}
function addBuiltExams(){
  const date=hijriDate($("#buildDate").value);if(!date)return notifyError("اختر أسبوعًا ويومًا مفعّلًا له تاريخ في الأيام والفترات");
  const week=Number($("#buildWeek").value),day=$("#buildDay").value,period=Number($("#buildPeriod").value),code=$("#buildCode").value;
  if(!code||!period)return notifyError("اختر رمز المقرر والفترة");
  const selected=new Set($$("#buildTable [data-section]:checked").map(x=>x.dataset.section)),dayRow=state.days.find(d=>d.week===week&&d.day===day);
  if(!selected.size)return notifyError("حدد شعبة واحدة على الأقل");
  if(dayRow){dayRow.date=date;dayRow.active=true;}
  let added=0;for(const r of buildCandidates(code)){
    if(!selected.has(r.section)||state.exams.some(e=>norm(e.section)===norm(r.section)))continue;
    state.exams.push({id:uid("ex"),week,day,date,period,time:state.periods.find(p=>p.id===period)?.time||"",course:r.course,courseCode:code,section:r.section,dept:r.dept,courseTrainer:r.courseTrainer,room:"",inv1:"",inv2:"",pinned:false,notes:""});added++;
  }
  saveSoon();renderAll();toast(`أُضيفت ${added} شعبة، وتُخطيت المكررات`);
}

function buildingOfRoom(room){const digits=roomCode(room);return digits?digits.slice(3,5):"";}
// Administrative building is derived from the trainer's department, not the SS01 classroom.
const DEPARTMENT_HOME_BUILDINGS=Object.freeze({
  "الدراسات العامة":"05", "تقنية البيئة":"05",
  "التقنية الإلكترونية":"06", "تقنية الأعمال":"03", "إداري":"03"
});
function sectionDepartmentBuildings(){
  const configured=state.meta?.departmentHomeBuildings??DEPARTMENT_HOME_BUILDINGS;
  return new Map(Object.entries(configured)
    .map(([dept,building])=>[norm(normalizeDepartment(dept)),westernDigits(building).trim().padStart(2,"0")])
    .filter(([dept,building])=>dept&&/^\d{2}$/.test(building)&&building!=="00"));
}
function isLocked(e,field){return e.pinned===true||e.pins?.[field]===true;}
function setLocked(e,field,value){
  if(e.pinned===true){e.pins={room:true,inv1:true,inv2:true};e.pinned=false;}
  e.pins??={};e.pins[field]=Boolean(value);
}
function pinButtonOld(e,field){const locked=isLocked(e,field);return `<button type="button" class="slotPin ${locked?'slotPinActive':''}" data-pin="${field}" title="${locked?'فك تثبيت':'تثبيت'} ${field==='room'?'القاعة':field==='inv1'?'المراقب الأول':'المراقب الثاني'}" aria-label="${locked?'فك تثبيت':'تثبيت'}" aria-pressed="${locked}"><span class="pinIcon">${locked?'🔒':'🔓'}</span></button>`;}
function isMonitorPairLocked(e){return isLocked(e,"inv1")&&isLocked(e,"inv2");}
function setMonitorPairLocked(e,v){setLocked(e,"inv1",v);setLocked(e,"inv2",v);}
function pinCheckbox(e,field){const checked=field==="monitors"?isMonitorPairLocked(e):isLocked(e,"room");return `<input type="checkbox" class="compactPin" data-pin="${field}" ${checked?"checked":""} title="${field==="room"?"تثبيت القاعة":"تثبيت المراقبين معًا"}" aria-label="${field==="room"?"تثبيت القاعة":"تثبيت المراقبين معًا"}">`;}
function bulkPinHeader(field){const all=eligibleExams(),n=all.filter(e=>field==="monitors"?isMonitorPairLocked(e):isLocked(e,"room")).length;return `<label class="bulkPinCheck"><input type="checkbox" data-bulk-pin="${field}" ${all.length&&n===all.length?"checked":""}> تثبيت الكل</label>`;}

function resetRoomAssignments(){
  let cleared=0;
  for(const e of eligibleExams())if(!isLocked(e,"room")&&e.room){e.room="";cleared++;}
  saveSoon();if(typeof document!=="undefined"){renderSchedule();renderReports();runAudit();toast(`أُعيد تعيين ${cleared} قاعة مع الحفاظ على المثبت`);}
  return cleared;
}
// القيادات الإشرافية: سجلات منفصلة مع الاحتفاظ ببيانات المدرب الأصلية.
const COMMITTEE_ROLE="عضو لجنة";
const COMMITTEE_CONFLICT="اختبار قسم عضو اللجنة";
const LEADERSHIP_ROLES=["عميد","وكيل تدريب","وكيل متدربين","وكيل جودة","عضو إرشاد",COMMITTEE_ROLE];
function leaders(){state.leadership??=[];return state.leadership;}
function leadershipTrainer(entry){return entry.trainer;}
function allMonitoringTrainers(){return [...state.trainers,...leaders().map(leadershipTrainer)];}
function findMonitoringTrainer(name){return allMonitoringTrainers().find(t=>norm(t.name)===norm(name));}
function leadershipGroup(entry){if(entry.role===COMMITTEE_ROLE)return null;return entry.role==="عضو إرشاد"?"guidance":"executive";}
function leadershipConflicts(){const issues=[];const bySlot=new Map();for(const e of eligibleExams())for(const name of [e.inv1,e.inv2]){const l=leaders().find(x=>norm(x.trainer.name)===norm(name));const group=l&&leadershipGroup(l);if(!group)continue;const key=slotKey(e)+"|"+group;const set=bySlot.get(key)||new Set();set.add(norm(l.trainer.name));bySlot.set(key,set);}for(const [key,set] of bySlot)if(set.size>1)issues.push({slot:key,names:[...set]});return issues;}
function addLeadership(trainerName,role,max=0,manualId=""){
 if(!LEADERSHIP_ROLES.includes(role))throw Error("منصب إشرافي غير معتمد");
 const name=String(trainerName||"").trim(),limit=Number(max);if(!name||!Number.isInteger(limit)||limit<0)throw Error("تحقق من الاسم والحد الأعلى");
 if(leaders().some(l=>norm(l.trainer.name)===norm(name)))throw Error("الاسم مسجل في القيادات الإشرافية");
 const idx=state.trainers.findIndex(t=>norm(t.name)===norm(name));const source=idx>=0?state.trainers[idx]:null;
 if(role===COMMITTEE_ROLE&&(!source||!departmentKeys(source.dept).length))throw Error("اختر عضو اللجنة من قائمة المدربين وتأكد من تحديد قسمه.");
 if(!source&&allMonitoringTrainers().some(t=>canonicalTrainerId(t.id)&&canonicalTrainerId(t.id)===canonicalTrainerId(manualId)))throw Error("الرقم الوظيفي مكرر");
 const trainer=source?structuredClone(source):{key:"lead_manual_"+Date.now()+"_"+Math.random().toString(36).slice(2),id:canonicalTrainerId(manualId),name,dept:"غير محدد",max:limit,active:true,source:"يدوي إشرافي"};
 if(source)state.trainers.splice(idx,1);
 const entry={trainer,role,max:limit,manual:!source};leaders().push(entry);saveSoon();return entry;
}
function removeLeadership(name){const idx=leaders().findIndex(l=>norm(l.trainer.name)===norm(name));if(idx<0)return false;const [entry]=leaders().splice(idx,1);if(!entry.manual&&!state.trainers.some(t=>trainerIdentity(t)===trainerIdentity(entry.trainer)))state.trainers.push(entry.trainer);saveSoon();return true;}
function trainerAvailable(t, ex) {
  const availability=state.availability[t.key];
  if(!availability||!Object.keys(availability).length)return true;
  const date=dayKey(ex);
  const keys=new Set([date,ex.date,`${ex.week||""}-${ex.day}`]);
  for(const d of state.days)if(d.date&&dayKey(d)===date)keys.add(`${d.week}-${d.day}`);
  for(const key of keys)if(key&&(availability[`${key}|${ex.period}`]==="X"||availability[`${key}|ALL`]==="X"))return false;
  return true;
}
function activeTrainer(t){return t.active!==false && String(t.active).toUpperCase()!=="X";}
function assignmentsFor(name){const target=norm(name);return eligibleExams().filter(e=>assignmentFields.some(f=>norm(e[f])===target));}
function hasConsecutiveTriple(periods) {
  const ordered = state.periods.map(p => Number(p.id)).sort((a,b) => a-b);
  return ordered.some((period,i) => i >= 2 && periods.has(period) &&
    periods.has(ordered[i-1]) && periods.has(ordered[i-2]));
}
function wouldMakeThree(name, exam, skipField) {
  const target=norm(name), date=dayKey(exam), periods=new Set([Number(exam.period)]);
  for (const e of eligibleExams()) if (dayKey(e)===date &&
      assignmentFields.some(f => !(e===exam&&f===skipField) && norm(e[f])===target)) periods.add(Number(e.period));
  return hasConsecutiveTriple(periods);
}
function sameDepartment(t,ex){const wanted=norm(normalizeDepartment(ex.dept));return !!wanted&&String(t.dept||"").split(/[،,]/).some(d=>norm(normalizeDepartment(d.trim()))===wanted);}
function courseTrainerConflict(name,exam,ownership) {
  const context=ownership||courseOwnership(eligibleExams(),distributionPeople(false));
  const person=context.byName.get(norm(name));
  return Boolean(person&&context.slots.get(slotKey(exam))?.owners.has(person.id));
}
function manualMonitorContext() {
  const exams = eligibleExams();
  return {exams, ownership:courseOwnership(exams,distributionPeople(false))};
}
function monitorAssignmentConflict(person,exam,field,exams) {
  const target=norm(person.name), slot=slotKey(exam);
  return exams.some(e=>slotKey(e)===slot&&assignmentFields.some(f=>
    !(e===exam&&f===field)&&norm(e[f])===target));
}
function monitorAssignmentWarnings(person,exam,field,{exams,ownership}) {
  const warnings=[];
  const slot=slotKey(exam), scheduled=ownership.slots.get(slot);
  if(!person.active) warnings.push("المدرب غير نشط");
  if(!trainerAvailable(person.trainer,exam)) warnings.push("المراقب مفرغ في هذه الفترة أو اليوم");
  if(committeeDepartmentConflict(person,scheduled)) {
    warnings.push(person.departments.length?"لقسم عضو اللجنة اختبار في هذه الفترة":"قسم عضو اللجنة غير محدد");
  }
  if(!monitoringOwnExamAllowed(person.trainer)&&scheduled?.owners.has(person.id)) {
    warnings.push("للمراقب اختبار مقرر في الفترة نفسها وسياسة اختبار المقرر تمنع تكليفه آليًا");
  }
  if(person.group&&exams.some(e=>slotKey(e)===slot&&assignmentFields.some(f=>
    !(e===exam&&f===field)&&ownership.byName.get(norm(e[f]))?.group===person.group))) {
    warnings.push("هناك قيادي آخر من المجموعة نفسها مكلّف في هذه الفترة");
  }
  if(monitorExceedsCap(person,exam,field,exams)) warnings.push(`تجاوز المراقب حده الأعلى (${person.max})`);
  if(wouldMakeThree(person.name,exam,field)) warnings.push("أصبح للمراقب ثلاث فترات متتالية في هذا اليوم");
  return warnings;
}
function monitorExceedsCap(person,exam,field,exams) {
  const target=norm(person.name);
  let count=1;
  for (const e of exams) for (const f of assignmentFields) {
    if (!(e===exam&&f===field) && norm(e[f])===target) count++;
  }
  return count>person.max;
}
function eligibleMonitorChoices(exam,field) {
  const context=manualMonitorContext();
  return [...context.ownership.byName.values()]
    .filter(person=>!monitorAssignmentConflict(person,exam,field,context.exams)&&
      !monitorAssignmentWarnings(person,exam,field,context).length);
}
function scheduleMonitorOptions(exam,field) {
  const selected=exam[field]||"";
  const context=manualMonitorContext();
  const choices=[...context.ownership.byName.values()]
    .map(person=>person.name)
    .sort((a,b)=>a.localeCompare(b,"ar"));
  const current=selected&&!choices.includes(selected)
    ? `<option value="${esc(selected)}" disabled>${esc(selected)} (التكليف الحالي غير متاح)</option>` : "";
  const placeholder=choices.length?"— اختر —":"لا يوجد مراقب متاح لهذه الفترة";
  return `<option value="">${placeholder}</option>${current}`+
    choices.map(name=>`<option value="${esc(name)}">${esc(name)}</option>`).join("");
}
function clearOwnExamMonitoring(t,ownership) {
  if (monitoringOwnExamAllowed(t)) return 0;
  let cleared=0;
  const working=eligibleExams();
  const context=ownership||courseOwnership(working,distributionPeople(false));
  for (const e of working) {
    const matches=assignmentFields.filter(field=>!isLocked(e,field)&&!isManualMonitor(e,field)&&norm(e[field])===norm(t.name));
    if (!matches.length||!courseTrainerConflict(t.name,e,context)) continue;
    for (const field of matches) {e[field]="";cleared++;}
  }
  return cleared;
}
function isManualMonitor(exam,field) {
  return Boolean(exam[field]&&exam.manualMonitors?.[field]===exam[field]);
}
function clearUnavailableAssignments() {
  const byName=new Map(allMonitoringTrainers().map(t=>[norm(t.name),t]));
  let removed=0;
  for (const e of state.exams) for (const field of assignmentFields) {
    if (!e[field]||isLocked(e,field)) continue;
    const t=byName.get(norm(e[field]));
    if (!t||(!isManualMonitor(e,field)&&(!activeTrainer(t)||!trainerAvailable(t,e)))) {e[field]="";removed++;}
  }
  return removed;
}
function removeInactiveAssignments(){return clearUnavailableAssignments();}
function refreshAfterAvailabilityChange(){const removed=clearUnavailableAssignments();saveSoon();renderAvailabilitySummary();renderSchedule();renderReports();runAudit();if(removed)toast(`أُزيل ${removed} إسناد غير متاح؛ الخانة تنتظر مراقبًا`,"warning");}
function stripDistributionNote(notes){return String(notes||"").split(/\s*؛\s*/).filter(x=>x&&!/^عجز في المراقبين/.test(x)&&!/^مدرب المقرر .* مفرغ للمتابعة$/.test(x)&&!/^أُلغي تكليف (مراقب بسبب عدم التوفر|مدرب غير نشط)$/.test(x)).join("؛ ");}
function resetMonitors(){let cleared=0;for(const e of state.exams){for(const field of ["inv1","inv2"].filter(f=>!isLocked(e,f)))if(e[field]){e[field]="";if(e.manualMonitors)delete e.manualMonitors[field];cleared++;}e.notes=stripDistributionNote(e.notes);}saveSoon();if(typeof document!=="undefined"){renderAll();runAudit();toast(`أُزيل ${cleared} إسناد مع إبقاء المثبت`);}return cleared;}
function joinNote(a,b){return a?`${a}؛ ${b}`:b;}

function runAudit(){
  const rows=[],seen=new Map(),seenRooms=new Map(),counts=new Map(),working=eligibleExams();
  const roster=monitoringRoster(), people=new Map(roster.map(entry=>[norm(entry.trainer.name),entry]));
  const ownership=courseOwnership(working,distributionPeople(false)), buildings=new Map();
  const enrollments=sectionEnrollments();
  for(const room of state.rooms){
    if(room.enabled===false)continue;
    if(!(num(room.capacity)>0))rows.push(["تحذير","سعة غير محددة",`${room.name} — أدخل السعة من صفحة القاعات`,"القاعات"]);
  }
  for(const e of working){
    const rowStart=rows.length;
    if(!e.section)rows.push(["خطأ","شعبة ناقصة",`${e.course} — ${e.day}`,"الشعب"]);
    if(!e.room)rows.push(["تحذير","قاعة غير معينة",`${e.course} — شعبة ${e.section}`,"القاعات"]);
    if(e.room){const room=roomRecord(e.room),roomId=roomCode(room);if(!roomId)rows.push(["خطأ","قاعة غير معروفة",`${e.room} — شعبة ${e.section}`,"القاعات"]);
      else if(room.enabled===false)rows.push(["خطأ","قاعة مستبعدة",`${e.room} — شعبة ${e.section}`,"القاعات"]);
      else {const k=`${slotKey(e)}|${roomId}`;if(seenRooms.has(k))rows.push(["خطأ","تعارض قاعة",`${e.room} في ${e.day} الفترة ${e.period}`,"القاعات"]);else seenRooms.set(k,true);}}
    const assignedRoom=roomRecord(e.room),enrolled=enrollments.get(norm(e.section));
    const building=buildingOfRoom(assignedRoom);
    if (building&&assignedRoom.enabled!==false) {
      for (const owner of ownership.records.get(e).owners) {
        const key=JSON.stringify([slotKey(e),owner]);
        if (!buildings.has(key)) buildings.set(key,{exam:e,values:new Set()});
        buildings.get(key).values.add(building);
      }
    }
    if(assignedRoom&&num(assignedRoom.capacity)>0&&enrolled!==undefined&&enrolled>num(assignedRoom.capacity))rows.push(["تحذير","تجاوز سعة القاعة",`الشعبة ${e.section} — ${assignedRoom.name} — المسجلون ${enrolled}؛ السعة ${assignedRoom.capacity}؛ الزيادة ${enrolled-num(assignedRoom.capacity)}`,"القاعات"]);
    if(!e.inv1||!e.inv2)rows.push(["خطأ",e.inv1||e.inv2?"نقص مراقب":"المراقبان غير معينين",`${e.course} — شعبة ${e.section} — ${e.day} الفترة ${e.period} — ${e.inv1?"مراقب ١ فقط":e.inv2?"مراقب ٢ فقط":"لا يوجد مراقبان"}`,"المدربون"]);
    if(e.inv1&&e.inv1===e.inv2)rows.push(["خطأ","تكرار المراقب",`${e.inv1} في الشعبة ${e.section}`,"المدربون"]);
    for(const n of [e.inv1,e.inv2])if(n){const name=norm(n);counts.set(name,(counts.get(name)||0)+1);const k=`${slotKey(e)}|${name}`;if(seen.has(k))rows.push(["خطأ","تعارض مراقب",`${n} في ${e.day} الفترة ${e.period}`,"المدربون"]);else seen.set(k,true);
      const t=people.get(name)?.trainer;if(!t||!activeTrainer(t))rows.push([t?"تحذير":"خطأ","مدرب غير نشط أو غير معروف",`${n} — شعبة ${e.section}`,"المدربون"]);
      if(committeeDepartmentConflict(ownership.byName.get(name),ownership.slots.get(slotKey(e))))rows.push(["تحذير",COMMITTEE_CONFLICT,`${n} — ${e.day} الفترة ${e.period} — يوجد اختبار للقسم أو لم يُحدد قسم العضو`,"المدربون"]);
      if(t&&!trainerAvailable(t,e))rows.push(["تحذير","مخالفة التفريغ",`${n} في ${e.day} الفترة ${e.period}`,"المدربون"]);
      if(t&&!monitoringOwnExamAllowed(t)&&courseTrainerConflict(n,e,ownership))rows.push(["تحذير","مدرب مقرر لديه اختبار",`${n} في ${e.day} الفترة ${e.period}`,"المدربون"]);
    }
    for(let i=rowStart;i<rows.length;i++)rows[i][4]=e.id;
  }
  for (const {trainer:t,max} of roster) {
    const count=counts.get(norm(t.name))||0;
    if (count>Number(max)) rows.push(["تحذير","تجاوز الحد الأعلى",`${t.name}: ${count} من ${max}`,"المدربون"]);
    if (!count) continue;
    const byDay=new Map();
    for (const e of assignmentsFor(t.name)) {
      const key=dayKey(e),periods=byDay.get(key)||new Set();
      periods.add(Number(e.period));byDay.set(key,periods);
    }
    for (const [key,periods] of byDay) if (hasConsecutiveTriple(periods)) {
      rows.push(["تحذير","ثلاث فترات متتابعة",`${t.name} — ${displayDate(key)}`,"المدربون"]);
    }
  }
  for (const {exam,values} of buildings.values()) if (values.size>2) {
    rows.push(["خطأ","تجاوز حد المبنيين",`${exam.courseTrainer||exam.section} · ${displayDate(exam.date)} · الفترة ${exam.period}`,"القاعات",exam.id]);
  }
  for (const issue of leadershipConflicts()) {
    const [date,period]=issue.slot.split("|");
    rows.push(["تحذير","تعارض قيادات",`${displayDate(date)}، الفترة ${period}: ${issue.names.join("، ")}`,"المدربون"]);
  }
  const expected=eligibleSections(),scheduled=new Set(working.map(e=>norm(e.section)).filter(Boolean));
  if(!state.ss01.length)rows.push(["تحذير","بيانات SS01 غير مستوردة","استورد تقرير SS01 أولًا","الشعب"]);
  if(!working.length)rows.push(["تحذير","لم يُبنَ جدول الاختبارات","استورد جدول الاختبارات أو أنشئه من صفحة البناء","الشعب"]);
  for(const [key,item] of expected)if(!scheduled.has(key))rows.push(["تحذير","شعبة غير مجدولة",`${item.course||"مقرر غير مسمى"} (${item.code||"رمز غير محدد"}) — شعبة ${item.section} — النوع: ${item.type||"غير محدد"}`,"الشعب"]);
  auditRows=rows;
  state.auditExceptions??={};
  const current=new Set(rows.filter(canExceptAuditRow).map(auditKey));
  for(const key of Object.keys(state.auditExceptions))if(!current.has(key))delete state.auditExceptions[key];
  if(typeof document!=="undefined"){renderAudit();if(!$("#scheduleAuditPanel")?.hidden)renderScheduleAudit();}return rows;
}
function auditKey(row){return JSON.stringify([row[0],row[1],row[2],row[3],row[4]||""]);}
function canExceptAuditRow(row){return row[1]!=="ثلاث فترات متتابعة"&&row[1]!==COMMITTEE_CONFLICT;}
function activeAuditRows(){return auditRows.filter(row=>!state.auditExceptions?.[auditKey(row)]);}

function renderScheduleAudit(){
  const panel=$("#scheduleAuditPanel");if(!panel||panel.hidden)return;
  const active=activeAuditRows(),errors=active.filter(r=>r[0]==="خطأ").length,warnings=active.length-errors;
  const help={"تعارض قاعة":"اختر قاعة أخرى متاحة في الفترة نفسها.","قاعة غير معينة":"عيّن قاعة متاحة للاختبار.","قاعة غير معروفة":"اختر قاعة من قائمة القاعات المعتمدة.","قاعة مستبعدة":"اختر قاعة متاحة أو راجع حالة القاعة.","نقص مراقب":"أكمل خانة المراقب الشاغرة بمدرب متاح.","المراقبان غير معينين":"عيّن مراقبين متاحين للاختبار.","تكرار المراقب":"اختر مدربًا مختلفًا للخانة الثانية.","تعارض مراقب":"غيّر أحد تكليفات المدرب في هذه الفترة.","مخالفة التفريغ":"اختر مدربًا متاحًا أو راجع التفريغ المعتمد.","مدرب غير نشط أو غير معروف":"اختر مدربًا نشطًا من القائمة.","مدرب مقرر لديه اختبار":"اختر مدربًا آخر أو راجع خيار السماح في المدربون.","تجاوز الحد الأعلى":"راجع إجمالي تكليفات المدرب وحدّه الأعلى.","ثلاث فترات متتابعة":"انقل أحد التكليفات إلى مدرب متاح.","شعبة غير مجدولة":"راجع بناء جدول الاختبارات لإضافة الشعبة."};
  panel.innerHTML=`<div class="auditPanelHead"><div><h3>نتيجة فحص الجدول</h3><p>فحص وإرشاد؛ معالجة المشكلات تتم يدويًا.</p></div><button type="button" id="openFullAudit">التفاصيل في التحقق</button></div><div class="auditPills"><span class="audit-error">${errors} أخطاء</span><span class="audit-warning">${warnings} تحذيرات</span><span>${Object.keys(state.auditExceptions||{}).length} استثناءات</span><strong>${esc(auditStatus())}</strong></div>${active.length?`<details open><summary>المشكلات والإرشادات (${active.length})</summary><div class="auditIssueList">${active.map((r,i)=>`<div class="auditIssue"><div><strong class="${r[0]==="خطأ"?"audit-error":"audit-warning"}">${esc(r[1])}</strong><p>${esc(r[2])}</p><small>${esc(help[r[1]]||"راجع البيانات في التبويب المختص.")}</small></div><button type="button" data-issue="${i}">${r[4]?"انتقل إلى الاختبار":"عرض في التحقق"}</button></div>`).join("")}</div></details>`:'<p class="audit-ok">لا توجد أخطاء أو تحذيرات غير مستثناة في الفحوص الحالية.</p>'}`;
  $("#openFullAudit").onclick=()=>$('#tabs button[data-page="audit"]').click();
  for(const button of $$("[data-issue]",panel))button.onclick=()=>{
    const row=active[Number(button.dataset.issue)];if(!row[4])return $('#tabs button[data-page="audit"]').click();
    $("#scheduleSearch").value="";$("#scheduleDayFilter").value="";renderSchedule();
    const tr=$$("#scheduleTable tr[data-id]").find(x=>x.dataset.id===row[4]);
    if(tr){tr.classList.add("auditTarget");tr.scrollIntoView({behavior:"smooth",block:"center"});const field=$("select[data-f=room],select[data-f=inv1],input",tr);field?.focus({preventScroll:true});setTimeout(()=>tr.classList.remove("auditTarget"),5000);}
  };
}
function renderMetrics(){
  const working=eligibleExams(),assigned=working.filter(e=>e.inv1&&e.inv2).length,counts=[
    ["شعب SS01 المؤهلة",eligibleSections().size],["المدربون النشطون",state.trainers.filter(activeTrainer).length],["القاعات",new Set(state.rooms.map(roomCode).filter(Boolean)).size],["الشعب المجدولة",working.length],["مكتملة التوزيع",assigned]
  ];$("#metrics").innerHTML=counts.map(([l,v])=>`<div class="metric"><strong>${v}</strong><span>${l}</span></div>`).join("");
  $("#termLabel").textContent=trainingTermLabel()||"فصل غير محدد";
  $("#ss01Info").textContent=state.meta.ss01Name?`${state.meta.ss01Name} — ${state.meta.ss01ImportedAt}`:"لم يتم الاستيراد";
  const imported=state.meta.examNames?.length?state.meta.examNames.join("، "):state.meta.examName;
  $("#examInfo").textContent=imported?`${imported} — آخر استيراد ${state.meta.examImportedAt}`:"لم يتم الاستيراد";
}
function bindEditable(el, obj, key, parser=v=>v){el.addEventListener("change",()=>{obj[key]=parser(el.type==="checkbox"?el.checked:el.value);saveSoon();});}
const APPROVED_DEPARTMENTS=["تقنية البيئة","الدراسات العامة","التقنية الإلكترونية","تقنية الأعمال","إداري"];
function normalizeDepartment(value){
 const n=norm(String(value||"").replace(/[\u064b-\u065f]/g,"")).replace(/أ|إ|آ/g,"ا");
 if(n.includes("كيميائي")||n.includes("بيئ"))return "تقنية البيئة";
 if(n.includes("ميكانيكي")||n.includes("الكتروني"))return "التقنية الإلكترونية";
 if(n.includes("حاسب")||n.includes("اعمال"))return "تقنية الأعمال";
 if(n.includes("دراسات عام"))return "الدراسات العامة";
 if(n.includes("اداري")||n.includes("شؤون ادار"))return "إداري";
 return value||"";
}
function departmentOptions(current){return APPROVED_DEPARTMENTS.map(d=>`<option value="${esc(d)}" ${normalizeDepartment(current)===d?"selected":""}>${esc(d)}</option>`).join("");}
function renderLeadership(){
 const tbody=$("#leadershipTable tbody");if(!tbody)return;
 tbody.innerHTML=leaders().map(l=>`<tr><td>${esc(l.trainer.name)}</td><td>${esc(l.trainer.id||"—")}</td><td>${esc(l.role)}</td><td>${esc(l.trainer.dept||"غير محدد")}</td><td><input type="number" min="0" data-limit="${esc(l.trainer.key)}" value="${l.max}"></td><td>${assignmentsFor(l.trainer.name).length}</td><td><button type="button" data-remove-leader="${esc(l.trainer.key)}">إزالة وإعادة المدرب</button></td></tr>`).join("")||'<tr><td colspan="7">لم تُضف قيادات أو أعضاء لجان بعد.</td></tr>';
 for(const input of $$('[data-limit]',tbody))input.onchange=()=>{const l=leaders().find(x=>x.trainer.key===input.dataset.limit);if(!l)return;const v=Number(input.value);if(!Number.isInteger(v)||v<0){input.value=l.max;return;}l.max=v;saveSoon();renderLeadership();runAudit();toast("تم تحديث سقف المراقبات");};
 for(const b of $$('[data-remove-leader]',tbody))b.onclick=()=>{const l=leaders().find(x=>x.trainer.key===b.dataset.removeLeader);if(!l)return;removeLeadership(l.trainer.name);renderAll();toast("تمت الإزالة من القيادات ولجان الاختبار");};
 const selector=$("#leadershipTrainer");const old=selector.value;selector.innerHTML='<option value="">— اختر من المدربين —</option>'+state.trainers.slice().sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t=>`<option value="${esc(t.name)}">${esc(t.name)} — ${esc(t.id)}</option>`).join("");selector.value=old;
}
function renderTrainers(){const control=$("#ownExamMonitoringMode");control.value=state.meta?.ownExamMonitoringMode||"individual";const individual=control.value==="individual";const b=$("#trainersTable tbody");b.innerHTML=state.trainers.map(t=>`<tr data-key="${t.key}"><td><input data-f="id" value="${esc(t.id)}"></td><td><input data-f="name" type="text" aria-label="اسم المدرب" value="${esc(t.name)}"></td><td><select data-f="dept" aria-label="القسم">${departmentOptions(t.dept)}</select></td><td><select data-f="active"><option value="true" ${activeTrainer(t)?"selected":""}>متاح</option><option value="false" ${!activeTrainer(t)?"selected":""}>X</option></select></td><td><input type="number" min="0" data-f="max" value="${num(t.max,999)}"></td><td>${individual?'<label><input type="checkbox" data-f="allowOwnExamMonitoring" '+(t.allowOwnExamMonitoring===true?'checked':'')+'> نعم</label>':`<span class="monitoringPolicyStatus">${monitoringOwnExamAllowed(t)?"مسموح":"ممنوع"}</span>`}</td><td class="source">${esc(t.source)}</td></tr>`).join("");
  const query=norm($("#trainerSearch").value);for(const tr of $$("tr[data-key]",b)){const t=state.trainers.find(x=>x.key===tr.dataset.key);tr.hidden=!!query&&!norm(t.name).includes(query);}
  for(const tr of $$("tr[data-key]",b)){const t=state.trainers.find(x=>x.key===tr.dataset.key);for(const e of $$('[data-f]',tr)){
    if(e.dataset.f==="active")e.onchange=()=>{t.active=e.value==="true";refreshAfterAvailabilityChange();renderTrainers();};
    else if(e.dataset.f==="allowOwnExamMonitoring")e.onchange=()=>{t.allowOwnExamMonitoring=e.checked;const cleared=clearOwnExamMonitoring(t);saveSoon();renderSchedule();renderReports();runAudit();if(cleared)toast(`أُزيل ${cleared} تكليفًا أثناء اختبار مقرر المدرب`,"warning");};
    else if(e.dataset.f==="dept")e.onchange=()=>{t.dept=normalizeDepartment(e.value);saveSoon();renderSchedule();renderReports();};
    else if(e.dataset.f==="id")e.onchange=()=>{const id=canonicalTrainerId(e.value);if(id&&allMonitoringTrainers().some(x=>x!==t&&canonicalTrainerId(x.id)===id)){notifyError("هذا الرقم الوظيفي موجود بالفعل");e.value=t.id;return;}t.id=id;saveSoon();renderTrainers();};
    else if(e.dataset.f==="max")e.onchange=()=>{
      const limit=Number(e.value);
      if(e.value===""||!Number.isSafeInteger(limit)||limit<0){e.value=t.max??999;notifyError("أدخل حدًا أعلى صحيحًا.");return;}
      t.max=limit;saveSoon();runAudit();toast("تم حفظ الحد الأعلى للمراقبات");
    };
    else bindEditable(e,t,e.dataset.f,v=>v);
  }}
}
function fitTrainerTextareas(){for(const input of $$("#trainersTable textarea")){input.style.height="auto";input.style.height=`${Math.max(34,input.scrollHeight+2)}px`;input.oninput=()=>{input.style.height="auto";input.style.height=`${Math.max(34,input.scrollHeight+2)}px`;};}}
function renderDepartmentBuildings() {
  const panel=$("#departmentBuildings");
  const homes=sectionDepartmentBuildings();
  const departments=new Map(APPROVED_DEPARTMENTS.map(d=>[norm(d),d]));
  for (const {trainer} of monitoringRoster()) {
    for (const raw of String(trainer.dept||"").split(/[،,]/)) {
      const name=normalizeDepartment(raw.trim());
      if (name) departments.set(norm(name),name);
    }
  }
  const buildings=[...new Set(state.rooms.map(buildingOfRoom).filter(Boolean))].sort();
  const options=(department)=>{
    const selected=homes.get(department)||"";
    return '<option value="">غير محدد</option>'+[...new Set([...buildings,...(selected?[selected]:[])])].sort()
      .map(building=>`<option value="${esc(building)}" ${building===selected?"selected":""}>${esc(building)}</option>`).join("");
  };
  panel.innerHTML=[...departments].map(([key,name])=>
    `<label>${esc(name)} <select data-department-home="${esc(key)}">${options(key)}</select></label>`).join("");
  for (const select of $$("select[data-department-home]",panel)) select.onchange=()=>{
    const key=select.dataset.departmentHome;
    if (select.value) homes.set(key,select.value);
    else homes.delete(key);
    state.meta.departmentHomeBuildings=Object.fromEntries(homes);
    renderDistributionStatus("","");
    saveSoon();
  };
}
function renderRooms(){renderDepartmentBuildings();const b=$("#roomsTable tbody");b.innerHTML=state.rooms.map(r=>`<tr data-key="${r.key}" class="${r.enabled===false?"roomExcluded":""}"><td><input data-f="name" aria-label="اسم القاعة" value="${esc(r.name)}">${r.enabled===false?'<small class="roomExcludedLabel">مستبعدة</small>':""}</td><td><input data-f="original" value="${esc(r.original)}"></td><td><input type="number" data-f="capacity" value="${num(r.capacity)}"></td><td class="source">${esc(r.source)}</td></tr>`).join("");for(const tr of $$("tr[data-key]",b)){const r=state.rooms.find(x=>x.key===tr.dataset.key);const query=norm(westernDigits($("#roomSearch").value));tr.hidden=!!query&&!norm(westernDigits([r.name,r.original].join(" "))).includes(query);for(const e of $$('[data-f]',tr)){if(e.dataset.f==="capacity"){e.min="0";e.onchange=()=>{setRoomCapacity(r,e.value);saveSoon();runAudit();};}else bindEditable(e,r,e.dataset.f);}}}
function trainerOptions(selected=""){return `<option value="">— اختر —</option>`+allMonitoringTrainers().filter(activeTrainer).sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t=>`<option ${t.name===selected?"selected":""}>${esc(t.name)}</option>`).join("");}
function roomOptions(selected=""){const seen=new Set();return `<option value="">— بدون قاعة —</option>`+state.rooms.filter(r=>{const code=roomCode(r);if(!code||seen.has(code)||r.enabled===false&&validRoomLabel(selected)!==formatRoom(r.original))return false;seen.add(code);return true;}).map(r=>`<option ${validRoomLabel(selected)===formatRoom(r.original)?"selected":""}>${esc(formatRoom(r.original))}</option>`).join("");}
function availabilityDetails(availability){
  return Object.entries(availability||{}).filter(([,v])=>v==="X").sort((a,b)=>a[0].localeCompare(b[0],"ar",{numeric:true})).map(([entry])=>{
    const split=entry.lastIndexOf("|"),key=entry.slice(0,split),period=entry.slice(split+1);
    const day=state.days.find(d=>d.date===key||`${d.week}-${d.day}`===key);
    const date=day?.date?` (${displayDate(day.date)})`:key.match(/^1[34]\d{2}\//)?` (${displayDate(key)})`:"";
    const dayText=day?`الأسبوع ${day.week} — ${day.day}${date}`:displayDate(key);
    const periodText=period==="ALL"?"اليوم كامل":state.periods.find(p=>String(p.id)===period)?.name||`الفترة ${arabicDigits(period)}`;
    return `${dayText}: ${periodText}`;
  });
}
function renderAvailabilitySummary(){
  const tbody=$("#availabilitySummary tbody");
  tbody.innerHTML=allMonitoringTrainers().filter(t=>availabilityDetails(state.availability[t.key]).length).sort((a,b)=>a.name.localeCompare(b.name,"ar")).map(t=>`<tr data-trainer-key="${esc(t.key)}"><td>${esc(t.name)}</td><td><bdi>${esc(t.id||"—")}</bdi></td><td>${availabilityDetails(state.availability[t.key]).map(d=>`<div class="availabilityDetail">${esc(d)}</div>`).join("")}</td><td><label><input type="checkbox" data-pin-availability ${state.availabilityPinned?.[t.key]?"checked":""}> مثبت</label></td></tr>`).join("")||'<tr><td colspan="4">لا يوجد مدربون مفرغون.</td></tr>';
  for(const row of $$("tr[data-trainer-key]",tbody))$("[data-pin-availability]",row).onchange=e=>{state.availabilityPinned??={};if(e.target.checked)state.availabilityPinned[row.dataset.trainerKey]=true;else delete state.availabilityPinned[row.dataset.trainerKey];saveSoon();};
}
function resetAvailability(){
  let cleared=0;
  for(const key of Object.keys(state.availability)){if(state.availabilityPinned?.[key])continue;cleared+=Object.values(state.availability[key]||{}).filter(v=>v==="X").length;delete state.availability[key];}
  if(typeof document!=="undefined"){refreshAfterAvailabilityChange();renderAvailability();}return cleared;
}
function renderAvailability(){
  renderAvailabilitySummary();
  const ts=$("#availabilityTrainer"),old=ts.value;
  ts.innerHTML=trainerOptions(old);
  if(!ts.value&&allMonitoringTrainers()[0])ts.value=allMonitoringTrainers()[0].name;
  const t=allMonitoringTrainers().find(x=>x.name===ts.value);
  const days=state.days.filter(d=>d.active&&d.date).sort((a,b)=>(calendarTime(a.date)??Infinity)-(calendarTime(b.date)??Infinity));
  const periods=state.periods.filter(p=>p.active);
  const grid=$("#availabilityGrid");
  if(!t){grid.innerHTML="<p>اختر مدربًا لعرض التفريغ.</p>";return;}
  if(!days.length||!periods.length){grid.innerHTML="<p>لا توجد أيام وفترات مفعّلة. فعّلها من تبويب الأيام والفترات.</p>";return;}
  const availability=state.availability[t.key]||{};
  grid.innerHTML=`<div class="tableWrap availabilityAllWeeks"><table class="availabilityMatrix"><thead><tr><th>اليوم والتاريخ</th><th>اليوم كامل</th>${periods.map(p=>`<th><label class="bulkPeriodLabel"><input type="checkbox" data-bulk-period="${p.id}" aria-label="تفريغ ${esc(p.name)} لجميع الأيام">${esc(p.name)}</label><small>${esc(p.time)}</small></th>`).join("")}</tr></thead><tbody>${days.map(d=>{
    const dk=dayKey(d),legacy=d.date||`${d.week}-${d.day}`;
    const all=availability[`${dk}|ALL`]==="X"||availability[`${legacy}|ALL`]==="X";
    return `<tr><th scope="row">${esc(d.day)} — <bdi>${esc(displayDate(d.date))}</bdi></th><td><label><input type="checkbox" data-day="${esc(dk)}" ${all?"checked":""} aria-label="تفريغ اليوم كامل"></label></td>${periods.map(p=>{
      const checked=all||availability[`${dk}|${p.id}`]==="X"||availability[`${legacy}|${p.id}`]==="X";
      return `<td><label class="availabilityCell"><input type="checkbox" data-slot="${esc(dk)}|${p.id}" ${checked?"checked":""} ${all?"disabled":""}><span class="availabilityState ${checked?"unavailable":"available"}">${checked?"—":"متاح"}</span></label></td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody></table></div>`;
  // رأس كل فترة: تحديد الكل، إلغاء الكل، أو حالة جزئية دون المساس بتفريغ اليوم الكامل.
  for(const bulk of $$('[data-bulk-period]',grid)){
    const period=bulk.dataset.bulkPeriod;
    const slots=days.map(d=>({key:dayKey(d),legacy:d.date||`${d.week}-${d.day}`}));
    const selected=slots.filter(({key,legacy})=>availability[`${key}|ALL`]==="X"||availability[`${legacy}|ALL`]==="X"||availability[`${key}|${period}`]==="X"||availability[`${legacy}|${period}`]==="X").length;
    bulk.checked=selected===slots.length;bulk.indeterminate=selected>0&&selected<slots.length;
    bulk.onchange=()=>{
      state.availability[t.key]??={};
      for(const {key,legacy} of slots){
        if(state.availability[t.key][`${key}|ALL`]==="X"||state.availability[t.key][`${legacy}|ALL`]==="X")continue;
        if(bulk.checked)state.availability[t.key][`${key}|${period}`]="X";
        else{delete state.availability[t.key][`${key}|${period}`];delete state.availability[t.key][`${legacy}|${period}`];}
      }
      refreshAfterAvailabilityChange();renderAvailability();
    };
  }
  for(const e of $$('[data-day]',grid))e.onchange=()=>{
    state.availability[t.key]??={};const k=`${e.dataset.day}|ALL`;
    if(e.checked)state.availability[t.key][k]="X";else delete state.availability[t.key][k];
    refreshAfterAvailabilityChange();renderAvailability();
  };
  for(const e of $$('[data-slot]',grid))e.onchange=()=>{
    state.availability[t.key]??={};
    if(e.checked)state.availability[t.key][e.dataset.slot]="X";else delete state.availability[t.key][e.dataset.slot];
    refreshAfterAvailabilityChange();renderAvailability();
  };
}

function renderPeriods(){
  $("#periodEditor").innerHTML=state.periods.map(p=>`<div class="periodRow"><input type="checkbox" data-active="${p.id}" ${p.active?"checked":""}><input data-name="${p.id}" value="${esc(p.name)}"><input data-time="${p.id}" value="${esc(p.time)}"></div>`).join("");
  for(const p of state.periods){bindEditable($(`[data-active="${p.id}"]`),p,"active");bindEditable($(`[data-name="${p.id}"]`),p,"name");$(`[data-time="${p.id}"]`).onchange=e=>{p.time=e.target.value;saveSoon();renderSchedule();renderReports();renderAnnouncement();renderBuilder();};}
  $("#dayEditor").innerHTML=[1,2,3,4].map(w=>`<div class="weekHeading"><label><input type="checkbox" data-week="${w}" ${state.days.filter(d=>d.week===w).every(d=>d.active)?"checked":""}> تحديد الأسبوع ${w}</label></div>`+state.days.filter(d=>d.week===w).map(d=>`<div class="dayRow"><input type="checkbox" data-da="${d.id}" ${d.active?"checked":""}><span>أ${d.week} — ${esc(d.day)}</span><input type="text" inputmode="numeric" dir="ltr" placeholder="١٤٤٨/٠٨/٢٢" data-dd="${d.id}" value="${esc(displayDate(d.date))}"><span>هجري: سنة/شهر/يوم</span></div>`).join("")).join("");
  $("#selectAllDays").checked=state.days.every(d=>d.active);
  for(const d of state.days){$(`[data-da="${d.id}"]`).onchange=e=>{d.active=e.target.checked;saveSoon();renderPeriods();renderBuilder();};$(`[data-dd="${d.id}"]`).onchange=e=>{const value=e.target.value.trim(),parsed=value?hijriDate(value):"";if(value&&!parsed){notifyError("التاريخ الهجري يجب أن يكون مثل ١٤٤٨/٠٨/٢٢");e.target.value=displayDate(d.date);return;}d.date=parsed;refreshAfterAvailabilityChange();renderBuilder();renderSchedule();renderAvailability();renderAnnouncement();};}
  for(const el of $$("[data-week]"))el.onchange=()=>{state.days.filter(d=>d.week===Number(el.dataset.week)).forEach(d=>d.active=el.checked);saveSoon();renderPeriods();renderBuilder();};
}
function renderSchedule(){
  const q=norm($("#scheduleSearch").value),df=$("#scheduleDayFilter").value,working=eligibleExams();
  const days=[...new Map(working.filter(e=>e.date).map(e=>[dayKey(e),{date:e.date,day:e.day}])).entries()].sort((a,b)=>(calendarTime(a[1].date)??Infinity)-(calendarTime(b[1].date)??Infinity));
  $("#scheduleDayFilter").innerHTML=`<option value="">كل الأيام والتواريخ</option>`+days.map(([key,d])=>`<option value="${esc(key)}" ${key===df?"selected":""}>${esc(d.day)} — ${esc(displayDate(d.date))}</option>`).join("");
  const list=working.filter(e=>(!df||dayKey(e)===df)&&(!q||norm([e.course,e.section,e.courseTrainer,e.inv1,e.inv2].join(" ")).includes(q)))
    .sort((a,b)=>(calendarTime(a.date)??Infinity)-(calendarTime(b.date)??Infinity)||Number(a.period)-Number(b.period)||String(a.section).localeCompare(String(b.section),"ar",{numeric:true}));
  const conflicts=manualConflictNames(),roomConflicts=manualConflictRooms();
  for(const field of ["room","monitors"]){const header=$("#"+(field==="monitors"?"monitorsPinHeader":"roomPinHeader"));if(header){header.innerHTML=bulkPinHeader(field);header.querySelector("input").onchange=ev=>{const target=ev.target.checked;if(!target&&!confirm("فك تثبيت جميع عناصر هذا العمود؟")){ev.target.checked=true;return;}for(const e of working){if(field==="monitors")setMonitorPairLocked(e,target);else setLocked(e,"room",target);}saveSoon();renderSchedule();};}}

  $("#scheduleTable tbody").innerHTML=list.map(e=>`<tr data-id="${e.id}"><td><input data-f="day" value="${esc(e.day)}"></td><td><input data-f="date" dir="ltr" value="${esc(displayDate(e.date))}"></td><td><span class="fixedPeriod" title="الفترة ثابتة">${esc(e.period)}</span></td><td class="scheduleTime"><bdi>${esc(periodTime(e))}</bdi></td><td>${esc(e.course)}</td><td><input data-f="section" value="${esc(e.section)}" readonly title="رقم الشعبة للعرض فقط"></td><td>${esc(e.dept)}</td><td>${esc(e.courseTrainer)}</td><td><div class="assignmentControl"><select data-f="room" class="${roomConflicts.has(e.id)?"roomConflict":""}">${scheduleSelectedOption(e.room,"بدون قاعة")}</select>${pinCheckbox(e,"room")}</div></td><td><div class="assignmentControl"><select data-f="inv1" class="${conflicts.has(`${e.id}|${norm(e.inv1)}`)?"monitorConflict":""}">${scheduleSelectedOption(e.inv1,"— اختر —")}</select></div></td><td><div class="assignmentControl"><select data-f="inv2" class="${conflicts.has(`${e.id}|${norm(e.inv2)}`)?"monitorConflict":""}">${scheduleSelectedOption(e.inv2,"— اختر —")}${pinCheckbox(e,"monitors")}</div></td><td>${(!e.inv1||!e.inv2)?`<button type="button" data-replace class="replaceMonitor">إيجاد بديل</button>`:""}<div class="autoNotes ${scheduleNotes(e)==="مكتمل"?"note-ok":"note-alert"}" data-status-check title="انقر لإعادة فحص حالة التوزيع" role="button" tabindex="0" aria-live="polite">${scheduleNotes(e)==="مكتمل"?"مكتمل":"غير مكتمل"}</div></td></tr>`).join("");
  for(const tr of $$("tr[data-id]",$("#scheduleTable"))){const e=state.exams.find(x=>x.id===tr.dataset.id);for(const x of $$('[data-f]',tr)){
    if(x.dataset.f==="section") { x.readOnly=true; continue; }
    
    
    if(x.dataset.f==="date")x.onchange=()=>{const v=x.value.trim(),parsed=v?hijriDate(v):"";if(v&&!parsed){notifyError("أدخل التاريخ الهجري مثل ١٤٤٨/٠٨/٢٢");x.value=displayDate(e.date);return;}e.date=parsed;refreshAfterAvailabilityChange();renderSchedule();};
    else if(["day","period"].includes(x.dataset.f))x.onchange=()=>{e[x.dataset.f]=x.dataset.f==="period"?num(x.value,1):x.value;refreshAfterAvailabilityChange();renderSchedule();};
    else if(assignmentFields.includes(x.dataset.f)){
      x.disabled=isLocked(e,x.dataset.f);
      x.onchange=()=>{
        const context=manualMonitorContext(), field=x.dataset.f;
        const person=context.ownership.byName.get(norm(x.value));
        if(x.value&&(!person||monitorAssignmentConflict(person,e,field,context.exams))){
          notifyError(person?"للمراقب تكليف آخر في الفترة نفسها.":"المراقب غير معروف.");
          x.value=e[field]||"";
          return;
        }
        const warnings=person?monitorAssignmentWarnings(person,e,field,context):[];
        e[field]=x.value;
        if(person)(e.manualMonitors??={})[field]=x.value;
        else if(e.manualMonitors)delete e.manualMonitors[field];
        saveSoon();renderSchedule();renderReports();runAudit();
        if(warnings.length)notify(`تم حفظ الإسناد اليدوي. ${warnings.join("، ")}.`,"warning");
      };
    }
    else if(x.dataset.f==="room"){x.disabled=isLocked(e,"room");x.onchange=()=>{e.room=x.value;saveSoon();renderSchedule();renderReports();runAudit();};}
    else bindEditable(x,e,x.dataset.f,v=>v);
  }for(const btn of tr.querySelectorAll("[data-pin]")){btn.onchange=()=>{const field=btn.dataset.pin;if(field==="monitors")setMonitorPairLocked(e,btn.checked);else setLocked(e,field,btn.checked);saveSoon();renderSchedule();};}
  const status=$("[data-status-check]",tr);if(status){status.onclick=()=>{runAudit();renderSchedule();};status.onkeydown=ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();status.click();}};}
  const replace=$("[data-replace]",tr);if(replace)replace.onclick=()=>{if(!findReplacement(e))notifyError("لا يوجد مراقب بديل مستوفٍ للشروط حاليًا");};}
  fitScheduleSelections(new Map(list.map(exam=>[exam.id,exam])));
}
function scheduleSelectedOption(value,empty){return `<option value="${esc(value||"")}" selected>${esc(value||empty)}</option>`;}
function fitScheduleSelections(exams){
  for(const select of $$("#scheduleTable select[data-f]")){
    if(select.dataset.f==="period")continue;
    const loadOptions=()=>{
      if(select.disabled||select.dataset.loaded)return;
      const value=select.value, field=select.dataset.f;
      const exam=exams.get(select.closest("tr").dataset.id);
      select.innerHTML=field==="room"?roomOptions(value):scheduleMonitorOptions(exam,field);
      select.value=value;
      select.dataset.loaded="true";
      update();
    };
    select.addEventListener("pointerdown",loadOptions);select.addEventListener("focus",loadOptions);
    const wrapper=document.createElement("div");wrapper.className="wrappedSelect";if(select.classList.contains("monitorConflict")){wrapper.classList.add("monitorConflictWrap");wrapper.title="تعارض مراقب في الفترة نفسها";}if(select.classList.contains("roomConflict")){wrapper.classList.add("roomConflictWrap");wrapper.title="تعارض قاعة في التاريخ والفترة نفسيهما";}
    const label=document.createElement("span");label.className="selectionLabel";label.setAttribute("aria-hidden","true");
    select.parentNode.insertBefore(wrapper,select);wrapper.append(label,select);
    const update=()=>{label.textContent=select.selectedOptions[0]?.textContent||"اختر";select.setAttribute("aria-label",`${select.dataset.f==="room"?"القاعة":select.dataset.f==="inv1"?"المراقب الأول":"المراقب الثاني"}: ${label.textContent}`);};
    update();select.addEventListener("change",update);
  }
}
function countAssignments(){const c={};for(const e of eligibleExams())for(const n of [e.inv1,e.inv2])if(n)c[n]=(c[n]||0)+1;return c;}
function examTitle(exam){
  return String(exam.course||"").trim() || eligibleSections().get(norm(exam.section))?.course || exam.courseCode || "—";
}
function monitoringReportHtml(){
  const rows=eligibleExams().slice().sort((a,b)=>dayKey(a).localeCompare(dayKey(b),"ar",{numeric:true})||Number(a.period)-Number(b.period)||String(a.room||"").localeCompare(String(b.room||""),"ar",{numeric:true}));
  if(!rows.length)return '<div class="card">لا توجد اختبارات لعرض جدول المراقبة.</div>';
  return `<section class="monitoringSheet"><h2>جدول المراقبة</h2><p class="monitoringCount">عدد الاختبارات: ${arabicDigits(rows.length)}</p><table><colgroup><col style="width:8%"><col style="width:10%"><col style="width:9%"><col style="width:20%"><col style="width:12%"><col style="width:14%"><col style="width:14%"><col style="width:13%"></colgroup><thead><tr><th>اليوم</th><th>التاريخ</th><th>الفترة</th><th>اسم الاختبار</th><th>القاعة</th><th>المراقب الأول</th><th>المراقب الثاني</th><th>ملاحظات</th></tr></thead><tbody>${rows.map(e=>{
    const period=state.periods.find(p=>Number(p.id)===Number(e.period))?.name||`الفترة ${arabicDigits(e.period)}`;
    const notes=[scheduleNotes(e),stripDistributionNote(e.notes)].filter(v=>v&&v!=="مكتمل").join("؛ ")||"—";
    return `<tr><td>${esc(e.day||"—")}</td><td class="dateValue"><bdi>${esc(displayDate(e.date)||"—")}</bdi></td><td>${esc(period)}</td><td>${esc(examTitle(e))}</td><td>${esc(validRoomLabel(e.room)||"غير محددة")}</td><td>${esc(e.inv1||"غير معيّن")}</td><td>${esc(e.inv2||"غير معيّن")}</td><td>${esc(notes)}</td></tr>`;
  }).join("")}</tbody></table></section>`;
}

function availabilityReportDays(){
  const map=new Map();for(const e of eligibleExams())if(e.date){const k=dayKey(e);if(!map.has(k))map.set(k,{...e});}
  return [...map.values()].sort((a,b)=>(calendarTime(a.date)??Infinity)-(calendarTime(b.date)??Infinity)||dayKey(a).localeCompare(dayKey(b)));
}
function reportMonitoringTrainers(){
  return [...state.trainers, ...leaders().filter(l=>l.role===COMMITTEE_ROLE)
    .map(l=>({...l.trainer,max:l.max}))].filter(activeTrainer);
}
function availabilityReportHtml(kind){
  const days=availabilityReportDays(),exams=eligibleExams();
  if(!days.length)return '<p>لا توجد أيام اختبارات مجدولة.</p>';
  const isRoom=kind==='rooms';
  const subjects=isRoom?state.rooms.filter(r=>r.enabled!==false&&roomCode(r)).sort((a,b)=>roomCode(a).localeCompare(roomCode(b),'ar',{numeric:true})):reportMonitoringTrainers().sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  const counts=countAssignments();
  const ownership=isRoom?null:courseOwnership(exams,distributionPeople(false));
  const prefix=isRoom?"availableRoom":"availableTrainer";
  const selectedDay=$("#"+prefix+"Day")?.value||"";
  const selectedPeriod=Number($("#"+prefix+"Period")?.value||0);
  const selectedName=$("#"+prefix+"Name")?.value||"";
  if(selectedName&&!selectedDay&&!selectedPeriod){
    const subject=subjects.find(x=>(isRoom?roomCode(x):x.name)===selectedName);
    if(subject){
      const matrix=days.map(d=>{
        const periods=[1,2,3].filter(p=>exams.some(e=>dayKey(e)===dayKey(d)&&Number(e.period)===p));
        const cells=[1,2,3].map(p=>{
          if(!periods.includes(p))return '<td><span class="redDash" aria-label="غير متاح"></span></td>';
          const sample={...d,period:p},slot=slotKey(sample);let free=false;
          if(isRoom){const code=roomCode(subject);free=!exams.some(e=>slotKey(e)===slot&&roomCode(roomRecord(e.room))===code);}
          else{const name=subject.name;free=!committeeDepartmentConflict(ownership.byName.get(norm(name)),ownership.slots.get(slot))&&trainerAvailable(subject,sample)&&!exams.some(e=>slotKey(e)===slot&&(norm(e.inv1)===norm(name)||norm(e.inv2)===norm(name)))&&(!courseTrainerConflict(name,sample,ownership)||monitoringOwnExamAllowed(subject))&&num(counts[name],0)<num(subject.max,999)&&!wouldMakeThree(name,sample);}
          return free?'<td class="freeCell">متاح</td>':'<td><span class="redDash" aria-label="غير متاح"></span></td>';
        }).join('');
        return `<tr><td>${esc(d.day)}</td><td><bdi>${esc(displayDate(d.date))}</bdi></td>${cells}</tr>`;
      }).join('');
      return `<section class="freeReportDay freeReportMatrix"><h2>${isRoom?'تقرير القاعات المتاحة':'تقرير المدربين المتاحين للمراقبة'}</h2><p class="freeReportCollege">المؤسسة العامة للتدريب التقني والمهني — الكلية التقنية التطبيقية بالرياض</p><h3>${esc(selectedName)}</h3><table><thead><tr><th>اليوم</th><th>التاريخ</th><th>الفترة الأولى</th><th>الفترة الثانية</th><th>الفترة الثالثة</th></tr></thead><tbody>${matrix}</tbody></table></section>`;
    }
  }
  return days.filter(d=>!selectedDay||dayKey(d)===selectedDay).map(d=>{
    const periods=[1,2,3].filter(p=>exams.some(e=>dayKey(e)===dayKey(d)&&Number(e.period)===p));
    if(!periods.length)return '';
    const rows=subjects.filter(subject=>!selectedName||(isRoom?roomCode(subject):subject.name)===selectedName).map(subject=>{
      const cells=[1,2,3].map(p=>{
        if(!periods.includes(p)||selectedPeriod&&selectedPeriod!==p)return '<td>—</td>';
        const sample={...d,period:p};const slot=slotKey(sample);
        let free=false;
        if(isRoom){const code=roomCode(subject);free=!exams.some(e=>slotKey(e)===slot&&roomCode(roomRecord(e.room))===code);}
        else{const name=subject.name;free=!committeeDepartmentConflict(ownership.byName.get(norm(name)),ownership.slots.get(slot))&&trainerAvailable(subject,sample)&&!exams.some(e=>slotKey(e)===slot&&(norm(e.inv1)===norm(name)||norm(e.inv2)===norm(name)))&&(!courseTrainerConflict(name,sample,ownership)||monitoringOwnExamAllowed(subject))&&num(counts[name],0)<num(subject.max,999)&&!wouldMakeThree(name,sample);}
        return free?'<td class="freeCell">متاح</td>':'<td class="busyCell"><span class="redDash" aria-label="مشغول أو غير متاح"></span></td>';
      }).join('');
      return `<tr><td>${esc(isRoom?roomCode(subject):subject.name)}</td>${cells}</tr>`;
    }).join('');
    return `<section class="freeReportDay"><h2>${isRoom?'تقرير القاعات المتاحة':'تقرير المدربين المتاحين للمراقبة'}</h2><p class="freeReportCollege">المؤسسة العامة للتدريب التقني والمهني — الكلية التقنية التطبيقية بالرياض</p><h3>${esc(d.day)} — ${esc(displayDate(d.date))}</h3><table><thead><tr><th>${isRoom?'رقم القاعة':'اسم المدرب'}</th><th>الفترة الأولى</th><th>الفترة الثانية</th><th>الفترة الثالثة</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  }).join('');
}
function printAvailabilityReport(kind){
  const win=window.open('','_blank');if(!win)return notifyError('اسمح بالنوافذ المنبثقة للطباعة');
  const css=`@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{direction:rtl;font-family:Tahoma,Arial,sans-serif;color:#19303a}h2,h3{text-align:center;margin:8px 0}h2{color:#006776}.freeReportCollege{text-align:center;font-size:11px}.freeReportDay{break-before:page;page-break-before:always}.freeReportDay:first-of-type{break-before:auto;page-break-before:auto}table{border-collapse:collapse;width:100%;table-layout:fixed;font-size:12px}thead{display:table-header-group}th,td{border:1px solid #9cb4ba;padding:7px;text-align:center}th{background:#e4f0ef}td:first-child{font-weight:700;text-align:right}.freeCell{color:#08783e;font-weight:800}.redDash{display:inline-block;width:23px;height:3px;background:#c92d38;border-radius:3px;vertical-align:middle}tr{break-inside:avoid}.noPrint{padding:8px}@media print{.noPrint{display:none}}`;
  win.document.open();win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير ${kind==='rooms'?'القاعات':'المدربين'} المتاحين</title><style>${css}</style></head><body><div class="noPrint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>${availabilityReportHtml(kind)}</body></html>`);win.document.close();win.focus();win.addEventListener('load',()=>setTimeout(()=>win.print(),350),{once:true});
}

function showAvailabilityPreview(kind, show) {
  const preview = $(kind === "rooms" ? "#availableRoomsPreview" : "#availableTrainersPreview");
  preview.hidden = !show;
  if (show) preview.innerHTML = availabilityReportHtml(kind);
  else preview.replaceChildren();
}

function setupAvailabilityFilters(kind){
 const isRoom=kind==="rooms",prefix=isRoom?"availableRoom":"availableTrainer",days=availabilityReportDays();
 const subjects=isRoom?state.rooms.filter(r=>r.enabled!==false&&roomCode(r)).map(roomCode):reportMonitoringTrainers().map(t=>t.name);
 const entries=[['Day',days.map(d=>[dayKey(d),`${d.day} — ${displayDate(d.date)}`]),'جميع الأيام'],['Period',state.periods.map(p=>[String(p.id),p.name]),'جميع الفترات'],['Name',subjects.map(n=>[n,n]),isRoom?'جميع القاعات':'جميع المدربين']];
 for(const [suffix,values,allLabel] of entries){const el=$("#"+prefix+suffix);if(!el)continue;const previous=el.value;el.innerHTML=`<option value="">${allLabel}</option>`+values.map(([v,label])=>`<option value="${esc(v)}">${esc(label)}</option>`).join('');if(values.some(([v])=>v===previous))el.value=previous;el.onchange=()=>showAvailabilityPreview(kind,false);}
}
function renderReports(){
 const panel=document.querySelector('#page-reports .subpanel.active');
 if(!panel)return;
 const id=panel.id;
 if(id==='report-available-trainers'||id==='report-available-rooms'){
   const kind=id==='report-available-rooms'?'rooms':'trainers';
   setupAvailabilityFilters(kind);
   showAvailabilityPreview(kind,false);
   return;
 }
 if(id==='report-monitoring'){$('#monitoringReportPreview').innerHTML=monitoringReportHtml();return;}
 if(id==='report-trainers'){
   const sel=$('#reportTrainer'),old=sel.value;sel.innerHTML=trainerOptions(old);
   if(!sel.value){const counts=countAssignments(),first=allMonitoringTrainers().find(t=>activeTrainer(t)&&counts[t.name]);if(first)sel.value=first.name;}
   renderReportPreview(sel.value?[sel.value]:[]);return;
 }
 if(id==='report-summary'){
   const c=countAssignments(), byLoad=(a,b)=>(c[b.name]||0)-(c[a.name]||0)||a.name.localeCompare(b.name,"ar");
   const active=state.trainers.filter(activeTrainer).sort(byLoad);
   const total=active.reduce((n,t)=>n+(c[t.name]||0),0), average=active.length?total/active.length:0;
   $("#trainerAverage").textContent=active.length?`متوسط المراقبات للمدربين النشطين: ${average.toFixed(2)} (${total} مراقبة ÷ ${active.length} مدربًا)`:"لا يوجد مدربون نشطون";
   const list=(title,items)=>items.length?`<section class="countGroup">
     <h4 class="countGroupTitle">${title}</h4>
     <table aria-label="${title}">
       <thead><tr><th scope="col">اسم المدرب</th><th scope="col">عدد المراقبات</th></tr></thead>
       <tbody>${items.map(t=>`<tr><th scope="row">${esc(t.name)}</th><td>${c[t.name]||0}</td></tr>`).join("")}</tbody>
     </table></section>`:"";
   $("#trainerCounts").innerHTML=list("المدربون",active)+list("القيادات الإشرافية",leaders().filter(l=>l.role!==COMMITTEE_ROLE).map(leadershipTrainer).sort(byLoad))+list("أعضاء لجان الاختبار",leaders().filter(l=>l.role===COMMITTEE_ROLE).map(leadershipTrainer).sort(byLoad))+list("غير النشطين",state.trainers.filter(t=>!activeTrainer(t)).sort(byLoad));
 }
}
function trainerSheet(name){
  const t=state.trainers.find(x=>x.name===name),rows=eligibleExams().filter(e=>e.inv1===name||e.inv2===name).sort((a,b)=>dayKey(a).localeCompare(dayKey(b))||a.period-b.period);
  if(!rows.length)return"";
  return `<section class="trainerSheet"><h2>جدول مراقبات المدرب</h2><div class="trainerMeta"><span><strong>الاسم:</strong> ${esc(name)}</span></div><table><thead><tr><th>اليوم</th><th>التاريخ</th><th>الفترة</th><th>اسم الاختبار</th><th>القاعة</th></tr></thead><tbody>${rows.map(e=>`<tr><td>${esc(e.day)}</td><td class="dateValue"><bdi>${esc(displayDate(e.date))}</bdi></td><td>${esc(e.period)}</td><td>${esc(examTitle(e))}</td><td>${esc(validRoomLabel(e.room)||"غير محددة")}</td></tr>`).join("")}</tbody></table><p class="trainerReminder">إجمالي المراقبات: ${rows.length} — حضورك قبل بداية الاختبار بـ 15 دقيقة يسهم في تنظيم أعمال اللجنة.</p></section>`;
}
function trainerMatrixSheet(name){
 const rows=eligibleExams().filter(e=>e.inv1===name||e.inv2===name).sort((a,b)=>dayKey(a).localeCompare(dayKey(b))||Number(a.period)-Number(b.period));
 if(!rows.length)return '';
 const periods=state.periods.filter(p=>p.active!==false).sort((a,b)=>Number(a.id)-Number(b.id));
 const days=new Map();
 for(const e of rows){const k=dayKey(e);if(!days.has(k))days.set(k,{day:e.day,date:e.date,slots:new Map()});const slot=days.get(k).slots;const existing=slot.get(String(e.period))||[];const assignment=`<strong>${esc(examTitle(e))}</strong><br>${esc(validRoomLabel(e.room)||'غير محددة')}`;if(!existing.includes(assignment))existing.push(assignment);slot.set(String(e.period),existing);}
 return `<section class="trainerSheet trainerMatrixSheet"><h2>جدول مراقبات المدرب — عرض الفترات</h2><div class="trainerMeta"><span><strong>الاسم:</strong> ${esc(name)}</span><span>${esc(state.meta.announcementTerm||'')}</span></div><table><thead><tr><th>اليوم والتاريخ</th>${periods.map(p=>`<th>${esc(p.name)}</th>`).join('')}</tr></thead><tbody>${[...days.values()].map(d=>`<tr><td>${esc(d.day)} — <bdi>${esc(displayDate(d.date))}</bdi></td>${periods.map(p=>`<td>${(d.slots.get(String(p.id))||[]).map(assignment=>`<div>${assignment}</div>`).join('')||'—'}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="trainerReminder">إجمالي المراقبات: ${rows.length} — الحضور قبل بداية الاختبار بـ 15 دقيقة.</p></section>`;
}
function selectedTrainerPrintMode(){return $('#trainerPrintMode')?.value==='matrix'?'matrix':'traditional';}

function renderReportPreview(names){$("#reportPreview").innerHTML=names.map(n=>selectedTrainerPrintMode()==="matrix"?trainerMatrixSheet(n):trainerSheet(n)).join("");}
function announcementInstructionsHtml(){
  const value=(state.meta.announcementInstructions||"").trim();
  return value?`<div class="examInstructions"><h3>تعليمات الاختبار</h3><div>${esc(value)}</div></div>`:"";
}
function announcementTimeHtml(value){
  const raw=String(value||"غير محدد").trim();
  // Isolate each clock and its suffix; the suffix remains visually to the right.
  const parts=raw.split(/\s*[-–—]\s*/);
  const rendered=parts.map(part=>{
    const match=part.trim().match(/^(.*?)(?:\s*([صم]))\s*$/);
    if(!match)return `<bdi dir="ltr">${esc(part)}</bdi>`;
    return `<span class="clockTime" dir="ltr"><bdi dir="ltr">${esc(match[1].trim())}</bdi><span>${esc(match[2])}</span></span>`;
  });
  return rendered.join(' <span aria-hidden="true">—</span> ');
}
function announcementSheets(onlyDate=""){
  const sections=eligibleSections(),groups=new Map();
  for(const e of eligibleExams()){
    if(onlyDate&&westernDigits(e.date)!==westernDigits(onlyDate))continue;
    const period=Number(e.period);if(!Number.isInteger(period)||period<1)continue;
    const key=`${dayKey(e)}|${e.day||""}`;
    if(!groups.has(key))groups.set(key,{day:e.day||"غير محدد",date:e.date||"",rows:[]});
    groups.get(key).rows.push(e);
  }
  const ordered=[...groups].sort((a,b)=>a[0].localeCompare(b[0],"ar",{numeric:true}));
  return ordered.map(([,group])=>{
    const columns=[1,2,3].map(period=>{
      const p=state.periods.find(x=>Number(x.id)===period);
      const unique=new Set();
      const rows=group.rows.filter(e=>Number(e.period)===period).sort((a,b)=>String(a.course).localeCompare(String(b.course),"ar")||String(a.section).localeCompare(String(b.section),"ar",{numeric:true})).filter(e=>{
        const key=[norm(e.courseCode||sections.get(norm(e.section))?.code||e.course),norm(e.section)].join("|");
        if(unique.has(key))return false;unique.add(key);return true;
      });
      const cells=rows.map(e=>{
        const code=e.courseCode||sections.get(norm(e.section))?.code||"—";
        const room=validRoomLabel(e.room)||"غير محددة";
        return `<tr><td>${esc(code)}</td><td>${esc(e.course||"—")}</td><td><bdi>${esc(e.section||"—")}</bdi></td><td class="${room==='غير محددة'?'missingRoom':''}"><bdi>${esc(room)}</bdi></td><td>${esc(e.courseTrainer||"غير محدد")}</td></tr>`;
      });
      return `<div class="periodPanel period${period}"><div class="periodHeading">${esc(p?.name||`الفترة ${["","الأولى","الثانية","الثالثة"][period]}`)}</div><div class="periodTime">${announcementTimeHtml(p?.time||(rows.length?periodTime(rows[0]):"غير محدد"))}</div><table><thead><tr><th>رمز المقرر</th><th>اسم المقرر</th><th>الشعبة</th><th>القاعة</th><th>اسم المدرب</th></tr></thead><tbody>${cells.join("")||'<tr><td colspan="5" class="emptyPeriod">لا توجد اختبارات</td></tr>'}</tbody></table></div>`;
    }).join("");
    return `<section class="announcementSheet"><div class="announcementMasthead"><div class="announcementBrand"><span>المؤسسة العامة للتدريب التقني والمهني</span><small>الكلية التقنية التطبيقية بالرياض</small></div><div class="announcementTitle"><span class="titleMark">☷</span> جدول الاختبارات النهائية للمتدربين</div></div>${state.meta.announcementTerm?.trim()?`<p class="announcementTerm">الفصل التدريبي: ${esc(state.meta.announcementTerm.trim())}</p>`:""}<div class="announcementDay"><strong>اليوم: ${esc(group.day)}</strong><strong>التاريخ: <bdi>${esc(displayDate(group.date)||"غير محدد")}</bdi></strong></div><div class="periodGrid">${columns}</div>${announcementInstructionsHtml()}</section>`;

  }).join("");
}
function renderAnnouncement(){
  $("#announcementTerm").value=state.meta.announcementTerm||"";
  $("#announcementInstructions").value=state.meta.announcementInstructions||"";
  const daySelect=$("#announcementDate"),old=daySelect.value,dates=new Map();
  for(const e of eligibleExams())if(e.date)dates.set(westernDigits(e.date),`${e.day||"اليوم"} — ${displayDate(e.date)}`);
  daySelect.innerHTML='<option value="">اختر التاريخ</option>'+[...dates].sort((a,b)=>a[0].localeCompare(b[0],"ar",{numeric:true})).map(([date,label])=>`<option value="${esc(date)}">${esc(label)}</option>`).join("");
  daySelect.value=dates.has(old)?old:(daySelect.options[1]?.value||"");
  if($("#page-announcement").classList.contains("active"))previewAnnouncement();
}
const announcementPrintCss=`@page{size:A4 landscape;margin:9mm}*{box-sizing:border-box}html{direction:rtl}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#172e39;margin:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}.announcementSheet{width:279mm;margin-inline:auto;background:#fff;padding:10px 8px;break-before:auto;page-break-before:auto;position:relative;overflow:visible}.announcementSheet+.announcementSheet{break-before:page;page-break-before:always}.announcementSheet:before{content:"";position:absolute;top:0;left:0;width:175px;height:60px;background:linear-gradient(135deg,#008f99 0 34%,#08647a 34% 58%,#d6e9ef 58% 72%,transparent 72%);pointer-events:none}.announcementMasthead{padding-top:5px}.announcementBrand{text-align:right;margin-right:6px;font-weight:800;font-size:16px;color:#111e26;line-height:1.55;min-height:60px}.announcementBrand small{display:block;font-size:13px;color:#245663}.announcementTitle{margin:7px auto 9px;max-width:850px;background:linear-gradient(100deg,#00616e,#00818a,#034f63);border:5px solid #e2f0f3;border-radius:42px;text-align:center;color:white;font-size:18px;font-weight:800;padding:7px 10px;box-shadow:0 3px 0 #c8e2e7}.titleMark{display:inline-block;border:2px solid #d5f1f4;border-radius:8px;padding:0px 8px;margin-left:10px;font-size:25px}.announcementTerm{display:table;text-align:center;margin:0 auto 16px;padding:9px 32px;border-radius:40px;background:#e0eff3;color:#162f38;font-size:17px;font-weight:800}.announcementDay{display:flex;justify-content:center;gap:18px;align-items:center;background:#eaf0f4;border-radius:14px;padding:12px;margin:0 0 18px;font-size:13px;color:#172c35}.announcementDay strong{font-weight:800}.announcementDay bdi,.periodTime bdi{direction:ltr;unicode-bidi:isolate}.periodGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));direction:rtl;gap:9px;align-items:start}.periodPanel{border:2px solid var(--period-border);border-radius:14px;overflow:visible;min-width:0;break-inside:auto;page-break-inside:auto;background:#fff}.period1{--period-border:#078749;--period-light:#dff4e9;--period-deep:#08733e}.period2{--period-border:#ed8a0b;--period-light:#fff0d9;--period-deep:#c96c05}.period3{--period-border:#117fcb;--period-light:#e0f0fc;--period-deep:#0c63a8}.periodHeading{background:linear-gradient(110deg,var(--period-border),var(--period-deep));color:white;text-align:center;font-size:13px;font-weight:800;padding:4px 3px}.periodTime{text-align:center;background:var(--period-light);padding:6px;font-weight:800;font-size:15px;margin:5px;border-radius:8px}.periodPanel table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px;direction:rtl;margin:9px 0 0}.periodPanel th,.periodPanel td{border:1px solid #b9cbd1;padding:5px 2px;text-align:center;vertical-align:middle;overflow-wrap:anywhere;word-break:normal;white-space:normal;line-height:1.65}.periodPanel th{background:var(--period-light);font-weight:800;font-size:10px}.periodPanel th:nth-child(1){width:21%}.periodPanel th:nth-child(2){width:25%}.periodPanel th:nth-child(3){width:14%}.periodPanel th:nth-child(4){width:19%}.periodPanel th:nth-child(5){width:21%}.periodPanel td:nth-child(2),.periodPanel td:nth-child(5){white-space:normal!important;overflow-wrap:anywhere;word-break:normal;line-height:1.7}.periodPanel tbody tr:nth-child(even){background:#f6f9fa}.periodPanel tr{break-inside:avoid;page-break-inside:avoid}.periodPanel bdi{direction:ltr;unicode-bidi:isolate}.clockTime{display:inline-flex;direction:ltr;flex-direction:row;align-items:center;justify-content:center;gap:5px;unicode-bidi:isolate}.emptyPeriod{color:#63727b}.missingRoom{color:#a33a26;font-weight:700}.examInstructions{border:1px solid #d0dfe5;border-radius:13px;padding:12px 16px;background:#f0f4f6;margin-top:24px;break-inside:avoid;page-break-inside:avoid}.examInstructions h3{font-size:15px;color:#075b68;margin:0 0 7px}.examInstructions div{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.85;font-size:12px}.noPrint{padding:12px;background:#e6f3f4;position:sticky;top:0;z-index:10}.noPrint button{padding:10px 20px;border:0;background:#006575;color:#fff;border-radius:8px;font-size:14px;cursor:pointer}.announcementBrand{min-height:42px;font-size:13px}.announcementBrand small{font-size:11px}.announcementTitle{margin-block:5px;font-size:16px;padding:4px 8px}.announcementTerm{padding:4px 18px;margin-bottom:8px;font-size:13px}.announcementDay{padding:6px;margin-bottom:8px}.periodPanel th,.periodPanel td{padding:3px 2px}.examInstructions{margin-top:12px;padding:7px 10px}.announcementSheet{box-shadow:none;border:0;padding:10px 8px;break-inside:avoid;page-break-inside:avoid}.periodGrid{break-inside:avoid;page-break-inside:avoid}.periodPanel{break-inside:avoid;page-break-inside:avoid}.periodPanel table{break-inside:avoid;page-break-inside:avoid}
.announcementSheet{margin-block:0;padding-block:7px}.announcementBrand{min-height:34px;line-height:1.3}.announcementTitle{margin-block:4px;padding-block:2px;border-width:3px}.titleMark{font-size:17px}.announcementTerm{margin-bottom:5px}.announcementDay{padding:4px;margin-bottom:5px}.periodTime{margin:3px;padding:3px}.periodPanel table{margin-top:4px}.periodPanel th,.periodPanel td,.periodPanel td:nth-child(2),.periodPanel td:nth-child(5){line-height:1.3;padding:2px 2px}.periodPanel th:nth-child(1){width:18%}.periodPanel th:nth-child(2){width:31%}.periodPanel th:nth-child(3){width:12%}.periodPanel th:nth-child(4){width:18%}.periodPanel th:nth-child(5){width:21%}
@media print{.noPrint{display:none!important}}`;
function previewAnnouncement(){
  const preview=$("#announcementPreview");
  const date=$("#announcementDate").value;
  preview.innerHTML=(date&&announcementSheets(date))||'<div class="card">لا توجد اختبارات مجدولة.</div>';
  $("#announcementInfo").textContent="تعرض المعاينة اليوم المحدد. تُرتّب الصفحات عند تجهيز الطباعة.";
}
function paginateAnnouncement(doc) {
  const ruler=doc.createElement("div");
  ruler.style.cssText="height:190mm;position:absolute;visibility:hidden";
  doc.body.append(ruler);
  const pageHeight=ruler.getBoundingClientRect().height;
  ruler.remove();
  for(const day of doc.querySelectorAll(".announcementSheet")){
    if(day.getBoundingClientRect().height<=pageHeight)continue;
    const bodies=[...day.querySelectorAll("tbody")];
    const rows=bodies.map(body=>[...body.rows]);
    const heights=rows.map(list=>list.map(row=>row.getBoundingClientRect().height));
    const instructions=day.querySelector(".examInstructions");
    const instructionsHeight=instructions?instructions.getBoundingClientRect().height+12:0;
    const baseHeights=bodies.map((body,i)=>day.getBoundingClientRect().height-
      (day.querySelector(".periodGrid").getBoundingClientRect().height-
       body.closest(".periodPanel").getBoundingClientRect().height)-
      heights[i].reduce((total,height)=>total+height,0)-instructionsHeight);
    const template=day.cloneNode(true);
    template.querySelector(".examInstructions")?.remove();
    for(const body of template.querySelectorAll("tbody"))body.replaceChildren();
    const offset=rows.map(()=>0);
    const pages=doc.createDocumentFragment();
    while(rows.some((list,i)=>offset[i]<list.length)){
      const remainingHeight=Math.max(...heights.map((list,i)=>baseHeights[i]+
        list.slice(offset[i]).reduce((sum,height)=>sum+height,0)));
      const reserveInstructions=remainingHeight<=pageHeight;
      const availableHeight=pageHeight-(reserveInstructions?instructionsHeight:0);
      const page=template.cloneNode(true);
      [...page.querySelectorAll("tbody")].forEach((body,i)=>{
        let height=baseHeights[i];
        while(offset[i]<rows[i].length && (!body.rows.length||height+heights[i][offset[i]]<=availableHeight)){
          height+=heights[i][offset[i]];
          body.append(rows[i][offset[i]++]);
        }
      });
      if(instructions&&!rows.some((list,i)=>offset[i]<list.length)){
        page.append(instructions);
        if(pageHeight<Math.max(...baseHeights)+instructionsHeight){
          page.style.breakInside="auto";
          instructions.style.breakInside="auto";
        }
      }
      pages.append(page);
    }
    day.replaceWith(pages);
  }
}
function printAnnouncement(onlyDate=""){
  const win=window.open("about:blank","_blank");
  if(!win){notifyError("المتصفح يمنع نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم حاول مجددًا.");return;}
  try{
    const sheets=announcementSheets(onlyDate);
    if(!sheets){win.close();notifyError("لا توجد اختبارات مجدولة لهذا الاختيار");return;}
    const doc=win.document;
    doc.open();
    doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>إعلان جدول الاختبارات للمتدربين</title><style>${announcementPrintCss}</style></head><body><div class="noPrint"><button id="print" disabled>طباعة / حفظ PDF</button> <span>لحفظ نسخة قابلة للبحث، اختر «حفظ بتنسيق PDF» في المتصفح، وتأكد من A4 أفقي.</span></div>${sheets}</body></html>`);
    doc.close();
    doc.fonts.ready.then(()=>{
      paginateAnnouncement(doc);
      const button=doc.getElementById("print");
      button.onclick=()=>win.print();
      button.disabled=false;
    }).catch(err=>notifyError("تعذر تجهيز الطباعة: "+err.message));
    win.focus();
  }catch(err){win.close();notifyError("تعذر تجهيز الطباعة: "+err.message);}
}

function auditStatus(rows=activeAuditRows()){const working=eligibleExams(),ready=!!state.ss01.length&&working.length>0&&eligibleSections().size>0&&working.every(e=>e.section&&validRoomLabel(e.room)&&e.inv1&&e.inv2);return rows.some(r=>r[0]==="خطأ")?"يحتاج معالجة":!ready||rows.some(r=>r[0]==="تحذير")?"غير مكتمل":Object.keys(state.auditExceptions||{}).length?"سليم مع استثناءات":"سليم";}
function renderAudit(){
  const active=activeAuditRows(),errors=active.filter(r=>r[0]==="خطأ").length,warnings=active.filter(r=>r[0]==="تحذير").length,exceptions=Object.keys(state.auditExceptions||{}).length;
  $("#auditSummary").innerHTML=[["أخطاء",errors],["تحذيرات",warnings],["استثناءات",exceptions],["حالة الجدول",auditStatus()]].map(([l,v])=>`<div class="metric"><strong class="${l==="أخطاء"&&v?"audit-error":l==="تحذيرات"&&v?"audit-warning":l==="حالة الجدول"?(v==="يحتاج معالجة"?"audit-error":v==="غير مكتمل"?"audit-warning":"audit-ok"):""}">${esc(v)}</strong><span>${l}</span></div>`).join("");
  const category=$("#auditCategory").value,level=$("#auditLevel").value,showExceptions=$("#showAuditExceptions").checked;
  const visible=auditRows.map((row,i)=>({row,i,excepted:!!state.auditExceptions?.[auditKey(row)]})).filter(x=>(!category||x.row[3]===category)&&(!level||x.row[0]===level)&&(showExceptions||!x.excepted));
  $("#auditTable tbody").innerHTML=visible.length?visible.map(({row:r,i,excepted})=>`<tr class="${excepted?"exceptedRow":""}"><td class="audit-${r[0]==="خطأ"?"error":r[0]==="تحذير"?"warning":"ok"}">${esc(excepted?"مستثنى":r[0])}</td><td>${esc(r[1])}</td><td>${esc(r[2])}</td><td>${canExceptAuditRow(r)?`<button type="button" data-audit-index="${i}">${excepted?"إلغاء الاستثناء":r[0]==="تحذير"?"استثناء التحذير":"استثناء الخطأ"}</button>`:"انقل أحد التكليفات"}</td></tr>`).join(""):'<tr><td colspan="4">لا توجد نتائج في هذا التصنيف</td></tr>';
  for(const button of $$("#auditTable [data-audit-index]"))button.onclick=()=>{
    const row=auditRows[Number(button.dataset.auditIndex)],key=auditKey(row);
    state.auditExceptions??={};
    if(state.auditExceptions[key])delete state.auditExceptions[key];else state.auditExceptions[key]=true;
    saveSoon();renderAudit();
  };
}
function renderAll(){renderDistributionStatus("","");renderMetrics();renderLeadership();renderTrainers();renderRooms();renderAvailability();renderPeriods();renderBuilder();renderSchedule();renderReports();renderAnnouncement();renderAudit();}

function openSimpleForm(title,fields,onSave){const d=$("#editDialog"),box=$("#dialogFields");$("#dialogTitle").textContent=title;box.innerHTML=fields.map(f=>`<label class="field"><span>${esc(f.label)}</span>${f.type==="department"?`<select name="${esc(f.name)}" required><option value="">اختر القسم</option>${departmentOptions("")}</select>`:`<input name="${esc(f.name)}" type="${f.type||"text"}" value="${esc(f.value||"")}">`}</label>`).join("");d.returnValue="";d.showModal();$("#dialogSave").onclick=e=>{e.preventDefault();const data=Object.fromEntries(new FormData($("form",d)));onSave(data);d.close();};}
function download(name,content,type="application/json"){const a=document.createElement("a");a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
function backupFileName(now=new Date()){
  const header=findHeader(state.ss01Headers||[],[/الفصل التدريبي/,/الفصل/]);
  if(!header||!state.ss01?.length)throw new Error("استورد SS01 الذي يحتوي رمز الفصل قبل تصدير نسخة العمل.");
  const terms=(state.ss01||[]).map(row=>westernDigits(row[header]||"").trim());
  const unique=[...new Set(terms)];
  if(unique.length!==1||!/^\d{3,4}(10|20)$/.test(unique[0]))throw new Error("رمز الفصل في SS01 مفقود أو مختلف بين السجلات. راجع الملف قبل التصدير.");
  const stamp=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}_${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
  return `${unique[0]}_${stamp}.json`;
}
function csvCell(value){return `"${String(value??"").replace(/"/g,'""')}"`;}
function portalCsv(){
  const rows=[["الرقم الوظيفي","اسم المدرب","القسم","اليوم","التاريخ","الفترة","الوقت","المقرر","الشعبة","القاعة"]];
  for(const e of eligibleExams())for(const name of new Set([e.inv1,e.inv2].filter(Boolean))){const t=findMonitoringTrainer(name);if(!t?.id||!activeTrainer(t))continue;
    rows.push([t.id,name,t.dept,e.day,displayDate(e.date),e.period,periodTime(e),e.course,e.section,validRoomLabel(e.room)||"غير محددة"]);
  }
  return "\uFEFF"+rows.map(row=>row.map(csvCell).join(",")).join("\r\n");
}
function printSheets(names){
  const sheets=names.map(n=>selectedTrainerPrintMode()==="matrix"?trainerMatrixSheet(n):trainerSheet(n)).filter(Boolean);if(!sheets.length){notifyError("لا توجد جداول للمراقبين المحددين");return;}
  const win=window.open("","_blank");if(!win){notifyError("اسمح بالنوافذ المنبثقة لهذا الملف ثم أعد المحاولة");return;}
  const css=`@page{size:A4 landscape;margin:12mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#172033;margin:0}.trainerSheet{break-after:page;page-break-after:always}.trainerSheet:last-child{break-after:auto;page-break-after:auto}h2{text-align:center;color:#103e40;margin:0 0 12px}.trainerMeta{display:flex;justify-content:space-between;gap:12px;padding:10px;border:1px solid #ccd6e2;margin-bottom:12px}table{width:100%;table-layout:fixed;border-collapse:collapse;font-size:11px}th,td{border:1px solid #9aabc0;padding:7px;text-align:right;overflow-wrap:anywhere;vertical-align:top}th{background:#e4f0eb}tr{break-inside:avoid}.trainerReminder{text-align:center;font-weight:700;font-size:13px;margin:14px 0 0;color:#103e40}.dateValue,.timeValue{direction:ltr;text-align:center;white-space:nowrap}.noPrint{margin:10px}@media print{.noPrint{display:none}}`;
  win.document.open();win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>جداول المراقبات</title><style>${css}</style></head><body><div class="noPrint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>${sheets.join("")}</body></html>`);win.document.close();win.focus();
  win.addEventListener("load",()=>setTimeout(()=>win.print(),350),{once:true});
}
function printMonitoringReport(){
  if(!eligibleExams().length)return notifyError("لا توجد اختبارات لطباعة جدول المراقبة");
  const win=window.open("","_blank");if(!win)return notifyError("اسمح بالنوافذ المنبثقة لهذا الملف ثم أعد المحاولة");
  const css=`@page{size:A4 landscape;margin:11mm}*{box-sizing:border-box}body{font-family:Tahoma,Arial,sans-serif;direction:rtl;color:#172033;margin:0}.monitoringSheet h2{text-align:center;color:#103e40;margin:0 0 5px}.monitoringCount{text-align:center;margin:0 0 12px;color:#52657b}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10px}thead{display:table-header-group}th,td{border:1px solid #aabaca;padding:6px;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#e4f0eb}tr{break-inside:avoid;page-break-inside:avoid}.dateValue{direction:ltr;text-align:center;white-space:nowrap}.announcementSheet th{white-space:nowrap}.announcementSheet td:nth-child(2),.announcementSheet td:nth-child(4),.announcementSheet td:nth-child(6),.announcementSheet td:nth-child(7){white-space:nowrap}.announcementSheet tfoot{display:table-footer-group}.announcementSheet .instructionsCell{border:0;padding:12px 0 0;background:#fff;white-space:normal}.examInstructions{border:1px solid #b9d7d1;border-right:4px solid #159e91;border-radius:9px;padding:10px 14px;background:#f3faf8;break-inside:avoid;page-break-inside:avoid}.examInstructions h3{font-size:13px;color:#103f43;margin:0 0 5px}.examInstructions div{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;font-size:11px}.noPrint{padding:10px}@media print{.noPrint{display:none}}`;
  win.document.open();win.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>جدول المراقبة</title><style>${css}</style></head><body><div class="noPrint"><button onclick="window.print()">طباعة / حفظ PDF</button></div>${monitoringReportHtml()}</body></html>`);win.document.close();win.focus();
  win.addEventListener("load",()=>setTimeout(()=>win.print(),350),{once:true});
}

function bindUi(){
 $("#addLeadershipBtn").onclick=()=>{$("#leadershipForm").hidden=!$("#leadershipForm").hidden;};
 $("#leadershipManualToggle").onchange=e=>{$("#leadershipManualFields").hidden=!e.target.checked;$("#leadershipTrainer").disabled=e.target.checked;};
 $("#leadershipRole").onchange=e=>{
   const committee=e.target.value===COMMITTEE_ROLE;
   const manual=$("#leadershipManualToggle");
   if(committee)manual.checked=false;
   manual.disabled=committee;
   manual.onchange({target:manual});
 };
 $("#leadershipSaveBtn").onclick=()=>{try{const manual=$("#leadershipManualToggle").checked;const name=manual?$("#leadershipManualName").value:$("#leadershipTrainer").value;addLeadership(name,$("#leadershipRole").value,$("#leadershipLimit").value,manual?$("#leadershipManualId").value:"");$("#leadershipForm").hidden=true;renderAll();toast("تمت الإضافة إلى القيادات ولجان الاختبار");}catch(err){notify(err.message,"error");}};

  $("#tabs").onclick=e=>{const b=e.target.closest("button[data-page]");if(!b)return;$$('#tabs button').forEach(x=>x.classList.toggle("active",x===b));$$('.page').forEach(x=>x.classList.toggle("active",x.id===`page-${b.dataset.page}`));if(b.dataset.page==="trainers"){renderTrainers();fitTrainerTextareas();}if(b.dataset.page==="rooms")renderRooms();if(b.dataset.page==="audit")runAudit();if(b.dataset.page==="announcement")renderAnnouncement();if(b.dataset.page==="reports")renderReports();if(b.dataset.page==="schedule")renderSchedule();};
  for(const group of $$(".subtabs"))group.onclick=e=>{const target=e.target.closest("button[data-subtab]");if(!target)return;for(const b of $$("button[data-subtab]",group)){b.classList.toggle("active",b===target);b.setAttribute("aria-selected",b===target?"true":"false");}for(const panel of group.parentElement.querySelectorAll(":scope > .subpanel"))panel.classList.toggle("active",panel.id===target.dataset.subtab);if(group.closest("#page-reports"))renderReports();};
  $("#ss01File").onchange=async e=>{try{await importSS01(e.target.files[0]);toast("تم استيراد SS01");}catch(err){notify(err.message,"error");}e.target.value="";};
  $("#examFile").onchange=async e=>{const input=e.target,files=[...input.files];input.disabled=true;try{$("#examImportResult").textContent=`جارٍ فحص ${files.length} ملف…`;await importExamSchedules(files);}catch(err){$("#examImportResult").innerHTML=`<span class="audit-error">${esc(err.message)}</span>`;notifyError(err.message);}finally{input.value="";input.disabled=false;}};
  $("#buildWeek").onchange=syncBuilderDate;$("#buildDay").onchange=syncBuilderDate;$("#buildCode").onchange=previewBuilder;
  $("#buildDate").onchange=()=>{const day=state.days.find(d=>d.week===Number($("#buildWeek").value)&&d.date===$("#buildDate").value&&d.active);if(day)$("#buildDay").value=day.day;};
  $("#buildAddBtn").onclick=addBuiltExams;
  $("#buildSelectAll").onchange=e=>$$("#buildTable [data-section]").forEach(x=>x.checked=e.target.checked);
  $("#selectAllDays").onchange=e=>{state.days.forEach(d=>d.active=e.target.checked);saveSoon();renderPeriods();renderBuilder();};
  $("#backupBtn").onclick=()=>{try{const name=backupFileName();state.meta??={};state.meta.lastBackupName=name;download(name,JSON.stringify(state));saveSoon();toast("تم تجهيز النسخة الاحتياطية للتنزيل");}catch(err){notify(err.message,"error");}};
  $("#restoreFile").onchange=async e=>{try{
    const file=e.target.files[0];if(!file)return;
    const obj=JSON.parse(await file.text());
    if(!obj.version||!Array.isArray(obj.exams)||!Array.isArray(obj.trainers)||!Array.isArray(obj.rooms)||!Array.isArray(obj.ss01)||!Array.isArray(obj.days)||!Array.isArray(obj.periods))throw new Error("نسخة غير صالحة أو غير مكتملة");
    const previous=state.meta?.restoredFileName||state.meta?.lastBackupName||"البيانات الحالية المحفوظة في النظام";
    if(!confirm(`سيتم استبدال جميع البيانات الحالية بالنسخة الجديدة.\n\nالنسخة الحالية: ${previous}\nالنسخة الجديدة: ${file.name}\n\nموافق للاستبدال، أو إلغاء للاحتفاظ بالبيانات الحالية.`))return;
    // No automatic download or second confirmation: replacement is committed only after valid JSON and approval.
    const oldState=state;
    try{
      state=obj;state.meta??={};state.meta.restoredFileName=file.name;
      state.availability??={};state.availabilityPinned??={};state.leadership??=[];consolidateTrainers();state.trainers.forEach(t=>{t.originalDept??=t.dept;t.dept=normalizeDepartment(t.dept);});syncRoomCapacities();
      const calendarWarning=syncStoredCalendar();removeInactiveAssignments();
      await dbSet(STATE_KEY,state);renderAll();runAudit();toast(calendarWarning||"تم استيراد نسخة العمل");
    }catch(error){state=oldState;throw error;}
  }catch(err){notify(err.message,"error");}finally{e.target.value="";}};
  $("#resetBtn").onclick=async()=>{if(confirm("هل تريد تهيئة فصل جديد؟ سيتم تنزيل نسخة احتياطية أولًا.")){download(`نسخة_قبل_التهيئة_${Date.now()}.json`,JSON.stringify(state));state=defaultState();await dbSet(STATE_KEY,state);renderAll();runAudit();toast("تمت تهيئة فصل جديد بعد تجهيز النسخة الاحتياطية");}};
  for(const id of ["#scheduleResetMonitorsBtn"])$(id).onclick=()=>{if(confirm("إزالة جميع المراقبين من الصفوف غير المثبتة ثم إعادة توزيعهم لاحقًا؟"))resetMonitors();};
  $("#assignRoomsBtn").onclick=()=>runOptimizedDistribution("rooms");
  $("#clearRoomsBtn").onclick=()=>{if(!confirm("مسح القاعات غير المثبتة فقط؟"))return;resetRoomAssignments();};
  $("#assignMonitorsBtn").onclick=()=>runOptimizedDistribution("monitors");
  $("#scheduleAuditBtn").onclick=()=>{const panel=$("#scheduleAuditPanel");panel.hidden=false;runAudit();toast("اكتمل فحص التوزيع؛ راجع نتائج التحقق");panel.scrollIntoView({behavior:"smooth",block:"start"});};
  $("#runAuditBtn").onclick=()=>{runAudit();toast("اكتمل تحديث نتائج التحقق");};
  $("#auditCategory").onchange=renderAudit;$("#auditLevel").onchange=renderAudit;$("#showAuditExceptions").onchange=renderAudit;
  $("#addTrainerBtn").onclick=()=>openSimpleForm("إضافة مدرب",[{name:"id",label:"الرقم الوظيفي"},{name:"name",label:"الاسم"},{name:"dept",label:"القسم",type:"department"},{name:"max",label:"الحد الأعلى",type:"number",value:"999"}],d=>{if(canonicalTrainerId(d.id)&&allMonitoringTrainers().some(t=>canonicalTrainerId(t.id)===canonicalTrainerId(d.id))){notifyError("الرقم الوظيفي مسجل مسبقًا");return;}if(!APPROVED_DEPARTMENTS.includes(d.dept)){notifyError("اختر قسمًا معتمدًا");return;}state.trainers.push({key:uid("tr"),...d,id:canonicalTrainerId(d.id),max:num(d.max,999),active:true,allowOwnExamMonitoring:false,source:"يدوي"});saveSoon();renderAll();toast("تمت إضافة المدرب بنجاح");});
  $("#addRoomBtn").onclick=()=>openSimpleForm("إضافة قاعة",[{name:"name",label:"اسم القاعة"},{name:"original",label:"الرمز الأصلي"},{name:"capacity",label:"السعة",type:"number",value:"45"}],d=>{state.rooms.push({key:uid("room"),...d,capacity:num(d.capacity,45),capacityManual:true,capacityRevision:2,source:"يدوي"});saveSoon();renderRooms();toast("تمت إضافة القاعة بنجاح");});
  /* Removed add exam from distribution; builder remains the source of exam rows. */
  /* $("#addExamBtn").onclick=()=>openSimpleForm("إضافة اختبار",[{name:"day",label:"اليوم"},{name:"date",label:"التاريخ الهجري أو الميلادي"},{name:"period",label:"الفترة",type:"number",value:"1"},{name:"course",label:"اسم المقرر"},{name:"section",label:"رقم الشعبة"},{name:"dept",label:"القسم"},{name:"courseTrainer",label:"مدرب المقرر"}],d=>{state.exams.push({id:uid("ex"),...d,period:num(d.period,1),time:"",room:"",inv1:"",inv2:"",pinned:false,notes:""});saveSoon();renderAll();}); */
  $("#availabilityTrainer").onchange=renderAvailability;
  $("#resetAvailabilityBtn").onclick=()=>{if(confirm("إزالة جميع حالات التفريغ غير المثبتة؟ سيبقى تفريغ المدربين المثبتين.")){const count=resetAvailability();toast(`أُزيلت ${count} حالة تفريغ غير مثبتة`);}};
  $("#announcementInstructions").oninput=e=>{state.meta.announcementInstructions=e.target.value;saveSoon();$("#announcementPreview").innerHTML="";};
  $("#announcementTerm").oninput=e=>{state.meta.announcementTerm=e.target.value;saveSoon();$("#announcementPreview").innerHTML="";};
  let scheduleSearchTimer;$("#scheduleSearch").oninput=()=>{clearTimeout(scheduleSearchTimer);scheduleSearchTimer=setTimeout(renderSchedule,160);};$("#scheduleDayFilter").onchange=renderSchedule;
  $("#reportTrainer").onchange=()=>renderReportPreview([$("#reportTrainer").value]);
  $("#trainerPrintMode").onchange=()=>renderReportPreview([$("#reportTrainer").value]);
  $("#printTrainerBtn").onclick=()=>{const n=$("#reportTrainer").value;if(!n)return notifyError("اختر مدربًا");renderReportPreview([n]);printSheets([n]);};
  $("#printAllBtn").onclick=()=>{const counts=countAssignments(),names=allMonitoringTrainers().filter(t=>activeTrainer(t)&&counts[t.name]).map(t=>t.name).sort((a,b)=>a.localeCompare(b,"ar"));printSheets(names);};
  $("#printMonitoringReportBtn").onclick=printMonitoringReport;
  $("#previewAvailableTrainersBtn").onclick=()=>showAvailabilityPreview("trainers",true);
  $("#previewAvailableRoomsBtn").onclick=()=>showAvailabilityPreview("rooms",true);
  $("#printAvailableTrainersBtn").onclick=()=>printAvailabilityReport("trainers");
  $("#printAvailableRoomsBtn").onclick=()=>printAvailabilityReport("rooms");
  $("#portalExportBtn").onclick=()=>download("مراقبات_بوابة_المدربين.csv",portalCsv(),"text/csv;charset=utf-8");
  $("#ownExamMonitoringMode").onchange=e=>{
    state.meta.ownExamMonitoringMode=e.target.value;
    const ownership=courseOwnership(eligibleExams(),distributionPeople(false));
    for(const t of allMonitoringTrainers()) clearOwnExamMonitoring(t,ownership);
    saveSoon();renderTrainers();renderSchedule();renderReports();runAudit();toast("تم تحديث سياسة المراقبة أثناء اختبار المقرر");
  };
  $("#trainerSearch").oninput=renderTrainers;
  $("#roomSearch").oninput=renderRooms;

  $("#announcementDate").onchange=previewAnnouncement;
  $("#printAnnouncementBtn").onclick=()=>printAnnouncement();
  $("#printAnnouncementDayBtn").onclick=()=>{const date=$("#announcementDate").value;if(!date)return notifyError("اختر تاريخ اليوم أولًا");printAnnouncement(date);};
}

async function init(){
  try{db=await openDb();state=await dbGet(STATE_KEY)||defaultState();state.availability??={};state.availabilityPinned??={};state.leadership??=[];consolidateTrainers();state.trainers.forEach(t=>{t.originalDept??=t.dept;t.dept=normalizeDepartment(t.dept);});syncRoomCapacities();const calendarWarning=syncStoredCalendar();bindUi();removeInactiveAssignments();await dbSet(STATE_KEY,state);renderAll();runAudit();if(calendarWarning)toast(calendarWarning);}
  catch(err){document.body.innerHTML=`<main><div class="card"><h2>تعذر تشغيل النظام</h2><p>${esc(err.message)}</p><p>استخدم Microsoft Edge أو Google Chrome الحديث.</p></div></main>`;}
}

if (typeof document !== "undefined") init();
if (typeof module !== "undefined" && module.exports) module.exports = {
  addLeadership, removeLeadership, leadershipConflicts, leaders, allMonitoringTrainers, setRoomCapacity, syncRoomCapacities, sectionEnrollments, announcementInstructionsHtml,
  parseCsv, parseXlsx, rowsToObjects, fieldMap, formatRoom, trainingIncluded, periodNo, parseExamMatrix, parseExamSource,
  defaultState, setState: value => { state = value; }, getState: () => state,
  canonicalTrainerId, consolidateTrainers, manualConflictNames, findReplacement, workCounts,
  resetMonitors, removeInactiveAssignments, runAudit, auditStatus, auditKey, activeAuditRows, activeTrainer, trainerAvailable, hijriDate, buildCandidates, eligibleSections, eligibleExams, resetRoomAssignments, portalCsv, periodTime, clearUnavailableAssignments, sectionDepartmentBuildings, trainerSheet, announcementSheets, scheduleNotes, trainingTermLabel, availabilityDetails, resetAvailability, courseTrainerConflict, clearOwnExamMonitoring, monitoringReportHtml, backupFileName, prepareExamSchedules, importedCalendar, calendarTime, hijriFromTime
};
