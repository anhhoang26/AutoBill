/**
 * Background Service Worker - AutoBill Messenger v5.5
 *
 * Flow theo Pancake v2 (0.5.41) InboxBusiness:
 *  - Context từ business.facebook.com/latest/inbox/all?asset_id=pageId
 *  - LSD từ MRequestConfig block (JSON.parse)
 *  - SiteData fully parsed → buildParams đầy đủ: __rev, __hsi, __hs, __pc, dpr, __beoa,
 *    __comet_req, __csr, __ccg, __s (giống Pancake buildParams)
 *  - Direct fetch từ service worker (Pancake cũng làm vậy, không cần tab)
 *  - declarativeNetRequest fix Origin header
 */

// ── declarativeNetRequest ──────────────────────────────────────────────────────

const RES_TYPES = ["main_frame", "sub_frame", "xmlhttprequest", "other"];

const NET_RULES = [
  {
    id: 1, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: "https://www.facebook.com" }] },
    condition: { requestDomains: ["www.facebook.com", "upload.facebook.com"], resourceTypes: RES_TYPES },
  },
  {
    id: 2, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: "https://business.facebook.com" }] },
    condition: { requestDomains: ["business.facebook.com", "upload-business.facebook.com"], resourceTypes: RES_TYPES },
  },
  {
    id: 3, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: "https://business.facebook.com" }] },
    condition: { requestDomains: ["graph.facebook.com"], resourceTypes: RES_TYPES },
  },
];

async function setupNetRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: NET_RULES,
  });
  console.log("[AutoBill:bg] declarativeNetRequest rules set");
}

// ── Offscreen keepalive ────────────────────────────────────────────────────────

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "WebSocket connection to AutoBill server",
  });
  console.log("[AutoBill:bg] Offscreen created");
}

// ── Storage helpers ────────────────────────────────────────────────────────────

const store = {
  get: (key) => chrome.storage.local.get(key).then((r) => r[key]),
  set: (key, val) => chrome.storage.local.set({ [key]: val }),
};

// ── doc_id registry ────────────────────────────────────────────────────────────

const DOC_ID_KEY = "AutoBill_docIdsMap";
const DOC_ID_TTL = 18 * 60 * 60 * 1000;

let _docIds = {};

async function loadDocIds() {
  const raw = await store.get(DOC_ID_KEY);
  if (!raw) return;
  try {
    const now = Date.now();
    const map = JSON.parse(raw);
    for (const [name, entry] of Object.entries(map)) {
      if (now - entry.ts < DOC_ID_TTL) _docIds[name] = entry.id;
    }
    console.log(`[AutoBill:bg] Loaded ${Object.keys(_docIds).length} cached doc_ids`);
  } catch (_) {}
}

async function saveDocIds() {
  const now = Date.now();
  const map = {};
  for (const [name, id] of Object.entries(_docIds)) map[name] = { id, ts: now };
  await store.set(DOC_ID_KEY, JSON.stringify(map));
}

