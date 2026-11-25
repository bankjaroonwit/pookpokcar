/* ============================================================
   ปุกป็อก Telegram Bot — Cloudflare Worker
   - ส่งรูป/ข้อความเข้าแชท = จดที่จอด (การ์ดถูกปักหมุดไว้บนสุด)
   - ปุ่มเลือกชั้น / ทางออก, ส่งตำแหน่ง GPS, /where, เจอรถแล้ว
   ข้อมูลเก็บใน Workers KV (key: p:<chatId>), เจ้าของบอทคือคนแรกที่กด /start
   ============================================================ */

const BOT_VERSION = '1.0.0';

const FLOORS = ['B3', 'B2', 'B1', 'G', '1', '2', '3', '4'];
const EXITS = {
  lift:      { icon: '🛗', label: 'ลิฟต์' },
  escalator: { icon: '↗️', label: 'บันไดเลื่อน' },
  stairs:    { icon: '🪜', label: 'บันได' },
  door:      { icon: '🚪', label: 'ประตู' }
};
// คำที่ใช้เดาทางออกจากข้อความ (เรียงคำยาวก่อน)
const EXIT_WORDS = [
  ['บันไดเลื่อน', 'escalator'], ['escalator', 'escalator'],
  ['ลิฟต์', 'lift'], ['ลิฟท์', 'lift'], ['lift', 'lift'],
  ['บันได', 'stairs'], ['stairs', 'stairs'],
  ['ประตู', 'door'], ['door', 'door']
];
const MAX_PHOTOS = 3;
const APPEND_WINDOW_MS = 30 * 60 * 1000; // รูปที่ส่งภายใน 30 นาที = รูปเพิ่มของที่จอดเดิม

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🚗 รถอยู่ไหน' }, { text: '📍 ส่งตำแหน่งตอนนี้', request_location: true }],
    [{ text: '✅ เจอรถแล้ว' }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

/* ---------- Telegram API ---------- */
async function tg(env, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (!json.ok) console.warn(method, json.description);
  return json;
}

// secret ของ webhook สร้างจาก token เอง (ไม่ต้องตั้งค่าเพิ่ม)
async function webhookSecret(env) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pookpok:' + env.BOT_TOKEN));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

/* ---------- Worker entry ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.BOT_TOKEN) return new Response('BOT_TOKEN ยังไม่ได้ตั้งค่า', { status: 500 });

    // เปิดลิงก์นี้ครั้งเดียวหลัง deploy เพื่อผูก webhook กับ Telegram
    if (req.method === 'GET' && url.pathname === '/setup') {
      const hook = await tg(env, 'setWebhook', {
        url: `${url.origin}/webhook`,
        secret_token: await webhookSecret(env),
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true
      });
      await tg(env, 'setMyCommands', {
        commands: [
          { command: 'where', description: 'รถอยู่ไหน' },
          { command: 'done', description: 'เจอรถแล้ว (ล้างข้อมูล)' },
          { command: 'help', description: 'วิธีใช้' }
        ]
      });
      const me = await tg(env, 'getMe', {});
      return Response.json({ webhook: hook, bot: me.result && me.result.username, version: BOT_VERSION });
    }

    if (req.method === 'POST' && url.pathname === '/webhook') {
      if (req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== await webhookSecret(env)) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await req.json();
      try { await handleUpdate(update, env); } catch (e) { console.error(e && e.stack || e); }
      return new Response('ok');
    }

    return new Response(`ปุกป็อก bot v${BOT_VERSION}`);
  }
};

/* ---------- Owner (ใช้คนเดียว) ---------- */
async function checkOwner(env, chatId, claim) {
  const owner = await env.KV.get('owner');
  if (owner) return owner === String(chatId);
  if (claim) { await env.KV.put('owner', String(chatId)); return true; }
  return false;
}

/* ---------- State ---------- */
const stateKey = (chatId) => `p:${chatId}`;
async function loadState(env, chatId) {
  const raw = await env.KV.get(stateKey(chatId));
  return raw ? JSON.parse(raw) : null;
}
const saveState = (env, chatId, s) => env.KV.put(stateKey(chatId), JSON.stringify(s));
const clearState = (env, chatId) => env.KV.delete(stateKey(chatId));

function newState() {
  return { floor: '', zone: '', exit: '', exitNote: '', note: '', photos: [], gps: null, savedAt: Date.now(),
           cardId: null, cardType: null, cardPhoto: null };
}

/* ---------- แยกชั้น/โซน/ทางออก จากข้อความ ---------- */
function parseText(text) {
  const out = {};
  let s = ` ${text.trim()} `;
  for (const [w, id] of EXIT_WORDS) {
    const re = new RegExp(w, 'i');
    if (re.test(s)) { out.exit = id; s = s.replace(re, ' '); break; }
  }
  s = s.replace(/ชั้น\s*/g, ' ชั้น:').replace(/(โซน|เสา)\s*/g, ' โซน:');
  const rest = [];
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    const T = tok.toUpperCase();
    let m;
    if ((m = T.match(/^ชั้น:(.+)$/))) { out.floor = m[1]; continue; }
    if ((m = T.match(/^โซน:(.+)$/))) { out.zone = m[1].replace('-', ''); continue; }
    if (!out.floor && /^(B\d{1,2}|G|M|LG|UG|P\d{1,2}|\d{1,2})$/.test(T)) { out.floor = T; continue; }
    if (!out.zone && /^[A-Z]{1,2}-?\d{1,3}$/.test(T)) { out.zone = T.replace('-', ''); continue; }
    if (T === 'ชั้น:' || T === 'โซน:') continue;
    rest.push(tok);
  }
  const r = rest.join(' ').trim();
  if (r) { if (/^(ฝั่ง|ทาง|ใกล้|ตรง)/.test(r)) out.exitNote = r; else out.note = r; }
  return out;
}

