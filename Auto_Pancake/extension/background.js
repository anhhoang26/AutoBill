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
let _sprinkleShouldRandomize = true;
let _siteData = {};
let _jazoest = "";
let _reqCount = 0;
let _lastPageId = null;           // page_id đã dùng để fetch context
// Per-page context cache → tránh fetch business.facebook.com mỗi lần đổi page
const _contextsByPage = {};        // pageId -> { dtsg, userId, lsd, msgrRegion, sprinkleParamName, sprinkleVersion, siteData, ts }
const CONTEXT_TTL = 30 * 60 * 1000; // 30 phút — cân bằng giữa tránh stale token và hạn chế fetch
// Pancake webSession.getId() format: sessionId:activityId:tabId
const _webSessionId = Math.floor(Math.random()*1e9).toString(36).slice(0,6) + ":" +
  Math.floor(Math.random()*1e9).toString(36).slice(0,6) + ":" +
  Math.floor(Math.random()*Math.pow(36,6)).toString(36).padStart(6,"0");

function _clearFbContext() {
  _fbDtsg = null; _fbUserId = null; _lsd = "";
  _siteData = {};
  _lastPageId = null;
}

function _activateCachedContext(pageId, cached) {
  _fbDtsg = cached.dtsg;
  _fbUserId = cached.userId;
  _lsd = cached.lsd;
  _msgrRegion = cached.msgrRegion;
  _sprinkleParamName = cached.sprinkleParamName;
  _sprinkleVersion = cached.sprinkleVersion;
  _sprinkleShouldRandomize = cached.sprinkleShouldRandomize;
  _jazoest = cached.jazoest;
  _siteData = cached.siteData;
  _lastPageId = pageId;
}

