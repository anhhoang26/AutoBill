/**
 * Background Service Worker - AutoBill Messenger v5.1
 *
 * Giống Pancake v2:
 *  - declarativeNetRequest để fix Origin header
 *  - Tất cả FB API logic chạy ở đây (fetch, GraphQL, messaging/send)
 *  - doc_ids cache trong chrome.storage.local (5h expiry, giống Pancake)
 *  - Nhận lệnh từ offscreen document qua chrome.runtime.sendMessage
 */

// ── declarativeNetRequest ──────────────────────────────────────────────────────

const NET_RULES = [
  {
    id: 1, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: "https://www.facebook.com" }] },
    condition: { requestDomains: ["www.facebook.com", "upload.facebook.com"], resourceTypes: ["xmlhttprequest"] },
  },
  {
    id: 2, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: "https://business.facebook.com" }] },
    condition: { requestDomains: ["business.facebook.com", "upload-business.facebook.com"], resourceTypes: ["xmlhttprequest"] },
  },
  {
    id: 3, priority: 1,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "set", value: "https://business.facebook.com" }] },
    condition: { requestDomains: ["graph.facebook.com"], resourceTypes: ["xmlhttprequest"] },
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

// ── Storage helpers (giống Pancake X = chrome.storage.local) ──────────────────

const store = {
  get: (key) => chrome.storage.local.get(key).then((r) => r[key]),
  set: (key, val) => chrome.storage.local.set({ [key]: val }),
};

// ── doc_id registry (giống Pancake DocIdRegistry / At) ────────────────────────

const DOC_ID_KEY = "AutoBill_docIdsMap";
const DOC_ID_TTL = 18 * 60 * 60 * 1000; // 18h (Pancake dùng 5h, ta dùng 18h)

let _docIds = {}; // in-memory cache

async function loadDocIds() {
  const raw = await store.get(DOC_ID_KEY);
  if (!raw) return;
  try {
    const now = Date.now();
    const map = JSON.parse(raw);
    for (const [name, entry] of Object.entries(map)) {
      if (now - entry.ts < DOC_ID_TTL) {
        _docIds[name] = entry.id;
      }
    }
    console.log(`[AutoBill:bg] Loaded ${Object.keys(_docIds).length} cached doc_ids`);
  } catch (_) {}
}

async function saveDocIds() {
  const now = Date.now();
  const map = {};
  for (const [name, id] of Object.entries(_docIds)) {
    map[name] = { id, ts: now };
  }
  await store.set(DOC_ID_KEY, JSON.stringify(map));
}