/* ---------- การ์ดที่จอด ---------- */
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtTime(ts) {
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: 'Asia/Bangkok', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'
  }).format(new Date(ts));
}

function cardText(s) {
  const lines = [`🅿️ <b>จอดอยู่</b> · ${esc(fmtTime(s.savedAt))}`, ''];
  let n = 0;
  const num = () => ['①', '②', '③', '④'][n++] || '•';
  const ex = EXITS[s.exit];
  const exitText = [ex && ex.label, s.exitNote].filter(Boolean).join(' · ');
  if (exitText) lines.push(`${num()} ${ex ? ex.icon : '🚶'} กลับทางเดิม: <b>${esc(exitText)}</b>`);
  lines.push(`${num()} ⬇️ ชั้น: ${s.floor ? `<b>${esc(s.floor)}</b>` : '<i>ยังไม่ระบุ</i>'}`);
  lines.push(`${num()} 🔎 โซน/เสา: ${s.zone ? `<b>${esc(s.zone)}</b>` : '<i>ยังไม่ระบุ</i>'}`);
  if (s.note) lines.push(`📝 ${esc(s.note)}`);
  if (s.gps) lines.push(`📍 มีพิกัด GPS${s.gps.acc ? ` (±${s.gps.acc} ม.)` : ''}`);
  if (s.photos.length) lines.push(`📷 รูป ${s.photos.length}/${MAX_PHOTOS}`);

  const hints = [];
  if (!s.zone) hints.push('พิมพ์โซน เช่น C4');
  if (!s.floor) hints.push('กดเลือกชั้นด้านล่าง');
  if (s.photos.length < MAX_PHOTOS) hints.push('ส่งรูปเพิ่มได้');
  if (hints.length) lines.push('', `<i>💡 ${hints.join(' · ')}</i>`);
  return lines.join('\n');
}

function cardKeyboard(s) {
  const mark = (on, t) => (on ? `✅ ${t}` : t);
  const rows = [
    FLOORS.slice(0, 4).map((f) => ({ text: mark(s.floor === f, f), callback_data: `f:${f}` })),
    FLOORS.slice(4).map((f) => ({ text: mark(s.floor === f, f), callback_data: `f:${f}` })),
    Object.entries(EXITS).map(([id, x]) => ({ text: s.exit === id ? `✅ ${x.label}` : `${x.icon} ${x.label}`, callback_data: `e:${id}` }))
  ];
  const extra = [];
  if (s.gps) extra.push({ text: '🧭 นำทาง', url: `https://www.google.com/maps/dir/?api=1&destination=${s.gps.lat},${s.gps.lng}&travelmode=walking` });
  if (s.photos.length > 1) extra.push({ text: `📷 ดูรูปทั้งหมด (${s.photos.length})`, callback_data: 'photos' });
  if (extra.length) rows.push(extra);
  rows.push([{ text: '✅ เจอรถแล้ว', callback_data: 'done?' }]);
  return { inline_keyboard: rows };
}

