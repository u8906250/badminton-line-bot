// 管理員頁面：場次、季打、抽籤、記帳、時段、成員、設定。只有管理員看得到「管理」分頁。
// 另外有一個給季打成員的「帳本」分頁：和記帳同一個畫面，但只能看。

(() => {
  const isAdmin = () => !!App.state.me?.isAdmin;
  const isOwner = () => App.state.me?.role === 'owner';
  const A = (path, body) => api(`/admin${path}`, body);
  const enc = encodeURIComponent;
  const ROLE = { owner: '擁有者', admin: '管理員', member: '成員' };
  // external = 不在 LINE 上、由管理員手動加入的人（例如教練）
  const memberName = (m) => (m.external ? `${m.nickname || m.displayName}（非 LINE）` : m.nickname ? `${m.nickname}（${m.displayName}）` : m.displayName);
  const field = (label, html, full) => `<label class="${full ? 'full' : ''}">${label}${html}</label>`;
  const input = (name, value, attrs = '') => `<input name="${name}" value="${esc(value ?? '')}" ${attrs}>`;
  const num = (fd, k) => (fd.get(k) === '' || fd.get(k) === null ? null : Number(fd.get(k)));
  const courtField = (value) => field('第幾場地（可留空）', input('courtNo', value, 'maxlength="20" placeholder="例如：第 3、4 場"'), true);

  // 季打成員（不是管理員）看得到唯讀的帳本；管理員走「管理 → 記帳」
  App.tabs.push({ view: 'ledger', label: '帳本', show: () => !!App.state.me?.canViewLedger && !isAdmin() });
  App.tabs.push({ view: 'a-sessions', label: '管理', show: isAdmin });
  App.subtabs['a-sessions'] = [
    { view: 'a-sessions', label: '場次' },
    { view: 'a-seasons', label: '季打' },
    { view: 'a-draws', label: '抽籤' },
    { view: 'a-ledger', label: '記帳' },
    { view: 'a-schedules', label: '時段' },
    { view: 'a-members', label: '成員' },
    { view: 'a-settings', label: '設定' },
  ];
  App.parentOf['a-session'] = 'a-sessions';
  App.parentOf['a-attendance'] = 'a-sessions';
  App.parentOf['a-draw'] = 'a-draws';

  // ---------- 場次 ----------

  App.views['a-sessions'] = async () => {
    const { sessions } = await A('/sessions');
    const now = new Date();
    const cards = sessions.map((s) => {
      const live = s.status !== 'cancelled' && s.status !== 'done';
      const started = new Date(s.start_at) <= now;
      return `
      <section class="card">
        <div class="row"><div class="when">${fmt(s.start_at)}–${timeOnly(s.end_at)}</div>
          <span class="badge ${s.status}">${STATUS[s.status]}</span></div>
        <div class="meta">${dots(place(s.venue, s.court_no), !s.schedule_id && '臨時加場', `正取 ${s.confirmed}/${s.capacity}`, s.waitlist && `候補 ${s.waitlist}`, s.leave && `請假 ${s.leave}`)}</div>
        ${s.cancel_reason ? `<div class="meta">取消原因：${esc(s.cancel_reason)}</div>` : ''}
        <div class="actions">
          ${s.status !== 'cancelled' ? `<button data-act="aAttendance" data-sid="${esc(s.id)}">點名收費</button>` : ''}
          ${live && !started ? `<button data-act="aSession" data-sid="${esc(s.id)}">名單管理</button>` : ''}
          ${live && !started ? `<button data-act="aCapacity" data-sid="${esc(s.id)}" data-cap="${s.capacity}">調整上限</button>` : ''}
          ${live ? `<button data-act="aCourt" data-sid="${esc(s.id)}" data-court="${esc(s.court_no ?? '')}">第幾場地</button>` : ''}
          ${live && !started ? `<button class="danger" data-act="aCancelSession" data-sid="${esc(s.id)}">取消場次</button>` : ''}
        </div>
      </section>`;
    });
    return `
      <section class="card">
        <details>
          <summary>＋ 臨時加場</summary>
          <form class="grid" data-form="aExtra">
            ${field('日期', '<input type="date" name="date" required>', true)}
            ${field('開始', '<input type="time" name="startTime" value="20:00" required>')}
            ${field('結束', '<input type="time" name="endTime" value="22:00" required>')}
            ${field('場地', input('venue', ''), true)}
            ${courtField('')}
            ${field('場地數', '<input type="number" name="courts" value="1" min="1" required>')}
            ${field('人數上限', '<input type="number" name="capacity" value="8" min="1" required>')}
            <div class="full hint">加場沒有季打佔位，依球團的報名規則開放。</div>
            <div class="full"><button class="primary" type="submit">建立</button></div>
          </form>
        </details>
      </section>
      ${cards.join('') || '<div class="card empty">近期沒有場次。到「時段」新增每週時段後會自動產生。</div>'}`;
  };

  App.forms.aExtra = async (fd) => {
    await A('/sessions', {
      date: fd.get('date'), startTime: fd.get('startTime'), endTime: fd.get('endTime'),
      venue: fd.get('venue'), courtNo: fd.get('courtNo'), courts: num(fd, 'courts'), capacity: num(fd, 'capacity'),
    });
    toast('已建立臨時場次');
  };

  Object.assign(App.actions, {
    aAttendance(d) { App.go('a-attendance', { sid: d.sid }); },
    aSession(d) { App.go('a-session', { sid: d.sid }); },
    async aCapacity(d) {
      const v = prompt('新的人數上限', d.cap);
      if (v === null || v.trim() === '') return;
      const r = await A(`/sessions/${enc(d.sid)}/capacity`, { capacity: Number(v) });
      toast(`上限已改為 ${v}${changesText(r)}`);
    },
    async aCourt(d) {
      const v = prompt('這一場在第幾場地？（例如：第 3、4 場；清空 = 不顯示）', d.court);
      if (v === null) return;
      await A(`/sessions/${enc(d.sid)}/court`, { courtNo: v });
      toast(v.trim() ? `這一場改為 ${v.trim()}` : '已清除這一場的場地編號');
    },
    async aCancelSession(d) {
      const reason = prompt('取消原因（會公告在群組，可留空）');
      if (reason === null) return;
      await A(`/sessions/${enc(d.sid)}/cancel`, { reason, notify: true });
      toast('已取消並通知群組');
    },
  });

  // ---------- 名單管理（代報名、代取消） ----------

  App.views['a-session'] = async ({ sid }) => {
    const [{ session: s, roster: r }, { members }] = await Promise.all([A(`/sessions/${enc(sid)}`), A('/members')]);
    const row = (e, label, act = 'aCancelReg') => `
      <div class="item"><span>${esc(e.name)}${e.kind === 'season' ? '（季）' : ''}${levelTag(e)}</span>
        <button class="small" data-act="${act}" data-sid="${esc(s.id)}" data-rid="${esc(e.id)}" data-name="${esc(e.name)}">${label}</button></div>`;
    const block = (title, items, label) =>
      `<h3>${title}（${items.length}）</h3>${items.length ? items.map((e) => row(e, e.kind === 'season' ? '請假' : label)).join('') : '<div class="empty">（無）</div>'}`;
    return `
      <div><button data-act="back" data-view="a-sessions">← 返回</button></div>
      <section class="card list">
        <div class="row"><div class="when">${fmt(s.start_at)}</div><span class="badge ${s.status}">${STATUS[s.status]}</span></div>
        <div class="meta">${dots(place(s.venue, s.court_no), `上限 ${s.capacity} 人`)}</div>
        ${block('正取', r.confirmed, '取消')}
        ${block('候補', r.waitlist, '取消')}
        ${r.leave.length ? `<h3>請假（${r.leave.length}）</h3>${r.leave.map((e) => row(e, '銷假', 'aUnleave')).join('')}` : ''}
      </section>
      <section class="card">
        <h2>代成員報名</h2>
        <form class="grid" data-form="aRegisterFor" data-sid="${esc(s.id)}">
          ${field('成員', `<select name="userId" required><option value="">選擇成員</option>${members.map((m) => `<option value="${esc(m.userId)}">${esc(memberName(m))}</option>`).join('')}</select>`, true)}
          ${field('朋友名字（幫朋友報才填）', input('guestName', ''), true)}
          ${feeByGender() ? field('臨打費', feeSelect(false)) : ''}
          ${field('程度（可不填）', levelSelect(), !feeByGender())}
          <div class="full hint">不受報名開放與截止時間限制，名額滿了會排候補。</div>
          <div class="full"><button class="primary" type="submit">報名</button></div>
        </form>
      </section>`;
  };

  App.forms.aRegisterFor = async (fd, d) => {
    const r = await A(`/sessions/${enc(d.sid)}/register`, { userId: fd.get('userId'), guestName: fd.get('guestName'), ...signupValues(fd) });
    toast(r.status === 'confirmed' ? '已報名：正取' : `已排入候補第 ${r.position} 位`);
  };

  App.actions.aCancelReg = async (d) => {
    if (!confirm(`取消 ${d.name} 這場的名額？`)) return;
    const r = await A(`/sessions/${enc(d.sid)}/registrations/${enc(d.rid)}/cancel`, {});
    toast(`已取消${changesText(r)}`);
  };

  App.actions.aUnleave = async (d) => {
    const r = await A(`/sessions/${enc(d.sid)}/registrations/${enc(d.rid)}/unleave`, {});
    toast(r.status === 'confirmed' ? `${d.name} 已銷假：正取` : `${d.name} 已銷假：名額已滿，排入候補第 ${r.position} 位`);
  };

  // ---------- 點名與收費 ----------

  App.views['a-attendance'] = async ({ sid }) => {
    const { session: s, rows, casualFee, casualFeeFemale } = await A(`/sessions/${enc(sid)}/attendance`);
    const byGender = casualFeeFemale != null && casualFeeFemale !== casualFee;
    const casual = rows.filter((r) => r.kind === 'casual');
    const paid = casual.filter((r) => r.feePaid);
    const total = paid.reduce((n, r) => n + (r.feeAmount ?? 0), 0);
    const present = rows.filter((r) => r.attended).length;
    const line = (r) => `
      <div class="item">
        <label class="check"><input type="checkbox" data-change="aAttended" data-sid="${esc(s.id)}" data-rid="${esc(r.id)}" ${r.attended ? 'checked' : ''}>
          ${esc(r.name)}${r.kind === 'season' ? '<span class="hint">（季）</span>' : ''}${levelTag(r)}</label>
        ${r.kind === 'casual' ? `<span class="check">
          <input class="fee" type="number" min="0" inputmode="numeric" placeholder="${r.defaultFee}" value="${r.feeAmount ?? ''}" data-change="aFeeAmount" data-sid="${esc(s.id)}" data-rid="${esc(r.id)}">
          <label class="check"><input type="checkbox" data-change="aFeePaid" data-sid="${esc(s.id)}" data-rid="${esc(r.id)}" ${r.feePaid ? 'checked' : ''}>已收</label></span>` : ''}
      </div>`;
    return `
      <div><button data-act="back" data-view="a-sessions">← 返回</button></div>
      <section class="card">
        <div class="row"><div class="when">${fmt(s.start_at)}</div><span class="badge ${s.status}">${STATUS[s.status]}</span></div>
        <div class="meta">出席 ${present}/${rows.length} ・ 臨打已收 ${paid.length}/${casual.length} 人，共 <span class="total">$${total}</span></div>
        <div class="mine">${rows.map(line).join('') || '<div class="empty">這場沒有正取名單</div>'}</div>
        <div class="hint" style="margin-top:10px">勾「出席」記錄有來；臨打勾「已收」時金額沒填就帶入臨打費${byGender ? `（報名時選女生的 $${casualFeeFemale}，其他 $${casualFee}），金額可以直接改` : ` $${casualFee}`}。季費到「季打」分頁登記。</div>
      </section>`;
  };

  Object.assign(App.changes, {
    aAttended: (el, d) => A(`/sessions/${enc(d.sid)}/attendance/${enc(d.rid)}`, { attended: el.checked }),
    aFeePaid: (el, d) => A(`/sessions/${enc(d.sid)}/attendance/${enc(d.rid)}`, { feePaid: el.checked }),
    aFeeAmount: (el, d) => A(`/sessions/${enc(d.sid)}/attendance/${enc(d.rid)}`, { feeAmount: el.value === '' ? null : Number(el.value) }),
  });

  // ---------- 季期與季打名單 ----------

  App.views['a-seasons'] = async () => {
    const [{ seasons }, { members }] = await Promise.all([A('/seasons'), A('/members')]);
    const today = new Date().toISOString().slice(0, 10);
    const card = (se) => {
      const inSeason = new Set(se.members.map((m) => m.userId));
      const others = members.filter((m) => !inSeason.has(m.userId));
      const exempt = se.members.filter((m) => m.feeExempt).length; // 不收季費的人（例如教練）不算進已繳人數
      const paid = se.members.filter((m) => m.feePaid && !m.feeExempt).length;
      const current = se.start_date <= today && today <= se.end_date;
      return `
      <section class="card">
        <div class="row"><h2>${esc(se.name)}</h2>${current ? '<span class="badge open">進行中</span>' : ''}</div>
        <div class="meta">${esc(se.start_date)} – ${esc(se.end_date)} ・ 季費 $${se.fee} ・ 已繳 ${paid}/${se.members.length - exempt}${exempt ? ` ・ 免季費 ${exempt} 人` : ''}</div>
        <div class="mine">
          ${se.members.map((m) => `
            <div class="item"><span>${esc(m.name)}${m.external ? '<span class="hint">（非 LINE）</span>' : ''}</span>
              <span class="check">
                ${m.feeExempt ? '' : `<label class="check"><input type="checkbox" data-change="aSeasonFee" data-season="${esc(se.id)}" data-uid="${esc(m.userId)}" ${m.feePaid ? 'checked' : ''}>已繳</label>`}
                <label class="check"><input type="checkbox" data-change="aSeasonExempt" data-season="${esc(se.id)}" data-uid="${esc(m.userId)}" ${m.feeExempt ? 'checked' : ''}>免季費</label>
                <button class="small" data-act="aSeasonRemove" data-season="${esc(se.id)}" data-uid="${esc(m.userId)}" data-name="${esc(m.name)}">移出</button>
              </span></div>`).join('') || '<div class="empty">還沒有季打成員</div>'}
        </div>
        <details style="margin-top:12px">
          <summary>＋ 加入季打成員</summary>
          ${others.length ? `<form data-form="aSeasonAdd" data-season="${esc(se.id)}">
            <div class="mine">${others.map((m) => `<label class="check"><input type="checkbox" name="userIds" value="${esc(m.userId)}">${esc(memberName(m))}</label>`).join('')}</div>
            <div class="hint" style="margin:8px 0">加入後會立即在這季還沒開打的場次佔位；名額滿時，最後報名的臨打會改為候補。</div>
            <button class="primary" type="submit">加入</button>
          </form>` : '<div class="empty">所有成員都已在名單中。沒看到的人請他先在群組輸入「選單」。</div>'}
        </details>
        <details style="margin-top:8px">
          <summary>＋ 加入不在 LINE 上的人（例如教練）</summary>
          <form class="grid" data-form="aSeasonAddExternal" data-season="${esc(se.id)}">
            ${field('名字', input('name', '', 'maxlength="20" required'), true)}
            <div class="full hint">會佔一個季打名額、出現在名單上，和其他人一樣要繳季費；不收的話，加入後在名單上勾「免季費」。他沒辦法自己操作，請假、銷假由管理員代為處理（報名頁的場次卡片或「場次 → 名單管理」）。</div>
            <div class="full"><button class="primary" type="submit">加入</button></div>
          </form>
        </details>
        <details style="margin-top:8px">
          <summary>修改名稱或季費</summary>
          <form class="grid" data-form="aSeasonEdit" data-season="${esc(se.id)}">
            ${field('名稱', input('name', se.name, 'required'))}
            ${field('季費', `<input type="number" name="fee" min="0" value="${se.fee}" required>`)}
            <div class="full"><button type="submit">儲存</button></div>
          </form>
        </details>
      </section>`;
    };
    return `
      <section class="card">
        <details ${seasons.length ? '' : 'open'}>
          <summary>＋ 新增季期</summary>
          <form class="grid" data-form="aSeasonCreate">
            ${field('名稱', input('name', '', 'required placeholder="例如 2027 第一季"'), true)}
            ${field('開始日期', '<input type="date" name="startDate" required>')}
            ${field('結束日期', '<input type="date" name="endDate" required>')}
            ${field('季費', '<input type="number" name="fee" min="0" value="0" required>', true)}
            <div class="full hint">日期含頭尾，不能和其他季期重疊。建立後日期就不能改。</div>
            <div class="full"><button class="primary" type="submit">建立</button></div>
          </form>
        </details>
      </section>
      ${seasons.map(card).join('')}`;
  };

  App.forms.aSeasonCreate = async (fd) => {
    await A('/seasons', { name: fd.get('name'), startDate: fd.get('startDate'), endDate: fd.get('endDate'), fee: num(fd, 'fee') });
    toast('已建立季期');
  };
  App.forms.aSeasonEdit = async (fd, d) => {
    await A(`/seasons/${enc(d.season)}`, { name: fd.get('name'), fee: num(fd, 'fee') });
    toast('已儲存');
  };
  App.forms.aSeasonAdd = async (fd, d) => {
    const userIds = fd.getAll('userIds');
    if (!userIds.length) throw new Error('請勾選要加入的成員');
    const r = await A(`/seasons/${enc(d.season)}/members`, { userIds });
    toast(`已加入 ${userIds.length} 人${changesText(r)}`);
  };
  App.forms.aSeasonAddExternal = async (fd, d) => {
    const name = String(fd.get('name') || '').trim();
    const r = await A(`/seasons/${enc(d.season)}/externals`, { name });
    toast(`已加入 ${name}${changesText(r)}`);
  };
  App.changes.aSeasonFee = (el, d) => A(`/seasons/${enc(d.season)}/members/${enc(d.uid)}/fee`, { paid: el.checked });
  App.changes.aSeasonExempt = (el, d) => A(`/seasons/${enc(d.season)}/members/${enc(d.uid)}/exempt`, { exempt: el.checked });
  App.actions.aSeasonRemove = async (d) => {
    if (!confirm(`把 ${d.name} 移出這季？還沒開打的場次會取消他的名額。`)) return;
    const r = await A(`/seasons/${enc(d.season)}/members/${enc(d.uid)}/remove`, {});
    toast(`已移出${changesText(r)}`);
  };

  // ---------- 抽籤紀錄（例如場地抽籤：誰已經抽了、誰抽中） ----------

  const drawMeta = (d) => dots(`已抽籤 ${d.drawn} 人`, `抽中 ${d.won} 人`, `建立於 ${fmt(d.createdAt)}`);

  App.views['a-draws'] = async () => {
    const { draws } = await A('/draws');
    return `
      <section class="card">
        <details ${draws.length ? '' : 'open'}>
          <summary>＋ 新增抽籤紀錄</summary>
          <form class="grid" data-form="aDrawCreate">
            ${field('名稱', input('name', '', 'maxlength="30" required placeholder="例如：11 月場地抽籤"'), true)}
            ${field('備註（可留空）', `<textarea name="note" rows="2" maxlength="200" placeholder="例如：某某國小體育館，週三 20:00–22:00"></textarea>`, true)}
            <div class="full hint">建立後可以勾選每位成員是否已經抽籤、有沒有抽中，也可以加入不在球團裡的人。</div>
            <div class="full"><button class="primary" type="submit">建立</button></div>
          </form>
        </details>
      </section>
      ${draws.map((d) => `
        <section class="card">
          <div class="row"><h2>${esc(d.name)}</h2><button class="small" data-act="aDrawOpen" data-id="${esc(d.id)}">打開</button></div>
          ${d.note ? `<div class="note meta">${esc(d.note)}</div>` : ''}
          <div class="meta">${drawMeta(d)}</div>
        </section>`).join('') || '<div class="card empty">還沒有抽籤紀錄</div>'}`;
  };
  App.forms.aDrawCreate = async (fd) => {
    const { draw } = await A('/draws', { name: fd.get('name'), note: fd.get('note') });
    toast('已建立');
    App.go('a-draw', { id: draw.id });
  };
  App.actions.aDrawOpen = (d) => App.go('a-draw', { id: d.id });

  App.views['a-draw'] = async ({ id }) => {
    const { draw: d, rows } = await A(`/draws/${enc(id)}`);
    const box = (r, field, label) => `<label class="check"><input type="checkbox" data-change="aDrawMark" data-id="${esc(d.id)}" data-field="${field}"
      ${r.kind === 'member' ? `data-uid="${esc(r.userId)}"` : `data-eid="${esc(r.entryId)}"`} ${r[field] ? 'checked' : ''}>${label}</label>`;
    const row = (r) => `
      <div class="item"><span>${esc(r.name)}${r.kind === 'left' ? '<span class="hint">（已不在球團）</span>' : ''}</span>
        <span class="check">
          ${box(r, 'drawn', '已抽籤')}${box(r, 'won', '抽中')}
          ${r.kind === 'outside' ? `<button class="small" data-act="aDrawRemove" data-id="${esc(d.id)}" data-eid="${esc(r.entryId)}" data-name="${esc(r.name)}">移除</button>` : ''}
        </span></div>`;
    const members = rows.filter((r) => r.kind !== 'outside');
    const outside = rows.filter((r) => r.kind === 'outside');
    const notYet = members.filter((r) => !r.drawn && r.kind === 'member');
    return `
      <div><button data-act="back" data-view="a-draws">← 返回</button></div>
      <section class="card">
        <h2>${esc(d.name)}</h2>
        ${d.note ? `<div class="note meta">${esc(d.note)}</div>` : ''}
        <div class="meta">${drawMeta(d)}</div>
        ${notYet.length ? `<div class="hint" style="margin-top:6px">還沒抽籤的成員（${notYet.length}）：${notYet.map((r) => esc(r.name)).join('、')}</div>` : ''}
      </section>
      <section class="card">
        <h2>成員（${members.length}）</h2>
        <div class="hint">勾「抽中」會一併勾「已抽籤」；取消「已抽籤」會一併取消「抽中」。</div>
        <div class="mine">${members.map(row).join('') || '<div class="empty">還沒有成員</div>'}</div>
      </section>
      <section class="card">
        <h2>外面名單（${outside.length}）</h2>
        <div class="hint">不在球團裡、但這次幫忙抽籤的人。</div>
        <div class="mine">${outside.map(row).join('') || '<div class="empty">還沒有加入</div>'}</div>
        <details style="margin-top:12px" ${outside.length ? '' : 'open'}>
          <summary>＋ 加入外面名單</summary>
          <form class="grid" data-form="aDrawOutside" data-id="${esc(d.id)}">
            ${field('名字（一行一個，或用逗號、頓號隔開）', `<textarea name="names" rows="3" required placeholder="例如：&#10;王小明&#10;陳小華"></textarea>`, true)}
            <label class="full check"><input type="checkbox" name="drawn">加入時直接勾「已抽籤」</label>
            <div class="full"><button class="primary" type="submit">加入</button></div>
          </form>
        </details>
      </section>
      <section class="card">
        <details>
          <summary>修改名稱或備註</summary>
          <form class="grid" data-form="aDrawEdit" data-id="${esc(d.id)}">
            ${field('名稱', input('name', d.name, 'maxlength="30" required'), true)}
            ${field('備註（可留空）', `<textarea name="note" rows="2" maxlength="200">${esc(d.note ?? '')}</textarea>`, true)}
            <div class="full"><button type="submit">儲存</button></div>
          </form>
        </details>
        <details style="margin-top:8px">
          <summary style="color:var(--danger)">刪除這次抽籤紀錄</summary>
          <div class="hint" style="margin:8px 0">會刪掉這次的所有勾選和外面名單，無法復原。</div>
          <button class="danger" data-act="aDrawDelete" data-id="${esc(d.id)}" data-name="${esc(d.name)}">刪除</button>
        </details>
      </section>`;
  };
  App.changes.aDrawMark = (el, d) =>
    A(`/draws/${enc(d.id)}/mark`, { ...(d.uid ? { userId: d.uid } : { entryId: d.eid }), field: d.field, value: el.checked });
  App.forms.aDrawOutside = async (fd, d) => {
    const r = await A(`/draws/${enc(d.id)}/outside`, { names: fd.get('names'), drawn: !!fd.get('drawn') });
    toast(`已加入 ${r.added.length} 人${r.skipped.length ? `，${r.skipped.join('、')} 已經在名單上` : ''}`);
  };
  App.actions.aDrawRemove = async (d) => {
    if (!confirm(`把 ${d.name} 從外面名單移除？`)) return;
    await A(`/draws/${enc(d.id)}/outside/${enc(d.eid)}/remove`, {});
    toast('已移除');
  };
  App.forms.aDrawEdit = async (fd, d) => {
    await A(`/draws/${enc(d.id)}`, { name: fd.get('name'), note: fd.get('note') });
    toast('已儲存');
  };
  App.actions.aDrawDelete = async (d) => {
    if (!confirm(`刪除「${d.name}」？所有勾選和外面名單都會刪掉，無法復原。`)) return;
    await A(`/draws/${enc(d.id)}/delete`, {});
    toast('已刪除');
    App.go('a-draws');
  };

  // ---------- 記帳 ----------

  const LEDGER = { venue: '場地費', shuttle: '羽球費', other_expense: '其他支出', other_income: '其他收入' };
  const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
  const today = () => localDateStr(new Date().toISOString());
  const shortDate = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    return `${y === Number(today().slice(0, 4)) ? '' : `${y}/`}${m}/${day}`;
  };
  let ledgerShown = { from: null, to: null }; // 畫面上的期間；新增後用來提示「不在顯示範圍內」

  /** 期間選單：各季期、本月、上月、今年、全部。 */
  function ledgerPeriods(seasons) {
    const [y, m] = today().split('-').map(Number);
    const month = (offset) => ({
      from: new Date(Date.UTC(y, m - 1 + offset, 1)).toISOString().slice(0, 10),
      to: new Date(Date.UTC(y, m + offset, 0)).toISOString().slice(0, 10),
    });
    return [
      ...seasons.map((se) => ({ label: se.name, from: se.startDate, to: se.endDate })),
      { label: '本月', ...month(0) },
      { label: '上月', ...month(-1) },
      { label: '今年', from: `${y}-01-01`, to: `${y}-12-31` },
      { label: '全部', from: '', to: '' },
    ].map((o) => ({ ...o, value: `${o.from}|${o.to}` }));
  }

  /** 帳本畫面。canEdit = 管理員的「記帳」（可新增、刪除）；否則是季打成員的「帳本」（只能看）。 */
  async function ledgerPage(p, canEdit) {
    // 沒指定期間時由後端決定：進行中的季期，沒有就看全部
    const qs = p.all ? '?all=1' : p.from ? `?from=${enc(p.from)}&to=${enc(p.to)}` : '';
    const { from, to, summary: s, entries, seasons } = await api(`/ledger${qs}`);
    ledgerShown = { from, to };
    const options = ledgerPeriods(seasons);
    const picked = options.find((o) => o.value === `${from ?? ''}|${to ?? ''}`);
    const line = (label, n) => `<div class="item"><span>${label}</span><span class="amount">${money(n)}</span></div>`;
    const fee = (label, f, unit) => `
      <div class="item"><span>${label}<span class="hint">（已收 ${f.paidCount} ${unit}）</span></span><span class="amount">${money(f.paid)}</span></div>
      ${f.unpaidCount ? `<div class="item"><span class="state-waitlist">${label}未收<span class="hint">（${f.unpaidCount} ${unit}）</span></span><span class="amount state-waitlist">${money(f.unpaid)}</span></div>` : ''}`;
    const row = (e) => {
      const label = `${shortDate(e.date)} ${LEDGER[e.category]}`;
      return `
      <div class="item">
        <span>${label}${e.note ? `<span class="hint"> ${esc(e.note)}</span>` : ''}</span>
        <span class="check"><span class="amount">${e.category === 'other_income' ? '+' : '-'}${money(e.amount)}</span>
          ${canEdit ? `<button class="small" data-act="aLedgerDelete" data-id="${esc(e.id)}" data-label="${esc(`${label} ${money(e.amount)}`)}">刪除</button>` : ''}</span>
      </div>`;
    };
    return `
      <section class="card">
        <label>期間
          <select data-change="ledgerPeriod" data-view="${canEdit ? 'a-ledger' : 'ledger'}">${options.map((o) => `<option value="${esc(o.value)}" ${o === picked ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        </label>
        <div class="row" style="margin-top:12px">
          <div><div class="hint">${from || to ? `${esc(from ?? '')} – ${esc(to ?? '')}` : '所有紀錄'}　結餘</div>
            <div class="big amount ${s.balance < 0 ? 'neg' : ''}">${money(s.balance)}</div></div>
          <div class="meta amount" style="text-align:right">收入 ${money(s.income)}<br>支出 ${money(s.expense)}</div>
        </div>
      </section>
      <section class="card list">
        <h3 style="margin-top:0">收入</h3>
        ${fee('季打費', s.season, '人')}
        ${fee('臨打費', s.casual, '人次')}
        ${line('其他收入', s.otherIncome)}
        <h3>支出</h3>
        ${line('場地費', s.venue)}
        ${line('羽球費', s.shuttle)}
        ${line('其他支出', s.otherExpense)}
        <div class="hint" style="margin-top:10px">結餘 = 已收的收入 − 支出，未收的不算在內。季打費記在季期開始日，臨打費記在場次當天。</div>
      </section>
      ${canEdit ? `<section class="card">
        <details ${entries.length ? '' : 'open'}>
          <summary>＋ 記一筆</summary>
          <form class="grid" data-form="aLedgerAdd">
            ${field('類別', `<select name="category">${Object.entries(LEDGER).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>`)}
            ${field('金額', '<input type="number" name="amount" min="1" inputmode="numeric" required>')}
            ${field('日期', `<input type="date" name="date" value="${today()}" required>`, true)}
            ${field('備註（可留空）', input('note', '', 'maxlength="60" placeholder="例如 10 月場租、比賽級羽球 2 筒"'), true)}
            <div class="full hint">季打費、臨打費不用在這裡記：在「季打」勾已繳、在點名頁勾已收，就會算進收入。</div>
            <div class="full"><button class="primary" type="submit">記錄</button></div>
          </form>
        </details>
      </section>` : ''}
      <section class="card">
        <h2>收支紀錄（${entries.length}）</h2>
        <div class="mine">${entries.map(row).join('') || '<div class="empty">這段期間還沒有登記場地費、羽球費等收支</div>'}</div>
        ${entries.length >= 200 ? '<div class="hint" style="margin-top:10px">只列出最近 200 筆；上面的金額是全部加總。</div>' : ''}
      </section>`;
  }
  App.views['a-ledger'] = (p) => ledgerPage(p, true);
  App.views.ledger = (p) => ledgerPage(p, false);

  App.changes.ledgerPeriod = (el, d) => {
    const [from, to] = el.value.split('|');
    App.go(d.view === 'a-ledger' ? 'a-ledger' : 'ledger', from ? { from, to } : { all: 1 });
  };
  App.forms.aLedgerAdd = async (fd) => {
    const date = fd.get('date');
    await A('/ledger', { category: fd.get('category'), amount: num(fd, 'amount'), date, note: fd.get('note') });
    const { from, to } = ledgerShown;
    toast((from && date < from) || (to && date > to) ? '已記錄（日期不在目前顯示的期間內）' : '已記錄');
  };
  App.actions.aLedgerDelete = async (d) => {
    if (!confirm(`刪除「${d.label}」這筆紀錄？`)) return;
    await A(`/ledger/${enc(d.id)}/delete`, {});
    toast('已刪除');
  };

  // ---------- 每週時段 ----------

  const scheduleForm = (sc) => `
    ${sc ? '' : field('星期', `<select name="weekday">${[...WEEKDAYS].map((w, i) => `<option value="${i}">週${w}</option>`).join('')}</select>`, true)}
    ${field('開始', `<input type="time" name="startTime" value="${esc(sc?.start_time ?? '20:00')}" required>`)}
    ${field('結束', `<input type="time" name="endTime" value="${esc(sc?.end_time ?? '22:00')}" required>`)}
    ${field('場地', input('venue', sc?.venue ?? ''), true)}
    ${courtField(sc?.court_no ?? '')}
    ${field('場地數', `<input type="number" name="courts" min="1" value="${sc?.courts ?? 2}" required>`)}
    ${field('人數上限', `<input type="number" name="capacity" min="1" value="${sc?.capacity ?? 15}" required>`)}`;

  App.views['a-schedules'] = async () => {
    const { schedules } = await A('/schedules');
    const card = (sc) => `
      <section class="card">
        <div class="row"><div class="when">每週${WEEKDAYS[sc.weekday]} ${esc(sc.start_time)}–${esc(sc.end_time)}</div>
          <span class="badge ${sc.active ? 'open' : ''}">${sc.active ? '使用中' : '已停用'}</span></div>
        <div class="meta">${dots(place(sc.venue || '未填場地', sc.court_no), `${sc.courts} 面場`, `上限 ${sc.capacity} 人`)}</div>
        ${sc.active ? `<details style="margin-top:10px"><summary>修改</summary>
          <form class="grid" data-form="aScheduleEdit" data-id="${esc(sc.id)}">
            ${scheduleForm(sc)}
            <div class="full hint">已排好、還沒開打的場次會一起更新。某一週的場地不同，到「場次」改那一場的「第幾場地」。要換星期請停用後新增。</div>
            <div class="full"><button type="submit">儲存</button></div>
          </form></details>` : ''}
        <div class="actions">
          <button class="${sc.active ? 'danger' : ''}" data-act="aScheduleActive" data-id="${esc(sc.id)}" data-active="${sc.active ? '0' : '1'}">${sc.active ? '停用' : '重新啟用'}</button>
        </div>
      </section>`;
    return `
      <section class="card">
        <details ${schedules.length ? '' : 'open'}>
          <summary>＋ 新增每週時段</summary>
          <form class="grid" data-form="aScheduleCreate">
            ${scheduleForm(null)}
            <div class="full hint">建立後會自動排好未來 4 週的場次。</div>
            <div class="full"><button class="primary" type="submit">建立</button></div>
          </form>
        </details>
      </section>
      ${schedules.map(card).join('')}`;
  };

  const scheduleBody = (fd) => ({
    startTime: fd.get('startTime'), endTime: fd.get('endTime'), venue: fd.get('venue'), courtNo: fd.get('courtNo'),
    courts: num(fd, 'courts'), capacity: num(fd, 'capacity'),
  });
  App.forms.aScheduleCreate = async (fd) => {
    await A('/schedules', { weekday: num(fd, 'weekday'), ...scheduleBody(fd) });
    toast('已建立時段並排好場次');
  };
  App.forms.aScheduleEdit = async (fd, d) => {
    const r = await A(`/schedules/${enc(d.id)}`, scheduleBody(fd));
    toast(`已儲存${changesText(r)}`);
  };
  App.actions.aScheduleActive = async (d) => {
    const active = d.active === '1';
    if (!active && !confirm('停用後不再自動排場次。還沒有人報名的未來場次會刪除，確定嗎？')) return;
    const r = await A(`/schedules/${enc(d.id)}/active`, { active });
    toast(active ? '已重新啟用' : `已停用，刪除 ${r.removed} 場${r.kept ? `；${r.kept} 場已有人報名，請到「場次」決定是否取消` : ''}`);
  };

  // ---------- 成員與管理員 ----------

  App.views['a-members'] = async () => {
    const { members } = await A('/members');
    const me = App.state.me.userId;
    const row = (m) => `
      <div class="item">
        <span>${esc(m.external ? m.nickname || m.displayName : memberName(m))} <span class="badge">${m.external ? '非 LINE' : ROLE[m.role]}</span></span>
        <span class="check">
          <button class="small" data-act="aNickname" data-uid="${esc(m.userId)}" data-nick="${esc(m.nickname ?? '')}" data-external="${m.external ? '1' : ''}">暱稱</button>
          ${m.external ? `<button class="small" data-act="aMemberRemove" data-uid="${esc(m.userId)}" data-name="${esc(m.nickname || m.displayName)}">移除</button>` : ''}
          ${isOwner() && m.role !== 'owner' && !m.external ? `<button class="small" data-act="aRole" data-uid="${esc(m.userId)}" data-role="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? '取消管理員' : '設為管理員'}</button>` : ''}
        </span>
      </div>`;
    return `
      <section class="card">
        <h2>成員（${members.length}）</h2>
        <div class="hint">群組裡的人傳過訊息（文字、圖片、貼圖都算）、新加入群組、或打開報名頁，就會自動加入；還沒出現的人，把報名頁連結貼在群組請他點一下。暱稱會用在名單上。不在 LINE 上的人（例如教練）到「季打」加入。${isOwner() ? '' : '只有擁有者可以設定管理員。'}</div>
        <div class="mine">${members.map(row).join('')}</div>
      </section>
      ${isOwner() ? `<section class="card">
        <h2>轉移擁有者</h2>
        <form class="grid" data-form="aTransfer">
          ${field('新的擁有者', `<select name="userId" required><option value="">選擇成員</option>${members.filter((m) => m.userId !== me && !m.external).map((m) => `<option value="${esc(m.userId)}">${esc(memberName(m))}</option>`).join('')}</select>`, true)}
          <div class="full hint">轉移後你會變成管理員。</div>
          <div class="full"><button class="danger" type="submit">轉移</button></div>
        </form>
      </section>` : ''}`;
  };

  Object.assign(App.actions, {
    async aNickname(d) {
      const v = prompt(d.external ? '名單上顯示的名字（留空則用加入時填的名字）' : '名單上顯示的暱稱（留空則用 LINE 名稱）', d.nick);
      if (v === null) return;
      await A(`/members/${enc(d.uid)}/nickname`, { nickname: v });
      toast('已更新暱稱');
    },
    async aMemberRemove(d) {
      if (!confirm(`把 ${d.name} 從成員名單移除？他還沒開打的報名會取消，過去的紀錄會保留。`)) return;
      const r = await A(`/members/${enc(d.uid)}/remove`, {});
      toast(`已移除 ${d.name}${changesText(r)}`);
    },
    async aRole(d) {
      await A(`/members/${enc(d.uid)}/role`, { role: d.role });
      toast(d.role === 'admin' ? '已設為管理員' : '已取消管理員');
    },
  });

  App.forms.aTransfer = async (fd) => {
    const sel = document.querySelector('form[data-form="aTransfer"] select');
    const name = sel?.selectedOptions[0]?.textContent || '';
    if (!confirm(`把擁有者轉給 ${name}？你會變成管理員。`)) return;
    await A('/owner', { userId: fd.get('userId') });
    App.state.me = await api('/me');
    $('subtitle').textContent = { owner: '擁有者', admin: '管理員' }[App.state.me.role] || '';
    toast('已轉移擁有者');
  };

  // ---------- 球團設定 ----------

  /** 開放報名通知要用掉多少推播額度（對群組推播一次 = 群組人數那麼多則）。 */
  function budgetText(b) {
    const cost = b.groupSize ? `群組目前 ${b.groupSize} 人，發一次通知用 ${b.groupSize} 則。` : '發一次通知會用掉和群組人數一樣多的則數。';
    if (b.unlimited) return `${cost}這個官方帳號的方案沒有每月上限。`;
    if (b.limit == null || b.used == null) return `${cost}現在查不到本月的推播額度。`;
    const times = b.groupSize ? `，還夠對群組發 ${Math.floor(Math.max(0, b.limit - b.used) / b.groupSize)} 次` : '';
    return `${cost}本月推播額度已用 ${b.used}／${b.limit} 則${times}。剩不到 2 次的量時不發開放通知，把額度留給遞補通知。`;
  }

  App.views['a-settings'] = async () => {
    const s = await A('/settings');
    // 開放報名通知鎖住時（s.openNotice = false）不出現開關，也不用查推播額度
    const notice = s.openNotice
      ? `<label class="full check"><input type="checkbox" name="notifyOnOpen" ${s.notifyOnOpen ? 'checked' : ''}>開放報名時在群組發通知</label>
          <input type="hidden" name="hasNotifyOnOpen" value="1">
          <div class="full hint">${budgetText(await A('/push-budget'))}</div>`
      : `<div class="full hint">開放報名時不會自動在群組發通知（推播會依群組人數扣每月額度）。場次開放後，請管理員在群組輸入「名單」或「選單」：機器人的回覆不計額度，大家會看到最近一場的名單和報名頁連結。</div>`;
    return `
      <section class="card">
        <form class="grid" data-form="aSettings">
          ${field('球團名稱', input('name', s.name, 'required'), true)}
          ${field('臨打費', `<input type="number" name="casualFee" min="0" value="${s.casualFee}" required>`, true)}
          ${field('女生臨打費（留空 = 和上面相同）', `<input type="number" name="casualFeeFemale" min="0" value="${s.casualFeeFemale ?? ''}">`, true)}
          ${field('球團規則／備註（顯示在報名頁最上面，可留空）', `<textarea name="rules" rows="6" maxlength="1000" placeholder="例如：&#10;1. 臨打費現場收&#10;2. 程度 4–8 級&#10;3. 請準時到場">${esc(s.rules ?? '')}</textarea>`, true)}
          ${field('開打前幾天開放報名', `<input type="number" name="regOpenDaysBefore" min="0" max="30" value="${s.regOpenDaysBefore}" required>`)}
          ${field('當天幾點開放', `<input type="time" name="regOpenTime" value="${esc(s.regOpenTime)}" required>`)}
          ${field('開打前幾分鐘截止報名', `<input type="number" name="regCloseMinutesBefore" min="0" value="${s.regCloseMinutesBefore}" required>`, true)}
          ${field('取消期限：開打前幾分鐘（留空 = 不限制）', `<input type="number" name="cancelDeadlineMinutesBefore" min="0" value="${s.cancelDeadlineMinutesBefore ?? ''}">`, true)}
          <label class="full check"><input type="checkbox" name="ledgerVisible" ${s.ledgerVisible ? 'checked' : ''}>讓季打成員看帳本（只能看，不能新增或刪除）</label>
          <input type="hidden" name="hasLedgerVisible" value="1">
          <div class="full hint">勾選時，季打成員的報名頁會多一個「帳本」分頁，內容和「管理 → 記帳」相同；臨打看不到。取消勾選就只有管理員看得到。</div>
          ${notice}
          <div class="full hint">女生臨打費有填、而且和臨打費不同時，臨打報名會多一個選價錢的步驟；沒選的收上面的臨打費。改了報名規則，還沒開打的場次會重新計算開放與截止時間。</div>
          <div class="full"><button class="primary" type="submit">儲存</button></div>
        </form>
      </section>
      ${isOwner() ? `<section class="card">
        <details>
          <summary style="color:var(--danger)">刪除球團</summary>
          <form class="grid" data-form="aDeleteClub">
            <div class="full hint">會刪除這個球團的所有資料：成員名單、時段、季期與季打名單、場次與報名紀錄、點名收費、記帳、設定，無法復原。刪除後在群組輸入「/綁定 球團名稱」就能建立新的球團。只是想改名的話，改上面的球團名稱就可以，不用刪除。</div>
            ${field(`輸入球團名稱「${esc(s.name)}」確認`, input('confirmName', '', 'required autocomplete="off"'), true)}
            <div class="full"><button class="danger" type="submit">永久刪除這個球團</button></div>
          </form>
        </details>
      </section>` : ''}`;
  };

  App.forms.aDeleteClub = async (fd) => {
    const name = App.state.me.club.name;
    const typed = String(fd.get('confirmName') || '').trim();
    if (typed !== name) throw new Error('輸入的球團名稱不一樣，沒有刪除');
    if (!confirm(`真的要永久刪除「${name}」和它的所有資料嗎？`)) return;
    await A('/delete-club', { confirmName: typed });
    // 球團已經不存在：收起分頁，只留一段說明
    App.state.me = { ...App.state.me, isAdmin: false, role: null };
    $('title').textContent = '球團已刪除';
    $('subtitle').textContent = '';
    App.go('deleted', { name });
  };
  App.views.deleted = async ({ name }) =>
    `<div class="card">「${esc(name)}」已刪除。<br>要重新開始，請在群組輸入「/綁定 球團名稱」，再輸入「選單」開新的報名頁。</div>`;

  App.forms.aSettings = async (fd) => {
    await A('/settings', {
      name: fd.get('name'),
      casualFee: num(fd, 'casualFee'),
      casualFeeFemale: num(fd, 'casualFeeFemale'),
      rules: fd.get('rules'),
      ...(fd.get('hasLedgerVisible') ? { ledgerVisible: !!fd.get('ledgerVisible') } : {}),
      ...(fd.get('hasNotifyOnOpen') ? { notifyOnOpen: !!fd.get('notifyOnOpen') } : {}),
      regOpenDaysBefore: num(fd, 'regOpenDaysBefore'),
      regOpenTime: fd.get('regOpenTime'),
      regCloseMinutesBefore: num(fd, 'regCloseMinutesBefore'),
      cancelDeadlineMinutesBefore: num(fd, 'cancelDeadlineMinutesBefore'),
    });
    App.state.me = await api('/me');
    $('title').textContent = App.state.me.club.name;
    toast('已儲存設定');
  };

  // 管理的每個分頁最下面，和報名頁一樣放一個不顯眼的「意見回饋」連結（只寄給開發者，這裡看不到別人寫的）
  for (const { view } of App.subtabs['a-sessions']) {
    const page = App.views[view];
    App.views[view] = async (p) => `${await page(p)}${feedbackLink(view)}`;
  }
})();
