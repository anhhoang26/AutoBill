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
const SEEN_PAGE_IDS_KEY = "AutoBill_seenPageIds";

let _docIds = {};

async function _recordSeenPageId(pageId) {
  if (!pageId) return;
  const list = (await store.get(SEEN_PAGE_IDS_KEY)) || [];
  if (!list.includes(pageId)) {
    list.push(pageId);
    await store.set(SEEN_PAGE_IDS_KEY, list);
  }
}

async function warmupPageId(pageId) {
  // Chỉ cần fetch context (dtsg/lsd/siteData) để ready cho send.
  // KHÔNG cần scrape doc_ids nữa — PSID đã lấy từ Pancake POS bên Python, không dùng GraphQL.
  console.log(`[AutoBill:bg] 🔥 Warmup start: page=${pageId}`);
  try {
    await ensureFbContext(pageId);
    console.log(`[AutoBill:bg] 🔥 Warmup done (context only, no doc_id scrape)`);
    return true;
  } catch (e) {
    console.warn(`[AutoBill:bg] Warmup error: ${e.message}`);
    return false;
  }
}

async function warmupFromStoredPages() {
  const pageIds = (await store.get(SEEN_PAGE_IDS_KEY)) || [];
  if (pageIds.length === 0) {
    console.log("[AutoBill:bg] Warmup skipped: no stored page_ids yet (first run — will populate on first send or external warmup command)");
    return;
  }
  console.log(`[AutoBill:bg] Warmup from storage: ${pageIds.length} page(s)`);
  await warmupPageId(pageIds[0]);
}

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

  const baseUrl = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&nav_ref=diode_page_inbox`;
  console.log(`[AutoBill:bg] 🔵 FETCHING CONTEXT FROM: ${baseUrl}`);
  const resp0 = await fetch(baseUrl, {
    credentials: "include",
    headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  if (!resp0.ok) throw new Error(`Context fetch ${resp0.status}`);
  let html = await resp0.text();

  // Nếu HTML lần đầu có compat_iframe_token → fetch lần 2 với cquick để get BP package
  const compatM = html.match(/"compat_iframe_token":"([^"]+)"/);
  if (compatM) {
    const compatToken = compatM[1];
    const compatUrl = `${baseUrl}&cquick=jsc_c_d&cquick_token=${encodeURIComponent(compatToken)}&ctarget=${encodeURIComponent("https://www.facebook.com")}`;
    console.log(`[AutoBill:bg] 🔵 COMPAT FETCH: ${compatUrl.slice(0, 200)}...`);
    try {
      const resp1 = await fetch(compatUrl, {
        credentials: "include",
        headers: { "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      });
      if (resp1.ok) {
        const compatHtml = await resp1.text();
        // Check specifically cho BP package (không phải HYP:bizweb_comet_pkg)
        const hasBP = /"pkg_cohort":"BP:bizweb_pkg"/.test(compatHtml) || /BP%3Abizweb_pkg/.test(compatHtml);
        const hasHYP = /"pkg_cohort":"HYP:bizweb_comet_pkg"/.test(compatHtml);
        if (hasBP && compatHtml.length > 10000) {
          console.log(`[AutoBill:bg] ✅ Using compat (BP) HTML for context`);
          html = compatHtml;
        } else {
          console.log(`[AutoBill:bg] ⚠️ Compat HTML: hasBP=${hasBP} hasHYP=${hasHYP} len=${compatHtml.length} — using original`);
        }
      }
    } catch (e) {
      console.warn(`[AutoBill:bg] compat fetch error: ${e.message}, using original HTML`);
    }
  } else {
    console.log(`[AutoBill:bg] No compat_iframe_token in initial HTML`);
  }

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
  // Pancake buildParams thêm 2 field này có điều kiện — extract nếu có:
  //   force_blue=1 → FB phân biệt request "Business UI thật" vs "bot/incomplete"
  //   __spin_dev_mhenv → spin field thứ 4 (đôi khi FB inject ở dev/staging branch)
  if (sd.force_blue) _siteData.force_blue = 1;
  if (sd.__spin_dev_mhenv) _siteData.__spin_dev_mhenv = sd.__spin_dev_mhenv;

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

// Pancake-style: extract resource_map (hash → URL) + loadOnDOMContentReady + <script src>
// → fetch các JS chunks (kể cả lazy-loaded) để scan doc_ids.
// Không cần user mở tab business.facebook.com.
let _lastContextHtml = "";
let _scriptsScanned = false;

// Brace-matching JSON object extractor (handles nested braces + strings properly)
// Pancake dùng function A(html, marker) để cut JSON object sau marker, tương đương cách này.
function _extractJsonObjectAfter(html, marker, fromIdx = 0) {
  const start = html.indexOf(marker, fromIdx);
  if (start < 0) return null;
  let i = start + marker.length;
  while (i < html.length && html[i] !== '{') i++;
  if (i >= html.length) return null;
  const objStart = i;
  let depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === '"') {
      i++;
      while (i < html.length && html[i] !== '"') {
        if (html[i] === '\\') i++;
        i++;
      }
    } else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { str: html.slice(objStart, i + 1), end: i + 1 };
    }
  }
  return null;
}

function _extractAllJsonObjectsAfter(html, marker) {
  const results = [];
  let idx = 0;
  while (true) {
    const r = _extractJsonObjectAfter(html, marker, idx);
    if (!r) break;
    results.push(r.str);
    idx = r.end;
  }
  return results;
}

function _extractResourceMap(html) {
  // Extract ALL occurrences of "resource_map":{...}, "rsrcMap":{...}, and setResourceMap(...)
  const map = {};
  for (const marker of ['"resource_map":', '"rsrcMap":']) {
    for (const jsonStr of _extractAllJsonObjectsAfter(html, marker)) {
      try { Object.assign(map, JSON.parse(jsonStr)); } catch (_) {}
    }
  }
  // setResourceMap(OBJ, []) — argument is JSON object literal
  let idx = 0;
  while (true) {
    const foundAt = html.indexOf("setResourceMap(", idx);
    if (foundAt < 0) break;
    const r = _extractJsonObjectAfter(html, "", foundAt + "setResourceMap(".length);
    if (r) {
      try { Object.assign(map, JSON.parse(r.str)); } catch (_) {}
      idx = r.end;
    } else {
      idx = foundAt + 1;
    }
  }
  return map;
}

// Pancake dùng 2 URL khác để load chunks chứa PagesManagerInboxAdminAssignerRootQuery:
//   - /latest/inbox/all?asset_id=X&nav_ref=diode_page_inbox&mailbox_id=X   (InboxNormal view)
//   - /latest/inbox/facebook?asset_id=X&thread_type=FB_PAGE_POST            (BusinessComments view)
// Các URL này load chunk sets KHÁC với /latest/inbox/messenger.
async function fetchInboxAllHtml(pageId) {
  const url = `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}&nav_ref=diode_page_inbox&mailbox_id=${pageId}`;
  console.log(`[AutoBill:bg] Fetching inbox/all for doc_ids: ${url}`);
  try {
    const r = await fetch(url, { credentials: "include" });
    return await r.text();
  } catch (e) {
    console.warn(`[AutoBill:bg] inbox/all fetch error: ${e.message}`);
    return "";
  }
}

async function fetchInboxFacebookHtml(pageId) {
  const url = `https://business.facebook.com/latest/inbox/facebook?asset_id=${pageId}&thread_type=FB_PAGE_POST`;
  console.log(`[AutoBill:bg] Fetching inbox/facebook for doc_ids: ${url}`);
  try {
    const r = await fetch(url, { credentials: "include" });
    return await r.text();
  } catch (e) {
    console.warn(`[AutoBill:bg] inbox/facebook fetch error: ${e.message}`);
    return "";
  }
}