// แก้การ์ดเดิมถ้าทำได้ ไม่งั้นส่งใหม่ + ปักหมุด
async function renderCard(env, chatId, s, { resend = false } = {}) {
  const hasPhoto = s.photos.length > 0;
  const type = hasPhoto ? 'photo' : 'text';
  const text = cardText(s);
  const reply_markup = cardKeyboard(s);

  if (s.cardId && !resend && s.cardType === type) {
    let r;
    if (hasPhoto && s.cardPhoto !== s.photos[0]) {
      r = await tg(env, 'editMessageMedia', {
        chat_id: chatId, message_id: s.cardId, reply_markup,
        media: { type: 'photo', media: s.photos[0], caption: text, parse_mode: 'HTML' }
      });
      if (r.ok) s.cardPhoto = s.photos[0];
    } else if (hasPhoto) {
      r = await tg(env, 'editMessageCaption', { chat_id: chatId, message_id: s.cardId, caption: text, parse_mode: 'HTML', reply_markup });
    } else {
      r = await tg(env, 'editMessageText', { chat_id: chatId, message_id: s.cardId, text, parse_mode: 'HTML', reply_markup });
    }
    if (r.ok || /not modified/i.test(r.description || '')) return;
  }

  if (s.cardId) await tg(env, 'deleteMessage', { chat_id: chatId, message_id: s.cardId });
  const r = hasPhoto
    ? await tg(env, 'sendPhoto', { chat_id: chatId, photo: s.photos[0], caption: text, parse_mode: 'HTML', reply_markup })
    : await tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup });
  if (r.ok) {
    s.cardId = r.result.message_id;
    s.cardType = type;
    s.cardPhoto = s.photos[0] || null;
    await tg(env, 'unpinAllChatMessages', { chat_id: chatId });
    await tg(env, 'pinChatMessage', { chat_id: chatId, message_id: s.cardId, disable_notification: true });
  }
}

/* ---------- Actions ---------- */
const HELP = [
  '🅿️ <b>ปุกป็อก — จำที่จอดรถ</b>',
  '',
  '📷 <b>ส่งรูป</b>ป้ายเสา / รถ = จดที่จอด (ใส่ข้อความใต้รูปได้ เช่น <code>B2 C4 ลิฟต์ ฝั่งโรงหนัง</code>)',
  '⌨️ หรือ<b>พิมพ์</b> <code>B2 C4</code> เฉยๆ ก็ได้',
  '🔘 กดเลือกชั้น / ทางออกจากปุ่มใต้การ์ด',
  '📍 กด <b>ส่งตำแหน่งตอนนี้</b> ถ้าจอดกลางแจ้ง จะมีปุ่มนำทางให้',
  '🚗 <b>รถอยู่ไหน</b> = ดึงการ์ดล่าสุดกลับมา (การ์ดถูกปักหมุดไว้บนสุดด้วย)',
  '✅ <b>เจอรถแล้ว</b> = ล้างข้อมูล'
].join('\n');

async function sendWhere(env, chatId) {
  const s = await loadState(env, chatId);
  if (!s) return tg(env, 'sendMessage', { chat_id: chatId, text: 'ยังไม่ได้จดที่จอดเลย 🙂\nส่งรูปหรือพิมพ์ เช่น B2 C4 ได้เลย', reply_markup: MAIN_KEYBOARD });
  await renderCard(env, chatId, s, { resend: true });
  await saveState(env, chatId, s);
}

function askDone(env, chatId) {
  return tg(env, 'sendMessage', {
    chat_id: chatId, text: 'เจอรถแล้วใช่ไหม? 🚗\nข้อมูลที่จอดจะถูกล้าง',
    reply_markup: { inline_keyboard: [[{ text: '✅ ใช่ ล้างข้อมูล', callback_data: 'done!' }, { text: 'ยังไม่เจอ', callback_data: 'cancel' }]] }
  });
}