function searchDocIds(text) {
  let found = false;
  for (const m of text.matchAll(/operationKind:"[^"]*",name:"([^"]+)",id:"(\d+)"/g)) {
    if (!_docIds[m[1]]) { _docIds[m[1]] = m[2]; found = true; }
  }
  for (const m of text.matchAll(/id:"(\d+)",[^"]{0,60}name:"([^"]+)"/g)) {
    if (!_docIds[m[2]]) { _docIds[m[2]] = m[1]; found = true; }
  }
  for (const m of text.matchAll(/__d\("([^"]+)_facebookRelayOperation"[^)]*\)[^"]*"(\d+)"/g)) {
    if (!_docIds[m[1]]) { _docIds[m[1]] = m[2]; found = true; }
  }
  for (const m of text.matchAll(/__d\("([^"]+)"[^)]*\).+?__getDocID=function\(\)\{return"(\d+)"/g)) {
    if (!_docIds[m[1]]) { _docIds[m[1]] = m[2]; found = true; }
  }
  return found;
}

// ── Facebook Context ───────────────────────────────────────────────────────────

let _fbDtsg = null;
let _fbUserId = null;
let _siteData = {};
let _reqCount = 0;

async function ensureFbContext(pageId) {
  if (_fbDtsg) return;

  // Giống Pancake type 4: business.facebook.com/latest/inbox/all
  const url = pageId
    ? `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}&nav_ref=diode_page_inbox&mailbox_id=${pageId}`
    : "https://business.facebook.com/latest/inbox/all";

  console.log(`[AutoBill:bg] Fetching context: ${url}`);
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) throw new Error(`Context fetch ${resp.status}`);
  const html = await resp.text();

  // fb_dtsg
  for (const pat of [
    /"DTSGInitialData",\[\],\{"token":"([^"]+)"/,
    /"token":"([^"]+)","ttl":\d+/,
    /"name":"fb_dtsg","value":"([^"]+)"/,
  ]) {
    const m = html.match(pat);
    if (m) { _fbDtsg = m[1]; break; }
  }
  if (!_fbDtsg) throw new Error("Cannot extract fb_dtsg - are you logged in?");

  // userId — Pancake ctxFromHtml: "USER_ID":"(\d+)"
  const userIdM = html.match(/"USER_ID":"(\d+)"/);
  if (userIdM) _fbUserId = userIdM[1];
  if (!_fbUserId) {
    try {
      const cUser = await chrome.cookies.get({ url: "https://www.facebook.com", name: "c_user" });
      _fbUserId = cUser?.value || null;
    } catch (_) {}
  }

  // lsd token — Pancake ctxFromHtml: ["LSD",[],{"token":"..."},N]
  let _lsd = "";
  const lsdM = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/);
  if (lsdM) _lsd = lsdM[1];

  // SiteData — Pancake ctxFromHtml: ["SiteData",[],{...},N]
  let siteJson = null;
  const siteM = html.match(/\["SiteData",\[\],(\{[^}]+\})/);
  if (siteM) { try { siteJson = JSON.parse(siteM[1]); } catch (_) {} }

  const isComet = siteJson?.is_comet ? 1 : 1; // business.facebook.com luôn comet
  _siteData = {
    __rev:       String(siteJson?.client_revision || (html.match(/"client_revision":(\d+)/) || [])[1] || ""),
    __hs:        siteJson?.haste_session        || (html.match(/"haste_session":"([^"]+)"/) || [])[1] || "",
    __hsi:       siteJson?.hsi                 || (html.match(/"hsi":"([^"]+)"/) || [])[1] || "",
    __pc:        siteJson?.pkg_cohort          || (html.match(/"pkg_cohort":"([^"]+)"/) || [])[1] || "",
    dpr:         String(siteJson?.pr           || (html.match(/"pr":(\d+(?:\.\d+)?)/) || [])[1] || "1"),
    __ccg:       "EXCELLENT",
    __csr:       "",
    __beoa:      "0",
    __comet_req: String(isComet),
    lsd:         _lsd,
  };

  console.log(`[AutoBill:bg] Context: userId=${_fbUserId} rev=${_siteData.__rev}`);

  // Scan inline
  searchDocIds(html);

  // Scan resource_map JS files (giống Pancake makeResourceMap + loadResources)
  await scanJsFiles(html);

  // Lưu doc_ids vào chrome.storage.local
  await saveDocIds();

  console.log(`[AutoBill:bg] doc_ids: ${Object.keys(_docIds).length}, target=${_docIds["PagesManagerInboxAdminAssignerRootQuery"] || "MISSING"}`);
}

async function scanJsFiles(html) {
  const TARGET = "PagesManagerInboxAdminAssignerRootQuery";
  const jsUrls = new Set();

  // resource_map / rsrcMap (Pancake makeResourceMap)
  for (const marker of ['"resource_map":', '"rsrcMap":']) {
    let idx = 0;
    while ((idx = html.indexOf(marker, idx)) !== -1) {
      try {
        const start = html.indexOf("{", idx + marker.length);
        if (start !== -1) {
          const chunk = balancedJson(html, start);
          if (chunk) {
            const map = JSON.parse(chunk);
            for (const val of Object.values(map)) {
              if (val?.src?.startsWith("https://")) jsUrls.add(val.src);
            }
          }
        }
      } catch (_) {}
      idx++;
    }
  }

  // <script src="..."> + loadOnDOMContentReady
  for (const m of html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)) jsUrls.add(m[1]);

  console.log(`[AutoBill:bg] Scanning ${jsUrls.size} JS files...`);

  const urls = [...jsUrls];
  const BATCH = 6; // Giống Pancake loadResources batch size
  for (let i = 0; i < urls.length; i += BATCH) {
    if (_docIds[TARGET]) break;
    await Promise.all(
      urls.slice(i, i + BATCH).map(async (url) => {
        if (_docIds[TARGET]) return;
        try {
          const r = await fetch(url);
          if (searchDocIds(await r.text()) && _docIds[TARGET]) {
            console.log(`[AutoBill:bg] Found ${TARGET} in ${url.slice(-60)}`);
          }
        } catch (_) {}
      })
    );
  }
}