async function ensureDocIdsFromScripts(pageId) {
  if (_scriptsScanned) return;
  _scriptsScanned = true;

  // Fetch 2 extra HTMLs từ Pancake's loader URLs (chứa chunks khác)
  const extras = pageId ? await Promise.all([
    fetchInboxAllHtml(pageId),
    fetchInboxFacebookHtml(pageId),
  ]) : [];
  const html = [_lastContextHtml, ...extras].filter(Boolean).join("\n<!--SEP-->\n");

  // 1. Direct <script src>
  const directSrcs = new Set(
    [...html.matchAll(/<script[^>]+src="(https:\/\/static\.xx\.fbcdn\.net\/[^"]+)"/g)]
      .map(m => m[1].replace(/&amp;/g, "&"))
  );

  // 2. Resource map: hash → {type:"js", src:"..."} (dùng cho bootloader lazy modules)
  const resMap = _extractResourceMap(html);
  for (const [, entry] of Object.entries(resMap)) {
    if (entry && entry.type === "js" && entry.src) directSrcs.add(entry.src);
  }

  // 3. Hashes từ loadOnDOMContentReady([...]) → cần lookup trong resMap
  const domHashes = [];
  for (const m of html.matchAll(/loadOnDOMContentReady\((\[[^\]]+\])/g)) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) domHashes.push(...arr);
    } catch (_) {}
  }
  for (const h of domHashes) {
    const entry = resMap[h];
    if (entry && entry.src) directSrcs.add(entry.src);
  }

  const srcs = [...directSrcs];
  console.log(`[AutoBill:bg] Fetching ${srcs.length} script chunks (direct+rsrcMap+DOMReady)...`);
  const before = Object.keys(_docIds).length;
  // Fetch in batches of 6 (like Pancake)
  const BATCH = 6;
  for (let i = 0; i < srcs.length; i += BATCH) {
    await Promise.all(srcs.slice(i, i + BATCH).map(async (url) => {
      try {
        const r = await fetch(url);
        searchDocIds(await r.text());
      } catch (_) {}
    }));
    if (_docIds["PagesManagerInboxAdminAssignerRootQuery"]) {
      console.log(`[AutoBill:bg] Target doc_id found at batch ${i/BATCH+1}, stop early`);
      break;
    }
  }
  const after = Object.keys(_docIds).length;
  console.log(`[AutoBill:bg] doc_ids: ${before} → ${after}, target=${_docIds["PagesManagerInboxAdminAssignerRootQuery"] || "STILL MISSING"}`);
  await saveDocIds();
}