function searchDocIds(text) {
  let found = false;
  for (const m of text.matchAll(/operationKind:"[^"]*",name:"([^"]+)",id:"(\d+)"/g))
    if (!_docIds[m[1]]) { _docIds[m[1]] = m[2]; found = true; }
  for (const m of text.matchAll(/id:"(\d+)",[^"]{0,60}name:"([^"]+)"/g))
    if (!_docIds[m[2]]) { _docIds[m[2]] = m[1]; found = true; }
  for (const m of text.matchAll(/__d\("([^"]+)_facebookRelayOperation"[^)]*\)[^"]*"(\d+)"/g))
    if (!_docIds[m[1]]) { _docIds[m[1]] = m[2]; found = true; }
  for (const m of text.matchAll(/__d\("([^"]+)"[^)]*\).+?__getDocID=function\(\)\{return"(\d+)"/g))
    if (!_docIds[m[1]]) { _docIds[m[1]] = m[2]; found = true; }
  return found;
}

// ── Facebook Context (theo Pancake InboxBusiness) ─────────────────────────────

let _fbDtsg = null;
let _fbUserId = null;
let _lsd = "";
let _msgrRegion = "PRN";
let _sprinkleParamName = "jazoest";
let _sprinkleVersion = 2;
let _siteData = {};
let _reqCount = 0;
let _lastPageId = null;           // page_id đã dùng để fetch context
// Pancake webSession.getId() format: sessionId:activityId:tabId
const _webSessionId = Math.floor(Math.random()*1e9).toString(36).slice(0,6) + ":" +
  Math.floor(Math.random()*1e9).toString(36).slice(0,6) + ":" +
  Math.floor(Math.random()*Math.pow(36,6)).toString(36).padStart(6,"0");

function _clearFbContext() {
  _fbDtsg = null; _fbUserId = null; _lsd = "";
  _siteData = {};
}

async function ensureFbContext(pageId, forceRefresh = false) {
  if (_fbDtsg && !forceRefresh) return;
  if (forceRefresh) _clearFbContext();

  // Pancake InboxBusiness: fetch business.facebook.com/latest/inbox/all?asset_id=...
  const url = `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}`;
  console.log(`[AutoBill:bg] Fetching context: ${url}`);
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`Context fetch ${resp.status}`);
  const html = await resp.text();

  // fb_dtsg — Pancake pattern: "DTSGInitialData",[],{"token":"..."}
  for (const pat of [
    /"DTSGInitialData",\[\],\{"token":"([^"]+)"/i,
    /"DTSGInitData",\[\],\{"token":"([^"]+)"/i,
    /name="fb_dtsg" value="([^"]+)"/,
    /"token":"([^"]+)","ttl":\d+/,
    /"name":"fb_dtsg","value":"([^"]+)"/,
  ]) {
    const m = html.match(pat);
    if (m) { _fbDtsg = m[1]; break; }
  }
  if (!_fbDtsg) {
    const m = html.match(/"dtsg":\{"token":"([^"]+)"/);
    if (m) _fbDtsg = m[1];
  }
  if (!_fbDtsg) throw new Error("Cannot extract fb_dtsg - are you logged in?");

  // userId — dùng c_user cookie là nguồn chính xác nhất (logged-in admin ID)
  // HTML regex có thể match nhầm PSID của customer trong inbox
  try {
    const cUser = await chrome.cookies.get({ url: "https://www.facebook.com", name: "c_user" });
    if (cUser?.value) _fbUserId = cUser.value;
  } catch (_) {}
  if (!_fbUserId) {
    const userIdM = html.match(/,"userID":"(\d+)"/) || html.match(/"USER_ID":"(\d+)"/i);
    if (userIdM) _fbUserId = userIdM[1];
  }

  // LSD token — Pancake: ["MRequestConfig",[],{...},N].token (dùng eval, ta dùng JSON.parse)
  const mrcM = html.match(/\["MRequestConfig",\[\],([^\]]+),\d+\]/);
  if (mrcM) {
    try { _lsd = JSON.parse(mrcM[1])?.token || ""; } catch (_) {}
  }
  if (!_lsd) {
    const lsdM = html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/);
    if (lsdM) _lsd = lsdM[1];
  }

  // SprinkleConfig
  const sprinkleM = html.match(/\["SprinkleConfig",\[\],\{"param_name":"([^"]+)","version":(\d+)/);
  if (sprinkleM) {
    _sprinkleParamName = sprinkleM[1];
    _sprinkleVersion = parseInt(sprinkleM[2], 10);
  }

  // jazoest v2 = "2" + sum(charCodes of dtsg)
  let ttstamp = "2";
  for (let i = 0; i < _fbDtsg.length; i++) ttstamp += _fbDtsg.charCodeAt(i);

  // SiteData — Pancake dùng eval, ta dùng JSON.parse
  // Fields dùng trong buildParams: client_revision, pkg_cohort, pr, hsi, haste_session,
  //   be_one_ahead, is_comet, spin, __spin_r, __spin_b, __spin_t, force_blue
  let sd = {};
  const sdM = html.match(/\["SiteData",\[\],([^\]]+),\d+\]/);
  if (sdM) { try { sd = JSON.parse(sdM[1]); } catch (_) {} }

  // WebConnectionClassServerGuess → __ccg
  let ccg = "EXCELLENT";
  const wccM = html.match(/\["WebConnectionClassServerGuess",\[\],([^\]]+),\d+\]/);
  if (wccM) { try { ccg = JSON.parse(wccM[1])?.connectionClass || ccg; } catch (_) {} }

  // msgrRegion
  const mrcConfM = html.match(/\["MercuryServerRequestsConfig",\[\],\{"msgrRegion":"([^"]+)"\}/);
  if (mrcConfM) _msgrRegion = mrcConfM[1];
  else {
    const rmM = html.match(/"(?:regionNullable|msgrRegion)":"(\w+)"/);
    if (rmM) _msgrRegion = rmM[1];
  }

  const clientRevision = sd.client_revision ? String(sd.client_revision)
    : (html.match(/client_revision":(\d+)/)?.[1] || "");

  // Pancake buildParams() đầy đủ (tất cả fields khi SiteData có)
  _siteData = {
    __csr:       "",
    __beoa:      sd.be_one_ahead ? 1 : 0,
    __pc:        sd.pkg_cohort || "",
    dpr:         String(sd.pr || 1),
    __ccg:       ccg,
    __rev:       clientRevision,
    __hsi:       sd.hsi ? String(sd.hsi) : "",
    __hs:        sd.haste_session || "",
    __comet_req: sd.is_comet ? 1 : 1, // business.facebook.com luôn là comet
    __spin_r:    sd.__spin_r ? String(sd.__spin_r) : clientRevision,
    __spin_b:    sd.__spin_b || "trunk",
    __spin_t:    sd.__spin_t ? String(sd.__spin_t) : "1514187418",
    __s:         _webSessionId,
    jazoest:     ttstamp,
  };

  _lastPageId = pageId;
  console.log(`[AutoBill:bg] dtsg=${_fbDtsg.slice(0,8)}... lsd=${_lsd ? _lsd.slice(0,6)+"..." : "MISSING"} region=${_msgrRegion} rev=${clientRevision} comet=${sd.is_comet?1:0} hsi=${sd.hsi?"ok":"MISS"}`);

  searchDocIds(html);
  await saveDocIds();
}

// ── Resolve threadId → PSID ────────────────────────────────────────────────────

const _recipientCache = {};

async function resolveRecipientId(threadId, pageId) {
  if (_recipientCache[threadId]) return _recipientCache[threadId];

  // Method 1: GraphQL PagesManagerInboxAdminAssignerRootQuery (giống Pancake primary)
  const QUERY = "PagesManagerInboxAdminAssignerRootQuery";
  const docId = _docIds[QUERY];

  if (docId) {
    try {
      console.log(`[AutoBill:bg] GraphQL resolve: thread=${threadId} docId=${docId}`);
      const r = await fetch("https://business.facebook.com/api/graphql/", {
        method: "POST",
        body: buildBody({
          av: pageId,
          __user: _fbUserId || "",
          __a: "1",
          __req: (_reqCount++).toString(36),
          fb_dtsg: _fbDtsg,
          ..._siteData,
          doc_id: docId,
          variables: JSON.stringify({ pageID: pageId, commItemID: threadId }),
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: QUERY,
        }),
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}`,
        },
      });

      const text = await r.text();
      console.log(`[AutoBill:bg] GraphQL ${r.status}: ${text.slice(0, 500)}`);

      const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ""));
      const globalId = json?.data?.commItem?.target_id;

      if (globalId && globalId !== pageId && globalId !== _fbUserId) {
        console.log(`[AutoBill:bg] GraphQL resolved: ${threadId} → ${globalId}`);
        _recipientCache[threadId] = globalId;
        return globalId;
      }
    } catch (e) {
      console.warn(`[AutoBill:bg] GraphQL resolve error: ${e.message}`);
    }
  } else {
    console.warn(`[AutoBill:bg] ${QUERY} doc_id not found (${Object.keys(_docIds).length} total), trying HTML fallback`);
  }

  // Method 2: HTML parsing fallback (conversation page)
  try {
    const url = `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}&selected_item_id=${threadId}`;
    const r = await fetch(url, { credentials: "include" });
    const html = await r.text();
    console.log(`[AutoBill:bg] Conv page ${r.status}, length=${html.length}`);

    searchDocIds(html);
    if (searchDocIds(html)) await saveDocIds();

    // Log tất cả matches để debug
    const allOtherUser = [...html.matchAll(/"other_user_fbid":"(\d+)"/g)].map(m => m[1]);
    const allTargetId = [...html.matchAll(/"target_id":"(\d+)"/g)].map(m => m[1]);
    console.log(`[AutoBill:bg] HTML matches: other_user_fbid=[${allOtherUser}] target_id=[${allTargetId}]`);

    for (const pat of [
      /"other_user_fbid":"(\d+)"/,
      /"target_id":"(\d+)"/,
    ]) {
      const m = html.match(pat);
      if (m && m[1] !== pageId && m[1] !== _fbUserId) {
        console.log(`[AutoBill:bg] HTML resolved: ${threadId} → ${m[1]}`);
        _recipientCache[threadId] = m[1];
        return m[1];
      }
    }
  } catch (e) {
    console.warn(`[AutoBill:bg] Conv page error: ${e.message}`);
  }

  console.warn(`[AutoBill:bg] PSID not resolved, using threadId as-is: ${threadId}`);
  return threadId;
}

// ── Upload image ───────────────────────────────────────────────────────────────

async function uploadImage(base64Data, pageId) {
  const blob = base64ToBlob(base64Data);
  const form = new FormData();
  form.append("upload_1024", blob, "bill.png");

  const params = new URLSearchParams({
    __user: _fbUserId || "0",
    __a: "1",
    fb_dtsg: _fbDtsg,
    ...(pageId ? { request_user_id: pageId } : {}),
  });

  const r = await fetch(
    `https://upload-business.facebook.com/ajax/mercury/upload.php?${params}`,
    { method: "POST", body: form, credentials: "include" }
  );

  const text = await r.text();
  const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ""));
  const meta = json?.payload?.metadata?.[0];
  if (!meta) throw new Error("Upload failed: " + text.slice(0, 200));
  const id = meta.image_id || meta.fbid;
  console.log(`[AutoBill:bg] Uploaded image id=${id}`);
  return id;
}

// ── Send message (Pancake buildSendParams + buildParams) ──────────────────────

function generateOfflineThreadingId() {
  const eBin = Date.now().toString(2);
  const tBin = ("0000000000000000000000" + (Math.floor(4294967296 * Math.random()) >>> 0).toString(2)).slice(-22);
  const bits = (eBin + tBin).slice(-63);
  let n = BigInt(0);
  for (let i = 0; i < bits.length; i++) n = n * 2n + BigInt(+bits[i]);
  return n.toString();
}

async function sendMessage(recipientId, text, attachmentId, pageId) {
  const tid = generateOfflineThreadingId();

  // Thứ tự giống Pancake:
  // 1. buildSendParams: body, offline_threading_id, source, timestamp, request_user_id
  // 2. Object.assign với buildParams(): __user, __a, __req, SiteData fields, fb_dtsg, lsd, jazoest
  // 3. Facebook-specific: specific_to_list, other_user_fbid, message_id, client, action_type, ...
  // 4. __usid: null (generateUsid trả null)
  const body = buildBody({
    // buildSendParams
    body: text || "",
    offline_threading_id: tid,
    source: "source:page_unified_inbox",
    timestamp: String(Date.now()),
    request_user_id: pageId,
    // buildParams() — đầy đủ như Pancake
    __user: _fbUserId || "",
    __a: "1",
    __req: (_reqCount++).toString(36),
    ..._siteData,                           // __csr,__beoa,__pc,dpr,__ccg,__rev,__hsi,__hs,__comet_req,__spin_*,__s,jazoest
    fb_dtsg: _fbDtsg,
    [_sprinkleParamName]: _siteData.jazoest,
    lsd: _lsd,
    // facebook-specific (sau buildParams)
    "specific_to_list[0]": `fbid:${recipientId}`,
    "specific_to_list[1]": `fbid:${pageId}`,
    other_user_fbid: recipientId,
    message_id: tid,
    client: "mercury",
    action_type: "ma-type:user-generated-message",
    ephemeral_ttl_mode: "0",
    has_attachment: attachmentId ? "true" : "false",
    ...(attachmentId ? { "image_ids[0]": attachmentId } : {}),
    __usid: "",
  });
  console.log(`[AutoBill:bg] send params: user=${_fbUserId} page=${pageId} recipient=${recipientId} rev=${_siteData.__rev} comet=${_siteData.__comet_req}`);

  const r = await fetch("https://business.facebook.com/messaging/send/", {
    method: "POST",
    body,
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      "x-response-format": "JSONStream",
      "x-msgr-region": _msgrRegion,
    },
  });

  const resText = await r.text();
  console.log(`[AutoBill:bg] messaging/send ${r.status}: ${resText.slice(0, 400)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const json = JSON.parse(resText.replace(/^for\s*\(;;\);/, ""));
  if (json.error) {
    console.error("[AutoBill:bg] FB error:", JSON.stringify(json));
    throw new Error(`FB error: ${JSON.stringify(json.error)}`);
  }
  return { success: true };
}

// ── Main send handler ──────────────────────────────────────────────────────────

async function handleSendMessage({ conversation_id, message, image_base64, page_id }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureFbContext(page_id, /* forceRefresh */ attempt > 0);
      const recipientId = await resolveRecipientId(conversation_id, page_id);
      let attachmentId = null;
      if (image_base64) attachmentId = await uploadImage(image_base64, page_id);
      return await sendMessage(recipientId, message, attachmentId, page_id);
    } catch (e) {
      const isTokenError = /dtsg|logged|auth|session|1357004/i.test(e.message);
      if (isTokenError && attempt === 0) {
        console.warn("[AutoBill:bg] Token error, refreshing context and retrying...", e.message);
        _clearFbContext();
        continue;
      }
      console.error("[AutoBill:bg] Error:", e.message);
      return { success: false, error: e.message };
    }
  }
}

// ── Utils ──────────────────────────────────────────────────────────────────────

function buildBody(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function base64ToBlob(b64) {
  let data = b64, mime = "image/png";
  if (b64.startsWith("data:")) {
    [, data] = b64.split(",");
    mime = b64.match(/:(.*?);/)[1];
  }
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

// ── Message listener ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "fb_send") {
    handleSendMessage(msg.payload).then(sendResponse);
    return true;
  }
  if (msg.type === "fb_reset") {
    _clearFbContext();
    sendResponse({ ok: true });
  }
  if (msg.type === "get_status") {
    chrome.runtime.sendMessage({ type: "ws_get_status" })
      .then((r) => sendResponse({ connected: r?.connected ?? false }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }
  if (msg.type === "reconnect") {
    chrome.runtime.sendMessage({ type: "ws_reconnect" })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === "doc_ids_from_page") {
    const added = [];
    for (const [name, id] of Object.entries(msg.docIds || {})) {
      if (!_docIds[name]) { _docIds[name] = id; added.push(name); }
    }
    if (added.length > 0) {
      saveDocIds();
      console.log(`[AutoBill:bg] +${added.length} doc_ids from page, total=${Object.keys(_docIds).length}`);
    }
    sendResponse({ ok: true });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────────

setupNetRules();
loadDocIds();

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") ensureOffscreen();
});

ensureOffscreen();
console.log("[AutoBill:bg] Service worker started v5.5.0");