function balancedJson(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") { depth--; if (depth === 0) return str.slice(start, i + 1); }
  }
  return null;
}

// ── Resolve threadId → PSID (Pancake getGlobalIdFromInbox) ───────────────────

const _recipientCache = {};

async function resolveRecipientId(threadId, pageId) {
  if (_recipientCache[threadId]) return _recipientCache[threadId];

  // Method 1: GraphQL nếu có doc_id
  const QUERY = "PagesManagerInboxAdminAssignerRootQuery";
  const docId = _docIds[QUERY];

  if (docId) {
    console.log(`[AutoBill:bg] Resolving via GraphQL: thread=${threadId} docId=${docId}`);
    try {
      const r = await fetch("https://business.facebook.com/api/graphql/", {
        method: "POST",
        body: buildBody({
          av: pageId,
          __user: _fbUserId || "",
          __a: "1",
          __req: (_reqCount++).toString(36),
          fb_dtsg: _fbDtsg,
          jazoest: calcJazoest(_fbDtsg),
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
      console.log(`[AutoBill:bg] GraphQL ${r.status}: ${text.slice(0, 200)}`);
      const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ""));
      const globalId = json?.data?.commItem?.target_id;
      if (globalId) {
        console.log(`[AutoBill:bg] Resolved via GraphQL: ${threadId} → ${globalId}`);
        _recipientCache[threadId] = globalId;
        return globalId;
      }
    } catch (e) {
      console.warn(`[AutoBill:bg] GraphQL error: ${e.message}`);
    }
  }

  // Method 2: Fetch conversation page → parse PSID from embedded JSON
  console.log(`[AutoBill:bg] Resolving via conversation page: thread=${threadId}`);
  try {
    const convUrl = `https://business.facebook.com/latest/inbox/all?page_id=${pageId}&asset_id=${pageId}&selected_item_id=${threadId}`;
    const r = await fetch(convUrl, { credentials: "include" });
    const html = await r.text();
    console.log(`[AutoBill:bg] Conversation page ${r.status}, length=${html.length}`);

    // Scan này cũng load thêm doc_ids nếu chưa có
    searchDocIds(html);
    // Tìm PSID trong JSON nhúng trong page
    const patterns = [
      /"target_id":"(\d+)"/,
      /"commItem":\{"id":"[^"]+","target_id":"(\d+)"/,
      /"other_user_fbid":"(\d+)"/,
    ];
    for (const pat of patterns) {
      const m = html.match(pat);
      if (m && m[1] !== pageId && m[1] !== threadId) {
        console.log(`[AutoBill:bg] Resolved via page HTML (${pat.source.slice(0,20)}): ${threadId} → ${m[1]}`);
        _recipientCache[threadId] = m[1];
        return m[1];
      }
    }
    // Log 500 chars quanh "target_id" để debug
    const ti = html.indexOf("target_id");
    if (ti !== -1) console.log(`[AutoBill:bg] target_id context: ${html.slice(Math.max(0,ti-30), ti+80)}`);
    else console.warn(`[AutoBill:bg] No target_id found in conversation page`);
  } catch (e) {
    console.warn(`[AutoBill:bg] Conversation page error: ${e.message}`);
  }

  console.warn(`[AutoBill:bg] Cannot resolve PSID, using threadId as-is`);
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
    {
      method: "POST",
      body: form,
      credentials: "include",
      headers: { "Referer": "https://business.facebook.com/latest/inbox/messenger" },
    }
  );

  const text = await r.text();
  const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ""));
  const meta = json?.payload?.metadata?.[0];
  if (!meta) throw new Error("Upload failed: " + text.slice(0, 200));
  const id = meta.image_id || meta.fbid;
  console.log(`[AutoBill:bg] Uploaded image id=${id}`);
  return id;
}

