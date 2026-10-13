// 共用工具、路由與成員頁面。管理頁面在 admin.js。

// ====== 部署前請修改 ======
const CONFIG = {
  LIFF_ID: '2011951985-p393rwDc',
  // 平常走同網域的 /api：由 _worker.js 交給後端 Worker。從台灣連 pages.dev 是台北的機房，比直接連 workers.dev（會繞到美國）快很多
  API_BASE: '/api',
  // 備用：直接連 Worker 的網址 + /api。只有同網域的 /api 沒接到後端時（Pages 專案沒設定好轉接）才會改用
  API_DIRECT: 'https://badminton-line-bot.happybadminton.workers.dev/api',
};
// =========================

const App = {
  state: { clubId: null, idToken: null, me: null, view: 'list', params: {} },
  views: {},   // 名稱 → async () => HTML
  actions: {}, // data-act 名稱 → async (dataset) => void
  forms: {},   // data-form 名稱 → async (FormData, dataset) => void
  changes: {}, // data-change 名稱 → async (input, dataset) => void
  tabs: [],    // 第一層分頁：{ view, label, show: () => boolean }
  subtabs: {}, // 第一層 view → [{ view, label }]
  parentOf: {}, // 細節頁 → 所屬的分頁（例如點名頁屬於場次）
};

const STATUS = { scheduled: '尚未開放', open: '報名中', closed: '已截止', cancelled: '已取消', done: '已結束' };
const WEEKDAYS = '日一二三四五六';
const $ = (id) => document.getElementById(id);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function localParts(iso) {
  const tz = App.state.me?.club.timezone || 'Asia/Taipei';
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
}
function fmt(iso) {
  const p = localParts(iso);
  const wd = WEEKDAYS[new Date(Date.UTC(+p.year, +p.month - 1, +p.day)).getUTCDay()];
  return `${+p.month}/${+p.day}（${wd}）${p.hour}:${p.minute}`;
}
const timeOnly = (iso) => { const p = localParts(iso); return `${p.hour}:${p.minute}`; };
const localDateStr = (iso) => { const p = localParts(iso); return `${p.year}-${p.month}-${p.day}`; };

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

// LINE 的 ID token 大約一小時過期，但 LIFF 不會自己換新：isLoggedIn() 還是 true、重新整理拿到的也是同一個舊 token，
// 後端就一直回「登入已過期」（在電腦瀏覽器開最容易遇到）。過期時要先 liff.logout() 清掉舊的，再重新登入。
const idTokenExpired = () => {
  const exp = liff.getDecodedIDToken()?.exp;
  return !!exp && exp * 1000 < Date.now() + 60_000;
};

/** 清掉過期的登入、重新取得 ID token。回傳 true = 正在轉去重新登入（頁面即將離開）。 */
function relogin() {
  try {
    // 一分鐘內已經重新登入過還是不行，就不再轉，免得卡在無限轉址；記不住時間（瀏覽器擋 sessionStorage）也不轉
    if (Date.now() - Number(sessionStorage.getItem('bmt.relogin') || 0) < 60_000) return false;
    sessionStorage.setItem('bmt.relogin', String(Date.now()));
  } catch {
    return false;
  }
  const club = App.state.clubId || new URLSearchParams(location.search).get('club');
  liff.logout();
  if (liff.isInClient()) {
    // LINE 裡面：重新開一次 LIFF 網址，LINE 會給新的 token
    location.replace(`https://liff.line.me/${CONFIG.LIFF_ID}${club ? `?club=${encodeURIComponent(club)}` : ''}`);
  } else {
    liff.login({ redirectUri: location.href });
  }
  return true;
}

// 後端的回應一律是 JSON；不是 JSON 就表示這個請求根本沒送到後端（例如 Pages 把 /api 當成一般頁面回了 HTML）
const fromBackend = (res) => (res.headers.get('content-type') || '').includes('application/json');