// ── Resolve threadId → PSID ────────────────────────────────────────────────────

const _recipientCache = {};

async function _callGraphQL(queryName, docId, variables, pageId) {
  const body = buildBody({
    av: pageId,
    __user: _fbUserId || "",
    __a: "1",
    __req: (_reqCount++).toString(36),
    fb_dtsg: _fbDtsg,
    ..._siteData,
    doc_id: docId,
    variables: JSON.stringify(variables),
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: queryName,
  });
  const r = await fetch("https://business.facebook.com/api/graphql/", {
    method: "POST",
    body,
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-FB-Friendly-Name": queryName,
      "X-FB-LSD": _lsd,
      "Referer": `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&nav_ref=diode_page_inbox`,
    },
  });
  return await r.text();
}

// Recursively scan JSON response for "target_id", "other_user_fbid", "id" fields that look like PSIDs
function _findPsidInResponse(text, pageId, userId) {
  try {
    const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ""));
    if (!json || json.errors) return null;
    // BFS through data
    const stack = [json];
    const candidates = [];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === "string" && /^\d{10,}$/.test(v)) {
          if (v !== pageId && v !== userId) {
            // Real PSID usually starts with 100 or 61 and has 14-17 digits
            const isPsidShape = /^(100|61)\d{10,14}$/.test(v);
            const fieldLikely = /psid|target_id|other_user_fbid|participant|user.*id|actor.*id|customer/i.test(k);
            if (isPsidShape || fieldLikely) candidates.push({ id: v, field: k, score: (isPsidShape ? 2 : 0) + (fieldLikely ? 1 : 0) });
          }
        } else if (v && typeof v === "object") stack.push(v);
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.id || null;
  } catch (_) {
    return null;
  }
}