async function doDone(env, chatId) {
  const s = await loadState(env, chatId);
  if (s && s.cardId) {
    const done = `✅ <s>จอดอยู่</s> · เจอรถแล้ว\n${[s.floor && `ชั้น ${esc(s.floor)}`, s.zone && `โซน ${esc(s.zone)}`].filter(Boolean).join(' · ')}`;
    const method = s.cardType === 'photo' ? 'editMessageCaption' : 'editMessageText';
    const field = s.cardType === 'photo' ? 'caption' : 'text';
    await tg(env, method, { chat_id: chatId, message_id: s.cardId, [field]: done, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  }
  await tg(env, 'unpinAllChatMessages', { chat_id: chatId });
  await clearState(env, chatId);
}

/* ---------- Update handler ---------- */
async function handleUpdate(update, env) {
  if (update.callback_query) return handleCallback(update.callback_query, env);
  const m = update.message;
  if (!m || !m.chat || m.chat.type !== 'private') return;
  const chatId = m.chat.id;
  const text = (m.text || m.caption || '').trim();

  if (/^\/start\b/.test(text)) {
    if (!(await checkOwner(env, chatId, true))) {
      return tg(env, 'sendMessage', { chat_id: chatId, text: 'ขอโทษครับ บอทนี้เป็นบอทส่วนตัว 🙏' });
    }
    return tg(env, 'sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD });
  }
  if (!(await checkOwner(env, chatId, false))) return;

  if (/^\/help\b/.test(text)) return tg(env, 'sendMessage', { chat_id: chatId, text: HELP, parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD });
  if (/^\/where\b/.test(text) || text.includes('รถอยู่ไหน')) return sendWhere(env, chatId);
  if (/^\/done\b/.test(text) || text.includes('เจอรถแล้ว')) return askDone(env, chatId);
  if (text.startsWith('/')) return;

  let s = await loadState(env, chatId);
  let fresh = false;
  const recent = s && Date.now() - (s.lastPhotoAt || s.savedAt) < APPEND_WINDOW_MS;

  if (m.photo) {
    const fileId = m.photo[m.photo.length - 1].file_id;
    if (s && recent && s.photos.length < MAX_PHOTOS) {
      s.photos.push(fileId);
    } else if (s && recent) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: `ใส่รูปได้สูงสุด ${MAX_PHOTOS} รูปต่อที่จอด\nถ้าจอดที่ใหม่ กด ✅ เจอรถแล้ว ก่อนนะ` });
      return;
    } else {
      s = newState(); fresh = true;
      s.photos.push(fileId);
    }
    s.lastPhotoAt = Date.now();
  } else if (m.location) {
    if (!s) { s = newState(); fresh = true; }
    s.gps = { lat: +m.location.latitude.toFixed(6), lng: +m.location.longitude.toFixed(6),
              acc: m.location.horizontal_accuracy ? Math.round(m.location.horizontal_accuracy) : null };
  } else if (!text) {
    return;
  }

  if (text) {
    if (!s) { s = newState(); fresh = true; }
    const p = parseText(text);
    Object.assign(s, p);
  }

  // ข้อความใหม่จากผู้ใช้ → ส่งการ์ดใหม่ไว้ล่างสุดให้เห็นทันที
  await renderCard(env, chatId, s, { resend: true });
  await saveState(env, chatId, s);
}

async function handleCallback(cq, env) {
  const chatId = cq.message && cq.message.chat.id;
  const answer = (text) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text });
  if (!chatId || !(await checkOwner(env, chatId, false))) return answer('บอทส่วนตัว');

  const data = cq.data || '';
  if (data === 'done?') { await askDone(env, chatId); return answer(); }
  if (data === 'cancel') {
    await tg(env, 'deleteMessage', { chat_id: chatId, message_id: cq.message.message_id });
    return answer('โอเค ยังจดไว้เหมือนเดิม');
  }
  if (data === 'done!') {
    await doDone(env, chatId);
    await tg(env, 'editMessageText', { chat_id: chatId, message_id: cq.message.message_id, text: '👋 ล้างข้อมูลแล้ว ขับรถปลอดภัยนะ' });
    return answer('ล้างข้อมูลแล้ว');
  }

  const s = await loadState(env, chatId);
  if (!s) return answer('ไม่มีข้อมูลที่จอดแล้ว');

  if (data === 'photos') {
    await tg(env, 'sendMediaGroup', { chat_id: chatId, media: s.photos.map((p) => ({ type: 'photo', media: p })) });
    return answer();
  }
  if (data.startsWith('f:')) { const f = data.slice(2); s.floor = s.floor === f ? '' : f; }
  else if (data.startsWith('e:')) { const e = data.slice(2); s.exit = s.exit === e ? '' : e; }
  else return answer();

  await renderCard(env, chatId, s);
  await saveState(env, chatId, s);
  return answer();
}

// สำหรับทดสอบ
export { parseText, cardText, cardKeyboard };