async function api(path, body) {
  const send = () => fetch(`${CONFIG.API_BASE}/clubs/${encodeURIComponent(App.state.clubId)}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${App.state.idToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let res = await send();
  if (!fromBackend(res) && CONFIG.API_DIRECT && CONFIG.API_BASE !== CONFIG.API_DIRECT) {
    // 同網域的 /api 沒接到後端：後端沒處理過這個請求，重送不會重複。這次開啟期間都改成直接連 Worker（比較慢，但能用）
    console.warn('同網域的 /api 沒有接到後端，改為直接連 Worker', res.status);
    CONFIG.API_BASE = CONFIG.API_DIRECT;
    res = await send();
  }
  // 用到一半 token 過期：重新登入後會回到這一頁，這次呼叫就不用再往下處理
  if (res.status === 401 && relogin()) return new Promise(() => {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || '發生錯誤，請稍後再試');
  return data;
}

/** 男女臨打費不同時，臨打報名才需要多選一次價錢。 */
function feeByGender() {
  const c = App.state.me?.club;
  return !!c && c.casualFeeFemale != null && c.casualFeeFemale !== c.casualFee;
}

/** 臨打費的選單（男、女各自的價錢）。選的結果只記在這一筆報名上。 */
function feeSelect(required, value) {
  const c = App.state.me.club;
  const opt = (v, label) => `<option value="${v}" ${value === v ? 'selected' : ''}>${label}</option>`;
  return `<select name="gender" ${required ? 'required' : ''}>
    <option value="">${required ? '請選擇' : '不指定'}</option>
    ${opt('M', `男 $${c.casualFee}`)}
    ${opt('F', `女 $${c.casualFeeFemale}`)}</select>`;
}

// 台灣球友常用的 18 級羽球分級表：[階級, 起, 迄, [[級數, 說明], ...]]
const LEVEL_TIERS = [
  ['新手階', 1, 3, [
    ['1', '剛接觸羽球，知道比賽規則與基本禮儀'],
    ['2', '中場的中高球可以來回 10 拍，發球成功率過半'],
    ['3', '定點擊球有一半能打到後 2/3 場，發球成功率九成以上'],
  ]],
  ['初階', 4, 5, [
    ['4', '握拍正確；定點長球男生能到後場、女生能到中後場；會基本平推，正反拍轉換還不順'],
    ['5', '握拍正確、略懂基本腳步；不被壓迫時，基本球路有一定水準'],
  ]],
  ['初中階', 6, 7, [
    ['6', '略懂腳步與基本輪轉（還不熟練）；開始會殺球、切球'],
    ['7', '殺球、切球或長球的成功率與穩定性有七成以上；有基本防守，但沒有變化'],
  ]],
  ['中階', 8, 9, [
    ['8', '有基本戰術與打點，熟悉輪轉；切、殺、長、吊都有七成以上準確度'],
    ['9', '切、殺、長、吊有三種達九成以上的準確度與品質；發力已有強度'],
  ]],
  ['中進階', 10, 12, [
    ['10', '輪轉熟練且能靈活運用；戰術與打點能有效得分'],
    ['11', '切、殺、長、吊都準確，力量、速度、策略兼具；反拍各種球路都能輕鬆完成'],
    ['12', '移位快、步法靈敏；殺、切、吊都有高強度的攻擊性'],
  ]],
  ['高階', 13, 15, [['13–15', '各種球路穩定熟練、防守沒有死角；球速快、品質高，戰術組織與爆發力都屬上等']]],
  ['職業級', 16, 18, [['16–18', '球路、戰術、步法爐火純青，並有個人的球路風格']]],
];

/** 程度的選單（1–18 級，可不填）。 */
function levelSelect(value) {
  const options = LEVEL_TIERS.flatMap(([tier, from, to]) =>
    Array.from({ length: to - from + 1 }, (_, i) => `<option value="${from + i}" ${Number(value) === from + i ? 'selected' : ''}>${from + i} 級・${tier}</option>`));
  return `<select name="level"><option value="">不填</option>${options.join('')}</select>`;
}

/** 分級表的說明，收在可展開的區塊裡。 */
function levelGuide() {
  return `<details class="fold">
    <summary>程度怎麼選？看羽球分級表</summary>
    <table class="levels">${LEVEL_TIERS.map(([tier, from, to, rows]) => `
      <tr class="tier"><th colspan="2">${tier}　${from}–${to} 級</th></tr>
      ${rows.map(([n, text]) => `<tr><th>${n}</th><td>${text}</td></tr>`).join('')}`).join('')}
    </table>
    <div class="hint">台灣球友常用的 18 級分級表，僅供參考。不確定就選接近的，或留空。</div>
  </details>`;
}

/** 臨打報名要填的欄位：臨打費（男女不同價時才有，必選）、程度（可不填）。last = 要先帶入的值。 */
function signupFields(last = {}) {
  const fee = feeByGender();
  return `
    ${fee ? `<label>臨打費${feeSelect(true, last.gender)}</label>` : ''}
    <label${fee ? '' : ' class="full"'}>程度（可不填）${levelSelect(last.level)}</label>
    <div class="full">${levelGuide()}</div>`;
}
const signupValues = (fd) => ({ gender: fd.get('gender') || null, level: fd.get('level') ? Number(fd.get('level')) : null });

// 上次自己報名時選的臨打費與程度，只記在這支手機上，下次先帶入
const lastJoin = {
  get() { try { return JSON.parse(localStorage.getItem('bmt.join')) || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem('bmt.join', JSON.stringify(v)); } catch { /* 存不了就每次重選 */ } },
};

// 球團規則收合後記在這支手機上；規則內容有改，下次會再展開
const rulesFold = {
  key: () => `bmt.rules.${App.state.clubId}`,
  folded(rules) { try { return localStorage.getItem(rulesFold.key()) === rules; } catch { return false; } },
  set(rules, folded) {
    try { folded ? localStorage.setItem(rulesFold.key(), rules) : localStorage.removeItem(rulesFold.key()); } catch { /* 存不了就每次都展開 */ }
  },
};

/** 場地名稱 + 第幾場地。 */
const place = (venue, courtNo) => [venue, courtNo].filter(Boolean).map(esc).join(' ');
const dots = (...parts) => parts.filter(Boolean).join(' ・ ');

/** 管理員操作回傳的遞補／退回數量，轉成一句提示。 */
function changesText(r) {
  const parts = [];
  if (r?.promoted) parts.push(`${r.promoted} 人遞補為正取`);
  if (r?.demoted) parts.push(`${r.demoted} 人改為候補`);
  return parts.length ? `，${parts.join('、')}（已通知群組）` : '';
}

App.go = (view, params = {}) => {
  App.state.view = view;
  App.state.params = params;
};

function topOf(view) {
  return App.tabs.find((t) => t.view === view || (App.subtabs[t.view] || []).some((s) => s.view === view))?.view || view;
}

function renderNav() {
  const visible = App.tabs.filter((t) => !t.show || t.show());
  const current = App.parentOf[App.state.view] || App.state.view;
  const top = topOf(current);
  const tabs = $('tabs');
  tabs.hidden = visible.length < 2;
  tabs.innerHTML = visible.map((t) => `<button data-act="nav" data-view="${t.view}" class="${t.view === top ? 'on' : ''}">${t.label}</button>`).join('');
  const subs = App.subtabs[top] || [];
  const sub = $('subtabs');
  sub.hidden = !subs.length;
  sub.innerHTML = subs.map((s) => `<button data-act="nav" data-view="${s.view}" class="${s.view === current ? 'on' : ''}">${s.label}</button>`).join('');
}

App.render = async () => {
  renderNav();
  try {
    const view = App.views[App.state.view] || App.views.list;
    $('app').innerHTML = await view(App.state.params);
  } catch (e) {
    $('app').innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
  }
};

App.actions.nav = (d) => {
  const subs = App.subtabs[d.view];
  App.go(subs ? subs[0].view : d.view);
};
App.actions.back = (d) => App.go(d.view || 'list', d.sid ? { sid: d.sid } : {});

// ---------- 成員：近期場次 ----------

function mineText(r) {
  const who = r.guestName ? `${esc(r.guestName)}（朋友）` : '我';
  if (r.status === 'confirmed') return `${who}：<span class="state-confirmed">正取${r.kind === 'season' ? '（季打）' : ''}</span>`;
  if (r.status === 'waitlist') return `${who}：<span class="state-waitlist">候補第 ${r.position} 位</span>`;
  return `${who}：<span class="state-leave">已請假</span>`;
}

function mineAction(s, r) {
  if (s.status === 'cancelled' || new Date(s.startAt) <= new Date()) return '';
  const guest = r.guestName ? ` data-guest="${esc(r.guestName)}"` : '';
  if (r.kind === 'season') {
    return r.status === 'leave'
      ? `<button class="small" data-act="unleave" data-sid="${esc(s.id)}">銷假</button>`
      : `<button class="small" data-act="leave" data-sid="${esc(s.id)}">請假</button>`;
  }
  return `<button class="small" data-act="cancel" data-sid="${esc(s.id)}"${guest}>取消</button>`;
}

const levelTag = (e) => (e.level ? `<span class="lv">${e.level}級</span>` : '');
const mineRows = (s) => s.mine.map((r) => `<div class="item"><span>${mineText(r)}</span>${mineAction(s, r)}</div>`).join('');

function rosterList(title, items, markCasual, compact) {
  return `
    <h3>${title}（${items.length}）</h3>
    ${items.length ? `<ol${compact ? ' class="names"' : ''}>${items.map((e) => `<li>${esc(e.name)}${markCasual && e.kind === 'casual' ? '（臨）' : ''}${levelTag(e)}</li>`).join('')}</ol>` : '<div class="empty">（無）</div>'}`;
}

/** 報名中、已截止的場次：名單直接展開在卡片裡。joining = 按了「我要報名」，正在填報名欄位。 */
function sessionCard(s, joining) {
  const self = s.mine.find((r) => !r.guestName);
  const canJoin = s.status === 'open';
  const left = Math.max(0, s.capacity - s.confirmed);
  const sid = esc(s.id);
  const join = left ? '我要報名' : '排候補';
  let actions = '';
  if (canJoin && !self && joining) {
    actions = `
    <form class="grid" data-form="join" data-sid="${sid}" style="margin-top:12px">
      ${signupFields(lastJoin.get())}
      <div class="full actions" style="margin-top:0">
        <button class="primary" type="submit">${join}</button>
        <button type="button" data-act="back">取消</button>
      </div>
    </form>`;
  } else {
    const buttons = [];
    if (canJoin && !self) buttons.push(`<button class="primary" data-act="join" data-sid="${sid}">${join}</button>`);
    if (canJoin) buttons.push(`<button data-act="guest" data-sid="${sid}" data-when="${esc(fmt(s.startAt))}">幫朋友報名</button>`);
    if (!s.roster) buttons.push(`<button data-act="roster" data-sid="${sid}">名單</button>`);
    if (buttons.length) actions = `<div class="actions">${buttons.join('')}</div>`;
  }
  const r = s.roster;
  return `
  <section class="card list">
    <div class="row"><div class="when">${fmt(s.startAt)}–${timeOnly(s.endAt)}</div>
      <span class="badge ${s.status}">${STATUS[s.status]}</span></div>
    <div class="meta">${dots(place(s.venue, s.courtNo), `正取 ${s.confirmed}/${s.capacity}`, s.waitlist && `候補 ${s.waitlist}`, canJoin && left && `剩 ${left} 位`)}</div>
    ${s.status === 'cancelled' && s.cancelReason ? `<div class="meta">取消原因：${esc(s.cancelReason)}</div>` : ''}
    ${s.mine.length ? `<div class="mine">${mineRows(s)}</div>` : ''}
    ${actions}
    ${r ? `${rosterList('正取', r.confirmed, true, true)}
      ${r.waitlist.length ? rosterList('候補', r.waitlist, false, true) : ''}
      ${r.leave.length ? rosterList('請假', r.leave, false, true) : ''}` : ''}
  </section>`;
}

/** 還沒開放報名的場次：只佔一小列，不搶報名中場次的版面。 */
function soonRow(s) {
  return `
    <div class="soon">
      <div class="row"><span>${fmt(s.startAt)}–${timeOnly(s.endAt)}</span>
        <button class="small" data-act="roster" data-sid="${esc(s.id)}">名單</button></div>
      <div class="hint">${dots(`${fmt(s.regOpenAt)} 開放報名`, place(s.venue, s.courtNo))}</div>
      ${mineRows(s)}
    </div>`;
}

/** 球團規則（管理員在「設定」填的備註），放在報名頁最上面，可以收合。 */
function rulesCard() {
  const rules = App.state.me.club.rules;
  if (!rules) return '';
  return `<section class="card"><details class="fold" id="rules" ${rulesFold.folded(rules) ? '' : 'open'}>
    <summary>球團規則</summary><div class="note">${esc(rules)}</div></details></section>`;
}

App.views.list = async ({ joining }) => {
  const { sessions } = await api('/sessions');
  if (!sessions.length) return `${rulesCard()}<div class="card empty">目前沒有排定的場次</div>${feedbackLink()}`;
  const soon = sessions.filter((s) => s.status === 'scheduled');
  return `${rulesCard()}
    ${sessions.filter((s) => s.status !== 'scheduled').map((s) => sessionCard(s, s.id === joining)).join('')}
    ${soon.length ? `<section class="card quiet"><div class="hint">尚未開放</div>${soon.map(soonRow).join('')}</section>` : ''}
    ${feedbackLink()}`;
};

// ---------- 意見回饋（寫給開發者，後端存起來再寄信；頁面上看不到別人寫的） ----------

/** 頁面最下面那個不顯眼的連結。from = 所在的頁面，填寫完回到這裡。 */
const feedbackLink = (from = 'list') =>
  App.state.me.feedback ? `<div class="foot"><button class="link" data-act="feedback" data-from="${from}">意見回饋</button></div>` : '';

App.actions.feedback = (d) => {
  const from = d.from || 'list';
  // 填寫頁掛在來的那個分頁底下：從管理頁面進來時，上面的分頁仍停在「管理」
  App.parentOf.feedback = from;
  App.go('feedback', { from });
};
App.views.feedback = async ({ from = 'list' }) => `
  <div><button data-act="back" data-view="${esc(from)}">← 返回</button></div>
  <section class="card">
    <form class="grid" data-form="feedback" data-back="${esc(from)}">
      <label class="full">意見回饋<textarea name="message" rows="6" maxlength="1000" required placeholder="使用上遇到的問題、想要的功能、任何建議都可以寫"></textarea></label>
      <div class="full hint">會連同你的名字和球團名稱寄給這套報名系統的開發者。只有開發者看得到，球團管理員看不到，也不會顯示在群組或名單上。</div>
      <div class="full"><button class="primary" type="submit">送出</button></div>
    </form>
  </section>`;
App.forms.feedback = async (fd, d) => {
  await api('/feedback', { message: fd.get('message') });
  toast('已送出，謝謝你的意見');
  App.go(d.back || 'list');
};

App.views.roster = async ({ sid }) => {
  const { session: s, roster: r } = await api(`/sessions/${encodeURIComponent(sid)}`);
  return `
    <div><button data-act="back">← 返回</button></div>
    <section class="card list">
      <div class="row"><div class="when">${fmt(s.startAt)}</div><span class="badge ${s.status}">${STATUS[s.status]}</span></div>
      <div class="meta">${dots(place(s.venue, s.courtNo), `上限 ${s.capacity} 人`)}</div>
      ${rosterList('正取', r.confirmed, true)}
      ${rosterList('候補', r.waitlist, false)}
      ${r.leave.length ? rosterList('請假', r.leave, false) : ''}
    </section>`;
};

App.views.guest = async ({ sid, when }) => `
  <div><button data-act="back">← 返回</button></div>
  <section class="card">
    <h2>幫朋友報名</h2>
    <div class="meta">${esc(when || '')}</div>
    <form class="grid" data-form="guest" data-sid="${esc(sid)}" style="margin-top:10px">
      <label class="full">朋友的名字<input name="guestName" maxlength="20" required></label>
      ${signupFields()}
      <div class="full"><button class="primary" type="submit">報名</button></div>
    </form>
  </section>`;

App.forms.guest = async (fd, d) => {
  const name = String(fd.get('guestName') || '').trim();
  if (!name) throw new Error('請填寫朋友的名字');
  const r = await api(`/sessions/${d.sid}/register`, { guestName: name, ...signupValues(fd) });
  toast(`${name}：${r.status === 'confirmed' ? '正取' : `候補第 ${r.position} 位`}`);
  App.go('list');
};

/** 自己報名：卡片上的報名欄位填好後送出。 */
App.forms.join = async (fd, d) => {
  const fields = signupValues(fd);
  const r = await api(`/sessions/${d.sid}/register`, fields);
  // 同價時表單沒有臨打費那一欄，保留之前記住的
  lastJoin.set({ gender: fields.gender ?? lastJoin.get().gender ?? null, level: fields.level });
  toast(r.status === 'confirmed' ? '報名成功：正取' : `已排入候補第 ${r.position} 位`);
  App.go('list');
};

Object.assign(App.actions, {
  // 按「我要報名」：在卡片上展開報名欄位（臨打費、程度）
  join(d) { App.go('list', { joining: d.sid }); },
  guest(d) { App.go('guest', { sid: d.sid, when: d.when }); },
  async cancel(d) {
    if (!confirm(d.guest ? `取消 ${d.guest} 的報名？` : '確定取消報名？')) return;
    await api(`/sessions/${d.sid}/cancel`, d.guest ? { guestName: d.guest } : {});
    toast('已取消');
  },
  async leave(d) {
    if (!confirm('確定這場請假？名額會釋出給候補。')) return;
    await api(`/sessions/${d.sid}/leave`, {});
    toast('已請假');
  },
  async unleave(d) {
    const r = await api(`/sessions/${d.sid}/unleave`, {});
    toast(r.status === 'confirmed' ? '已銷假：正取' : `名額已滿，排入候補第 ${r.position} 位`);
  },
  roster(d) { App.go('roster', { sid: d.sid }); },
});

App.tabs.push({ view: 'list', label: '報名' });

// ---------- 事件 ----------

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const fn = App.actions[btn.dataset.act];
  if (!fn) return;
  btn.disabled = true;
  try {
    await fn({ ...btn.dataset });
  } catch (e) {
    toast(e.message);
  }
  await App.render();
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('form[data-form]');
  if (!form) return;
  ev.preventDefault();
  const fn = App.forms[form.dataset.form];
  if (!fn) return;
  const submit = form.querySelector('button[type=submit], button:not([type])');
  if (submit) submit.disabled = true;
  try {
    await fn(new FormData(form), { ...form.dataset });
  } catch (e) {
    toast(e.message);
    if (submit) submit.disabled = false;
    return;
  }
  await App.render();
});

// 收合／展開球團規則時記下來。<details> 的 toggle 不會冒泡，要在捕獲階段聽
document.addEventListener('toggle', (ev) => {
  if (ev.target.id === 'rules') rulesFold.set(App.state.me.club.rules, !ev.target.open);
}, true);

document.addEventListener('change', async (ev) => {
  const input = ev.target.closest('[data-change]');
  if (!input) return;
  const fn = App.changes[input.dataset.change];
  if (!fn) return;
  input.disabled = true;
  try {
    await fn(input, { ...input.dataset });
  } catch (e) {
    toast(e.message);
  }
  await App.render();
});

App.start = async () => {
  try {
    await liff.init({ liffId: CONFIG.LIFF_ID });
    if (!liff.isLoggedIn()) {
      liff.login({ redirectUri: location.href });
      return;
    }
    if (idTokenExpired() && relogin()) return;
    App.state.clubId = new URLSearchParams(location.search).get('club');
    if (!App.state.clubId) throw new Error('連結缺少球團資訊，請從群組的「選單」開啟');
    App.state.idToken = liff.getIDToken();
    App.state.me = await api('/me');
    $('title').textContent = App.state.me.club.name;
    $('subtitle').textContent = { owner: '擁有者', admin: '管理員' }[App.state.me.role] || '';
    await App.render();
  } catch (e) {
    $('title').textContent = '無法載入';
    $('app').innerHTML = `<div class="card empty">${esc(e.message)}</div>`;
  }
};