async function ensureFbContext(pageId, forceRefresh = false) {
  // Reuse cached context for this page if fresh enough → no FB fetch
  const cached = _contextsByPage[pageId];
  if (cached && !forceRefresh && Date.now() - cached.ts < CONTEXT_TTL) {
    if (_lastPageId !== pageId) {
      _activateCachedContext(pageId, cached);
      console.log(`[AutoBill:bg] Using cached context for page ${pageId}`);
    }
    return;
  }
  if (forceRefresh) delete _contextsByPage[pageId];
  _clearFbContext();

  // Pancake dùng inbox/messenger (BP:bizweb_pkg), KHÔNG phải inbox/all (HYP:bizweb_comet_pkg)
  // 2 code path khác nhau — FB validate tokens khác nhau, dùng sai → lỗi 1545012
  const url = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&nav_ref=diode_page_inbox`;
  console.log(`[AutoBill:bg] 🔵 FETCHING CONTEXT FROM: ${url}`);
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

  // SprinkleConfig — Pancake extract cả should_randomize (ảnh hưởng công thức jazoest)
  const sprinkleM = html.match(/\["SprinkleConfig",\[\],\{"param_name":"([^"]+)","version":(\d+),"should_randomize":(true|false)/);
  if (sprinkleM) {
    _sprinkleParamName = sprinkleM[1];
    _sprinkleVersion = parseInt(sprinkleM[2], 10);
    _sprinkleShouldRandomize = sprinkleM[3] === "true";
  }

  // jazoest theo Pancake:
  //   V2: sum(charCodes) → should_randomize ? sum : "2"+sum
  //   V1: concat(charCodes) → "2" + concat
  let ttstamp;
  if (_sprinkleVersion === 2) {
    let sum = 0;
    for (let i = 0; i < _fbDtsg.length; i++) sum += _fbDtsg.charCodeAt(i);
    ttstamp = _sprinkleShouldRandomize ? String(sum) : "2" + sum;
  } else {
    let concat = "";
    for (let i = 0; i < _fbDtsg.length; i++) concat += _fbDtsg.charCodeAt(i);
    ttstamp = "2" + concat;
  }
  _jazoest = ttstamp;

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

  // Pancake buildParams() — KHÔNG include jazoest ở đây (jazoest phải đặt sau fb_dtsg)
  _siteData = {
    __csr:       "",
    __beoa:      sd.be_one_ahead ? 1 : 0,
    __pc:        sd.pkg_cohort || "",
    dpr:         String(sd.pr || 1),
    __ccg:       ccg,
    __rev:       clientRevision,
    __hsi:       sd.hsi ? String(sd.hsi) : "",
    __hs:        sd.haste_session || "",
    __comet_req: sd.is_comet ? 1 : 0,
    __spin_r:    sd.__spin_r ? String(sd.__spin_r) : clientRevision,
    __spin_b:    sd.__spin_b || "trunk",
    __spin_t:    sd.__spin_t ? String(sd.__spin_t) : "1514187418",
    __s:         _webSessionId,
  };

  _lastPageId = pageId;
  _contextsByPage[pageId] = {
    dtsg: _fbDtsg,
    userId: _fbUserId,
    lsd: _lsd,
    msgrRegion: _msgrRegion,
    sprinkleParamName: _sprinkleParamName,
    sprinkleVersion: _sprinkleVersion,
    sprinkleShouldRandomize: _sprinkleShouldRandomize,
    jazoest: _jazoest,
    siteData: _siteData,
    ts: Date.now(),
  };
  console.log(`[AutoBill:bg] 🔵 EXTRACTED: __pc=${_siteData.__pc} __beoa=${_siteData.__beoa} __ccg=${_siteData.__ccg} __hs=${_siteData.__hs} jazoest=${_jazoest} version=${_sprinkleVersion} should_randomize=${_sprinkleShouldRandomize}`);
  console.log(`[AutoBill:bg] Fetched+cached context page=${pageId} dtsg=${_fbDtsg.slice(0,8)}... lsd=${_lsd ? _lsd.slice(0,6)+"..." : "MISSING"} region=${_msgrRegion} rev=${clientRevision}`);

  searchDocIds(html);
  await saveDocIds();
  // Store last HTML of context for on-demand doc_id fetch
  _lastContextHtml = html;
}

// Khi chưa có target doc_id, fetch các <script src> từ HTML context để scan
// (giống docid_extractor.js nhưng chạy ngay trong service worker, không cần user mở tab).
let _lastContextHtml = "";
let _scriptsScanned = false;

async function ensureDocIdsFromScripts() {
  if (_scriptsScanned || !_lastContextHtml) return;
  _scriptsScanned = true;
  const srcs = [..._lastContextHtml.matchAll(/<script[^>]+src="(https:\/\/static\.xx\.fbcdn\.net\/[^"]+)"/g)]
    .map(m => m[1].replace(/&amp;/g, "&"));
  console.log(`[AutoBill:bg] Fetching ${srcs.length} script chunks to populate doc_ids...`);
  const before = Object.keys(_docIds).length;
  await Promise.all(srcs.map(async (url) => {
    try {
      const r = await fetch(url);
      searchDocIds(await r.text());
    } catch (_) {}
  }));
  const after = Object.keys(_docIds).length;
  console.log(`[AutoBill:bg] doc_ids: ${before} → ${after}`);
  await saveDocIds();
}

// ── Resolve threadId → PSID ────────────────────────────────────────────────────

const _recipientCache = {};

async function resolveRecipientId(threadId, pageId) {
  if (_recipientCache[threadId]) return _recipientCache[threadId];

  // Method 1: GraphQL PagesManagerInboxAdminAssignerRootQuery (giống Pancake primary)
  const QUERY = "PagesManagerInboxAdminAssignerRootQuery";
  let docId = _docIds[QUERY];

  // Nếu thiếu doc_id → tự fetch scripts từ HTML để extract
  if (!docId) {
    await ensureDocIdsFromScripts();
    docId = _docIds[QUERY];
  }

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
          "Referer": `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&nav_ref=diode_page_inbox`,
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
    const url = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&selected_item_id=${threadId}&nav_ref=diode_page_inbox`;
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

  // Thứ tự params EXACTLY theo curl Pancake thành công:
  //   body, offline_threading_id, source, timestamp, request_user_id,
  //   __user, __a, __req, __csr, __beoa, __pc, dpr, __ccg, __rev, __hsi, __hs,
  //   __comet_req, __spin_r, __spin_b, __spin_t, __s,
  //   fb_dtsg, jazoest, lsd, __usid,
  //   specific_to_list[0], specific_to_list[1], other_user_fbid, message_id,
  //   client, action_type, ephemeral_ttl_mode, has_attachment, image_ids[0]
  const paramsObj = {
    body: text || "",
    offline_threading_id: tid,
    source: "source:page_unified_inbox",
    timestamp: String(Date.now()),
    request_user_id: pageId,
    __user: _fbUserId || "",
    __a: "1",
    __req: (_reqCount++).toString(36),
    __csr: _siteData.__csr ?? "",
    __beoa: _siteData.__beoa,
    __pc: _siteData.__pc,
    dpr: _siteData.dpr,
    __ccg: _siteData.__ccg,
    __rev: _siteData.__rev,
    __hsi: _siteData.__hsi,
    __hs: _siteData.__hs,
    __comet_req: _siteData.__comet_req,
    __spin_r: _siteData.__spin_r,
    __spin_b: _siteData.__spin_b,
    __spin_t: _siteData.__spin_t,
    __s: _siteData.__s,
    fb_dtsg: _fbDtsg,
    [_sprinkleParamName]: _jazoest,   // jazoest SAU fb_dtsg
    lsd: _lsd,
    __usid: "null",                   // __usid SAU lsd, TRƯỚC specific_to_list
    "specific_to_list[0]": `fbid:${recipientId}`,
    "specific_to_list[1]": `fbid:${pageId}`,
    other_user_fbid: recipientId,
    message_id: tid,
    client: "mercury",
    action_type: "ma-type:user-generated-message",
    ephemeral_ttl_mode: "0",
    has_attachment: attachmentId ? "true" : "false",
  };
  if (attachmentId) paramsObj["image_ids[0]"] = attachmentId;

  const body = buildBody(paramsObj);
  console.log(`[AutoBill:bg] send params: user=${_fbUserId} page=${pageId} recipient=${recipientId} rev=${_siteData.__rev} comet=${_siteData.__comet_req}`);

  // Headers: match Pancake exactly — chỉ Content-Type + X-MSGR-Region (không x-requested-with/x-response-format)
  const r = await fetch("https://business.facebook.com/messaging/send/", {
    method: "POST",
    body,
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-MSGR-Region": _msgrRegion,
    },
  });

  const resText = await r.text();
  console.log(`[AutoBill:bg] messaging/send ${r.status}: ${resText.slice(0, 400)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  const json = JSON.parse(resText.replace(/^for\s*\(;;\);/, ""));

  // FB có thể trả 200 OK nhưng vẫn lỗi. Check đầy đủ các field lỗi:
  if (json.error || json.errorSummary || json.errorCode || json.errorDescription) {
    const errInfo = {
      error: json.error, errorCode: json.errorCode,
      summary: json.errorSummary, desc: json.errorDescription,
    };
    console.error("[AutoBill:bg] FB error:", JSON.stringify(errInfo));
    throw new Error(`FB error: ${JSON.stringify(errInfo)}`);
  }

  // Chỉ coi là success khi có action_id hoặc payload.actions chứa message đã gửi
  const actionId = json.payload?.action_id || json.action_id;
  const actions = json.payload?.actions;
  if (!actionId && !(Array.isArray(actions) && actions.length > 0)) {
    console.error("[AutoBill:bg] No action_id/actions in response:", resText.slice(0, 400));
    throw new Error("FB send: no action_id in response");
  }

  console.log(`[AutoBill:bg] Message sent, action_id=${actionId || "(from actions[])"}`);
  return { success: true, action_id: actionId };
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
console.log("[AutoBill:bg] Service worker started v5.6.6 (auto fetch script chunks for doc_ids)");