// ── Send message (Pancake buildSendParams + messaging/send/) ──────────────────

// Pancake generateOfflineThreadingID: 41-bit ms timestamp + 22-bit random → 63-bit decimal
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

  const r = await fetch("https://business.facebook.com/messaging/send/", {
    method: "POST",
    body: buildBody({
      __user: _fbUserId || "",
      __a: "1",
      __req: (_reqCount++).toString(36),
      fb_dtsg: _fbDtsg,
      jazoest: calcJazoest(_fbDtsg),
      ..._siteData,
      body: text || "",
      offline_threading_id: tid,
      message_id: tid,
      source: "source:page_unified_inbox",
      timestamp: String(Date.now()),
      "specific_to_list[0]": `fbid:${recipientId}`,
      "specific_to_list[1]": `fbid:${pageId || _fbUserId}`,
      other_user_fbid: recipientId,
      client: "mercury",
      action_type: "ma-type:user-generated-message",
      ephemeral_ttl_mode: 0,
      has_attachment: !!attachmentId,
      request_user_id: pageId || "",
      ...(attachmentId ? { "image_ids[0]": attachmentId } : {}),
    }),
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      "x-response-format": "JSONStream",
      "x-msgr-region": "ATN",
      "Referer": `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}`,
    },
  });

  const resText = await r.text();
  console.log(`[AutoBill:bg] messaging/send ${r.status}: ${resText.slice(0, 300)}`);
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
  try {
    await ensureFbContext(page_id);
    const recipientId = await resolveRecipientId(conversation_id, page_id);
    let attachmentId = null;
    if (image_base64) attachmentId = await uploadImage(image_base64, page_id);
    return await sendMessage(recipientId, message, attachmentId, page_id);
  } catch (e) {
    console.error("[AutoBill:bg] Error:", e.message);
    if (/dtsg|logged|auth|session/i.test(e.message)) _fbDtsg = null;
    return { success: false, error: e.message };
  }
}

// ── Utils ──────────────────────────────────────────────────────────────────────

// Pancake calcJazoest: "2" + sum of char codes of dtsg token
function calcJazoest(dtsg) {
  let s = 0;
  for (let i = 0; i < dtsg.length; i++) s += dtsg.charCodeAt(i);
  return "2" + s;
}

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "fb_send") {
    handleSendMessage(msg.payload).then(sendResponse);
    return true; // async
  }
  if (msg.type === "fb_reset") {
    _fbDtsg = null;
    sendResponse({ ok: true });
  }
  // Nhận doc_ids từ content script (docid_extractor.js)
  if (msg.type === "doc_ids_from_page") {
    const added = [];
    for (const [name, id] of Object.entries(msg.docIds || {})) {
      if (!_docIds[name]) { _docIds[name] = id; added.push(name); }
    }
    if (added.length > 0) {
      console.log(`[AutoBill:bg] Got ${added.length} new doc_ids from page. Total=${Object.keys(_docIds).length}. target=${_docIds["PagesManagerInboxAdminAssignerRootQuery"] || "still missing"}`);
      saveDocIds();
    }
    sendResponse({ ok: true });
  }
});

// ── Startup ────────────────────────────────────────────────────────────────────

setupNetRules();
loadDocIds(); // Load cached doc_ids từ chrome.storage.local

// Keepalive: giữ service worker + offscreen sống
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") ensureOffscreen();
});

ensureOffscreen();
console.log("[AutoBill:bg] Service worker started v5.1");