async function resolveRecipientId(threadId, pageId) {
  // Fallback path — chỉ chạy khi Python không truyền recipient_psid.
  // Không scrape doc_ids nữa (tốn 1200+ CDN requests, không hiệu quả vì FB đổi query).
  if (_recipientCache[threadId]) return _recipientCache[threadId];

  // Method 1: Try multiple GraphQL queries (in priority order) to resolve PSID.
  // Each query has different variables. Inspect response for any ID that looks like a PSID.
  const QUERIES = [
    // Pancake legacy
    { name: "PagesManagerInboxAdminAssignerRootQuery", vars: { pageID: pageId, commItemID: threadId } },
    // Modern biz suite equivalents
    { name: "BusinessCometInboxThreadDetailHeaderQuery", vars: { commItemID: threadId, pageID: pageId, scale: 1 } },
    { name: "BusinessCometInboxThreadDetailHeaderQuery", vars: { commItemID: threadId, scale: 1 } },
    { name: "BusinessCometContextCardInboxContainerQuery", vars: { commItemID: threadId, pageID: pageId } },
    { name: "BizInboxNewAssignAdminCardWithEntrypointQuery", vars: { commItemID: threadId, pageID: pageId } },
    { name: "BusinessCometInboxThreadDetailBodyQuery", vars: { commItemID: threadId, pageID: pageId, count: 1 } },
  ];

  for (const q of QUERIES) {
    const docId = _docIds[q.name];
    if (!docId) continue;
    try {
      console.log(`[AutoBill:bg] GraphQL try: ${q.name} docId=${docId} vars=${JSON.stringify(q.vars)}`);
      const text = await _callGraphQL(q.name, docId, q.vars, pageId);
      console.log(`[AutoBill:bg] GraphQL ${q.name} resp[0:400]: ${text.slice(0, 400)}`);

      const psid = _findPsidInResponse(text, pageId, _fbUserId);
      if (psid) {
        console.log(`[AutoBill:bg] ✅ GraphQL resolved via ${q.name}: ${threadId} → ${psid}`);
        _recipientCache[threadId] = psid;
        return psid;
      }
    } catch (e) {
      console.warn(`[AutoBill:bg] ${q.name} error: ${e.message}`);
    }
  }

  console.warn(`[AutoBill:bg] No GraphQL query resolved PSID (${Object.keys(_docIds).length} doc_ids cached), falling back to HTML parsing`);

  // Method 2: HTML parsing fallback — tìm PSID trong trang conversation
  try {
    const url = `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&selected_item_id=${threadId}&nav_ref=diode_page_inbox`;
    const r = await fetch(url, { credentials: "include" });
    const html = await r.text();
    console.log(`[AutoBill:bg] Conv page ${r.status}, length=${html.length}`);

    if (searchDocIds(html)) await saveDocIds();

    // FB bootstrap data trong HTML chứa PSID ở nhiều format khác nhau.
    // Thử rộng các pattern — pick ID khác pageId và userId, ưu tiên ID xuất hiện GẦN threadId.
    const candidates = new Map(); // id → nearest distance to threadId mention
    const threadIdx = html.indexOf(threadId);

    const patterns = [
      /"other_user_fbid":"(\d{8,})"/g,
      /"target_id":"(\d{8,})"/g,
      /"other_participant_id":"(\d{8,})"/g,
      /"customer_id":"(\d{8,})"/g,
      /"customer_fbid":"(\d{8,})"/g,
      /"fbid":"(\d{8,})"/g,
      /"actor_id":"(\d{8,})"/g,
      /"user":\{"id":"(\d{8,})"/g,
      /"customer":\{"id":"(\d{8,})"/g,
      /"other_participant":\{[^}]*"id":"(\d{8,})"/g,
      /"participant":\{[^}]*"id":"(\d{8,})"/g,
    ];

    for (const pat of patterns) {
      for (const m of html.matchAll(pat)) {
        const id = m[1];
        if (id === pageId || id === _fbUserId) continue;
        const dist = threadIdx >= 0 ? Math.abs(m.index - threadIdx) : m.index;
        if (!candidates.has(id) || candidates.get(id) > dist) candidates.set(id, dist);
      }
    }

    if (candidates.size === 0) {
      console.warn(`[AutoBill:bg] HTML has 0 PSID candidates. length=${html.length} threadIdx=${threadIdx}`);
      // Debug: dump 500 chars around threadId mention + list related doc_id names
      if (threadIdx >= 0) {
        const windowBefore = html.slice(Math.max(0, threadIdx - 300), threadIdx);
        const windowAfter = html.slice(threadIdx, Math.min(html.length, threadIdx + 500));
        console.warn(`[AutoBill:bg] DEBUG text around threadId (before 300 chars):\n${windowBefore}`);
        console.warn(`[AutoBill:bg] DEBUG text around threadId (after 500 chars):\n${windowAfter}`);
      }
      // Log doc_id names related to inbox/thread/admin
      const relatedNames = Object.keys(_docIds).filter(n =>
        /Inbox|Thread|CommItem|Assigner|MessengerParticipant|BusinessInbox|BizInbox/i.test(n)
      );
      console.warn(`[AutoBill:bg] DEBUG ${relatedNames.length} related doc_id names:`, relatedNames.slice(0, 50).join(", "));
    } else {
      // Sort by distance (closest to threadId mention wins)
      const sorted = [...candidates.entries()].sort((a, b) => a[1] - b[1]);
      console.log(`[AutoBill:bg] HTML PSID candidates (by distance): ${sorted.slice(0, 10).map(([id, d]) => `${id}(${d})`).join(", ")}`);
      const [bestId] = sorted[0];
      console.log(`[AutoBill:bg] HTML resolved: ${threadId} → ${bestId}`);
      _recipientCache[threadId] = bestId;
      return bestId;
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

  // Pancake official randomizes form field upload_1024..upload_1034 mỗi request
  // → tránh FB fingerprint pattern "luôn upload_1024 + bill.png" của bot.
  const fieldName = `upload_${1024 + Math.floor(Math.random() * 11)}`;
  const filename = `image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  form.append(fieldName, blob, filename);

  // Full session params giống sendMessage — nếu chỉ gửi __user/__a/fb_dtsg/request_user_id
  // thì FB anti-abuse từ chối (error 3252001) vì request shape không match Business Manager UI.
  const paramsObj = {
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
    [_sprinkleParamName]: _jazoest,
    lsd: _lsd,
    // force_blue=1 + __spin_dev_mhenv: Pancake official set conditionally trong buildParams
    ...(_siteData.force_blue ? { force_blue: _siteData.force_blue } : {}),
    ...(_siteData.__spin_dev_mhenv ? { __spin_dev_mhenv: _siteData.__spin_dev_mhenv } : {}),
    ...(pageId ? { request_user_id: pageId } : {}),
  };
  const params = new URLSearchParams(paramsObj);

  const r = await fetch(
    `https://upload-business.facebook.com/ajax/mercury/upload.php?${params}`,
    {
      method: "POST",
      body: form,
      credentials: "include",
      headers: {
        "X-MSGR-Region": _msgrRegion,
        "Referer": `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&nav_ref=diode_page_inbox`,
      },
    }
  );

  const text = await r.text();
  const trimmed = text.replace(/^for\s*\(;;\);/, "").trimStart();
  // Detect HTML response (FB block/checkpoint) — mark permanent, không retry
  if (trimmed.startsWith("<")) {
    console.error(`[AutoBill:bg] Upload returned HTML (FB block). First 200 chars: ${trimmed.slice(0, 200)}`);
    const err = new Error("Upload: FB returned HTML (account restricted or session expired)");
    err.permanent = true;
    err.htmlResponse = true;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    const err = new Error(`Upload: response not JSON: ${e.message}`);
    err.permanent = true;
    throw err;
  }
  const meta = json?.payload?.metadata?.[0];
  if (!meta) throw new Error("Upload failed: " + trimmed.slice(0, 200));
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
    // __spin_dev_mhenv (spin field thứ 4) — Pancake set khi SiteData có
    ...(_siteData.__spin_dev_mhenv ? { __spin_dev_mhenv: _siteData.__spin_dev_mhenv } : {}),
    __s: _siteData.__s,
    fb_dtsg: _fbDtsg,
    [_sprinkleParamName]: _jazoest,   // jazoest SAU fb_dtsg
    lsd: _lsd,
    // force_blue=1 — Pancake official set khi SiteData.force_blue truthy
    // → FB classify request là "Business UI thật" thay vì bot/incomplete
    ...(_siteData.force_blue ? { force_blue: _siteData.force_blue } : {}),
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

  // Headers: match Pancake exactly — Content-Type + X-MSGR-Region + Referer (giả lập user đang ở inbox)
  const r = await fetch("https://business.facebook.com/messaging/send/", {
    method: "POST",
    body,
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-MSGR-Region": _msgrRegion,
      "Referer": `https://business.facebook.com/latest/inbox/messenger?asset_id=${pageId}&nav_ref=diode_page_inbox`,
    },
  });

  const resText = await r.text();
  console.log(`[AutoBill:bg] messaging/send ${r.status}: ${resText.slice(0, 400)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);

  // Nếu FB trả HTML (login/checkpoint/block page) thay vì JSON → session hỏng, cần refresh context
  const trimmed = resText.replace(/^for\s*\(;;\);/, "").trimStart();
  if (trimmed.startsWith("<")) {
    console.error(`[AutoBill:bg] FB returned HTML (session/checkpoint issue). First 200 chars: ${trimmed.slice(0, 200)}`);
    const err = new Error("FB returned HTML (session expired or checkpoint). Try relogin Facebook.");
    err.permanent = true;   // đừng retry vô ích
    err.htmlResponse = true;
    throw err;
  }
  let json;
  try {
    json = JSON.parse(trimmed);
  } catch (parseErr) {
    console.error(`[AutoBill:bg] Failed to parse FB response: ${parseErr.message}. Body: ${trimmed.slice(0, 200)}`);
    const err = new Error(`FB response not JSON: ${parseErr.message}`);
    err.permanent = true;
    throw err;
  }

  // FB có thể trả 200 OK nhưng vẫn lỗi. Check đầy đủ các field lỗi:
  if (json.error || json.errorSummary || json.errorCode || json.errorDescription) {
    const errInfo = {
      error: json.error, errorCode: json.errorCode,
      summary: json.errorSummary, desc: json.errorDescription,
    };
    // 1545041 là permanent ("person unavailable") — mark non-retryable để Python bỏ qua sớm.
    const permanent = [1545041].includes(json.error);
    console.error(`[AutoBill:bg] FB error${permanent ? " (PERMANENT, skip retry)" : ""}:`, JSON.stringify(errInfo));
    const err = new Error(`FB error: ${JSON.stringify(errInfo)}`);
    err.permanent = permanent;
    throw err;
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

async function handleSendMessage({ conversation_id, message, image_base64, page_id, recipient_psid }) {
  _recordSeenPageId(page_id);   // fire-and-forget, để lần sau tự warmup

  // Pancake official getErrorHandler: các error code này → restartInbox (refresh context + retry).
  // Nguồn: 0.5.41_0/scripts/background.js — retryableErrors = [1357004,1545012,1545006,3252001,1390008]
  //   1357004 = token (fb_dtsg) hết hạn
  //   1545012 = "Temporary Failure" (transient)
  //   1545006 = ảnh attachment expired → cần reupload
  //   3252001 = anti-abuse từ chối (request shape)
  //   1390008 = rate limit ngầm
  const RESTART_INBOX_ERRORS = [1357004, 1545012, 1545006, 3252001, 1390008];

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureFbContext(page_id, /* forceRefresh */ attempt > 0);
      // Python đã fetch PSID từ Pancake POS (field global_id) → dùng thẳng.
      // Nếu không có, fallback về logic resolve cũ (thường fail vì FB đã đổi query).
      let recipientId;
      if (recipient_psid) {
        console.log(`[AutoBill:bg] Using provided PSID from Pancake: ${recipient_psid}`);
        recipientId = recipient_psid;
      } else {
        recipientId = await resolveRecipientId(conversation_id, page_id);
      }
      let attachmentId = null;
      if (image_base64) attachmentId = await uploadImage(image_base64, page_id);
      return await sendMessage(recipientId, message, attachmentId, page_id);
    } catch (e) {
      // Không retry nếu FB trả HTML (session/checkpoint/block) hoặc error đã đánh dấu permanent
      if (e.permanent || e.htmlResponse) {
        console.error("[AutoBill:bg] Error (permanent, skip retry):", e.message);
        return { success: false, error: e.message, permanent: true };
      }
      // Extract FB error code từ message (sendMessage throw err với JSON ở trong)
      const codeMatch = e.message.match(/"error":(\d+)/);
      const fbErrorCode = codeMatch ? parseInt(codeMatch[1], 10) : null;
      const isRestartable = fbErrorCode && RESTART_INBOX_ERRORS.includes(fbErrorCode);
      const isTokenError = /dtsg|logged.{0,5}in|1357004/i.test(e.message);

      if ((isRestartable || isTokenError) && attempt < 1) {
        console.warn(`[AutoBill:bg] FB error ${fbErrorCode || 'token'} → restartInbox: force refresh context + retry`);
        _clearFbContext();
        // Backoff ngắn: 1-2s (giữ tổng < 30s WS timeout)
        await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() * 1000)));
        continue;
      }
      console.error("[AutoBill:bg] Error:", e.message);
      return { success: false, error: e.message, permanent: !!e.permanent };
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
  if (msg.type === "fb_warmup") {
    (async () => {
      const pageIds = Array.isArray(msg.page_ids) ? msg.page_ids : [];
      for (const pid of pageIds) await _recordSeenPageId(pid);
      if (pageIds.length === 0) {
        sendResponse({ success: false, error: "No page_ids provided" });
        return;
      }
      const ok = await warmupPageId(pageIds[0]);
      sendResponse({ success: ok, doc_ids_total: Object.keys(_docIds).length, target: _docIds["PagesManagerInboxAdminAssignerRootQuery"] || null });
    })();
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

// Startup: load cached doc_ids, warmup context + scrape chunks cho page đã lưu
(async () => {
  await loadDocIds();
  await warmupFromStoredPages();
})();

chrome.alarms.create("keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") ensureOffscreen();
});

ensureOffscreen();
console.log("[AutoBill:bg] Service worker started v5.8.4");
