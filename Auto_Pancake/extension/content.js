/**
 * AutoBill Messenger - Content Script v5.6.0
 *
 * Chạy trên business.facebook.com (giống Pancake v2).
 * Lợi thế so với offscreen:
 *  - document.cookie có c_user
 *  - document.querySelectorAll('script[src]') thấy bundle đã load (browser cache)
 *  - fetch() cùng origin → cookies tự gửi
 *
 * NOTE: File này KHÔNG được inject qua manifest.json content_scripts.
 * Nếu muốn dùng, cần inject thủ công hoặc thêm vào manifest.
 * Primary path hiện tại: offscreen.js → background.js
 *
 * Flow:
 *  1. Connect WebSocket → ws_server.py
 *  2. Nhận send_message
 *  3. ensureFbContext: đọc dtsg/siteData từ DOM, scan scripts cho doc_id
 *  4. resolveRecipient: GraphQL PagesManagerInboxAdminAssignerRootQuery
 *  5. sendMessage: POST business.facebook.com/messaging/send/
 */

"use strict";

const WS_URL = "ws://localhost:8765";

let ws = null;
let reconnectTimer = null;

// FB context
let fbDtsg = null;
let fbUserId = null;
let lsd = "";
let msgrRegion = "PRN";
let siteData = {};
let reqCount = 0;
let sprinkleParamName = "jazoest";
let sprinkleVersion = 2;
// Pancake webSession.getId() format: sessionId:activityId:tabId
const webSessionId = Math.floor(Math.random()*1e9).toString(36).slice(0,6) + ":" +
  Math.floor(Math.random()*1e9).toString(36).slice(0,6) + ":" +
  Math.floor(Math.random()*Math.pow(36,6)).toString(36).padStart(6,"0");

// doc_id cache (Pancake: DocIdRegistry / At)
const docIds = {};

// PSID cache: threadId → PSID
const recipientCache = {};

// ── WebSocket ──────────────────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  console.log("[AutoBill] Connecting to ws_server...");
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[AutoBill] Connected ✓");
    clearTimeout(reconnectTimer);
    ws.send(JSON.stringify({ type: "ext_hello" }));
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.action === "ping") {
      ws.send(JSON.stringify({ action: "pong" }));
      return;
    }

    if (msg.action === "send_message") {
      console.log(`[AutoBill] send_message conv=${msg.conversation_id} page=${msg.page_id}`);
      const result = await handleSendMessage(msg);
      ws.send(JSON.stringify({ action: "result", correlation_id: msg.correlation_id, ...result }));
    }
  };

  ws.onclose = () => {
    console.log("[AutoBill] Disconnected, retry 5s");
    reconnectTimer = setTimeout(connect, 5000);
  };

  ws.onerror = () => ws.close();
}

// ── Facebook Context ───────────────────────────────────────────────────────────

async function ensureFbContext(pageId) {
  if (fbDtsg) return;

  // 1. Đọc từ DOM hiện tại (đang ở Business Suite)
  const pageHtml = document.documentElement.outerHTML;
  extractContextFromHtml(pageHtml);

  if (fbDtsg) {
    // Scan các script đã load trong trang (browser cache → rất nhanh)
    console.log("[AutoBill] Scanning loaded scripts for doc_ids...");
    await scanLoadedScripts();
  } else {
    // Fetch trang inbox nếu chưa có context
    const url = `https://business.facebook.com/latest/inbox/all${pageId ? "?asset_id=" + pageId : ""}`;
    console.log(`[AutoBill] Fetching context: ${url}`);
    const r = await fetch(url, { credentials: "include" });
    if (!r.ok) throw new Error(`Context fetch ${r.status}`);
    const html = await r.text();
    extractContextFromHtml(html);
    if (!fbDtsg) throw new Error("Cannot extract fb_dtsg - are you logged in?");
    await scanHtmlScripts(html);
  }

  // 2. Nếu vẫn thiếu target doc_id, thử bootloader endpoint
  if (!docIds["PagesManagerInboxAdminAssignerRootQuery"]) {
    await tryBootloader();
  }

  console.log(`[AutoBill] Context ready: userId=${fbUserId} docIds=${Object.keys(docIds).length} target=${docIds["PagesManagerInboxAdminAssignerRootQuery"] || "MISSING"}`);
}

function extractContextFromHtml(html) {
  // fb_dtsg — giống Pancake ctxFromHtml
  if (!fbDtsg) {
    for (const pat of [
      /"DTSGInitialData",\[\],\{"token":"([^"]+)"/i,
      /"DTSGInitData",\[\],\{"token":"([^"]+)"/i,
      /name="fb_dtsg" value="([^"]+)"/,
      /"token":"([^"]+)","ttl":\d+/,
      /"name":"fb_dtsg","value":"([^"]+)"/,
    ]) {
      const m = html.match(pat);
      if (m) { fbDtsg = m[1]; break; }
    }
    if (!fbDtsg) {
      const mrcM = html.match(/"dtsg":\{"token":"([^"]+)"/);
      if (mrcM) fbDtsg = mrcM[1];
    }
  }

  // LSD token — Pancake: ["MRequestConfig",[],{...},N].token
  if (!lsd) {
    const mrcM = html.match(/\["MRequestConfig",\[\],([^\]]+),\d+\]/);
    if (mrcM) { try { lsd = JSON.parse(mrcM[1])?.token || ""; } catch (_) {} }
    if (!lsd) {
      const lsdM = html.match(/\["LSD",\[\],\{"token":"([^"]+)"\}/);
      if (lsdM) lsd = lsdM[1];
    }
  }

  // SprinkleConfig — Pancake sprinkle_config.param_name + version
  if (sprinkleParamName === "jazoest") {
    const sprinkleM = html.match(/\["SprinkleConfig",\[\],\{"param_name":"([^"]+)","version":(\d+)/);
    if (sprinkleM) {
      sprinkleParamName = sprinkleM[1];
      sprinkleVersion = parseInt(sprinkleM[2], 10);
    }
  }

  // userId từ cookie (chỉ hoạt động trong content script)
  if (!fbUserId) {
    fbUserId = document.cookie.match(/c_user=(\d+)/)?.[1] || null;
  }

  // msgrRegion
  if (msgrRegion === "PRN") {
    const mrcConfM = html.match(/\["MercuryServerRequestsConfig",\[\],\{"msgrRegion":"([^"]+)"\}/);
    if (mrcConfM) msgrRegion = mrcConfM[1];
    else {
      const rmM = html.match(/"(?:regionNullable|msgrRegion)":"(\w+)"/);
      if (rmM) msgrRegion = rmM[1];
    }
  }

  // WebConnectionClassServerGuess → __ccg
  let ccg = "EXCELLENT";
  const wccM = html.match(/\["WebConnectionClassServerGuess",\[\],([^\]]+),\d+\]/);
  if (wccM) { try { ccg = JSON.parse(wccM[1])?.connectionClass || ccg; } catch (_) {} }

  // SiteData — đầy đủ như background.js / Pancake buildParams
  if (!siteData.__rev) {
    let sd = {};
    const sdM = html.match(/\["SiteData",\[\],([^\]]+),\d+\]/);
    if (sdM) { try { sd = JSON.parse(sdM[1]); } catch (_) {} }

    const clientRevision = sd.client_revision ? String(sd.client_revision)
      : (html.match(/client_revision":(\d+)/)?.[1] || "");

    // jazoest v2 = "2" + sum(charCodes of dtsg)
    let ttstamp = "2";
    if (fbDtsg) {
      for (let i = 0; i < fbDtsg.length; i++) ttstamp += fbDtsg.charCodeAt(i);
    }

    siteData = {
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
      __s:         webSessionId,
      jazoest:     ttstamp,
    };
  }

  // Scan inline cho doc_ids
  searchDocIds(html);
}

// Scan tất cả <script src> đã load trong page (từ browser cache)
async function scanLoadedScripts() {
  const TARGET = "PagesManagerInboxAdminAssignerRootQuery";
  const srcs = [...document.querySelectorAll("script[src]")]
    .map((s) => s.src)
    .filter((s) => s.startsWith("https://"));

  console.log(`[AutoBill] ${srcs.length} scripts in page, fetching (cached)...`);

  await Promise.all(
    srcs.map(async (url) => {
      if (docIds[TARGET]) return;
      try {
        const r = await fetch(url);
        searchDocIds(await r.text());
      } catch (_) {}
    })
  );

  console.log(`[AutoBill] Scan done: ${Object.keys(docIds).length} doc_ids, target=${docIds[TARGET] || "not found"}`);
}

// Parse resource_map từ HTML rồi fetch từng JS file
async function scanHtmlScripts(html) {
  const TARGET = "PagesManagerInboxAdminAssignerRootQuery";
  const jsUrls = new Set();

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
  for (const m of html.matchAll(/<script[^>]+src="(https?:[^"]+)"/g)) {
    jsUrls.add(m[1]);
  }

  console.log(`[AutoBill] Fetching ${jsUrls.size} JS files...`);

  const urls = [...jsUrls];
  const BATCH = 8;
  for (let i = 0; i < urls.length; i += BATCH) {
    if (docIds[TARGET]) break;
    await Promise.all(
      urls.slice(i, i + BATCH).map(async (url) => {
        if (docIds[TARGET]) return;
        try {
          const r = await fetch(url);
          searchDocIds(await r.text());
        } catch (_) {}
      })
    );
  }
}

// Facebook bootloader endpoint để load module trực tiếp
async function tryBootloader() {
  const TARGET = "PagesManagerInboxAdminAssignerRootQuery";
  const mods = [
    "PagesManagerInboxAdminAssignerRootQuery",
    "PagesManagerInboxContainer.react",
    "BusinessInboxAdminAssigner.react",
  ];

  for (const mod of mods) {
    if (docIds[TARGET]) break;
    try {
      const hs = encodeURIComponent(siteData.__hs || "");
      const url = `https://business.facebook.com/ajax/bootloader-endpoint/?modules=${encodeURIComponent(mod)}&__a=1&__hs=${hs}`;
      console.log(`[AutoBill] Bootloader: ${mod}`);
      const r = await fetch(url, { credentials: "include" });
      searchDocIds(await r.text());
      if (docIds[TARGET]) console.log(`[AutoBill] Bootloader found doc_id=${docIds[TARGET]}`);
    } catch (e) {
      console.warn(`[AutoBill] Bootloader error: ${e.message}`);
    }
  }
}

// Pancake loadResource patterns
function searchDocIds(text) {
  for (const m of text.matchAll(/operationKind:"[^"]*",name:"([^"]+)",id:"(\d+)"/g)) {
    docIds[m[1]] = m[2];
  }
  for (const m of text.matchAll(/id:"(\d+)",[^"]{0,60}name:"([^"]+)"/g)) {
    docIds[m[2]] = m[1];
  }
  for (const m of text.matchAll(/__d\("([^"]+)_facebookRelayOperation"[^)]*\)[^"]*"(\d+)"/g)) {
    docIds[m[1]] = m[2];
  }
  for (const m of text.matchAll(/__d\("([^"]+)"[^)]*\).+?__getDocID=function\(\)\{return"(\d+)"/g)) {
    docIds[m[1]] = m[2];
  }
}

function balancedJson(str, start) {
  let depth = 0;
  for (let i = start; i < str.length; i++) {
    if (str[i] === "{") depth++;
    else if (str[i] === "}") {
      depth--;
      if (depth === 0) return str.slice(start, i + 1);
    }
  }
  return null;
}

// ── Resolve threadId → PSID (Pancake: getGlobalIdFromInbox) ───────────────────

async function resolveRecipientId(threadId, pageId) {
  if (recipientCache[threadId]) return recipientCache[threadId];

  const QUERY = "PagesManagerInboxAdminAssignerRootQuery";
  const docId = docIds[QUERY];

  if (!docId) {
    console.warn(`[AutoBill] ${QUERY} not found (${Object.keys(docIds).length} total), using threadId as-is`);
    return threadId;
  }

  console.log(`[AutoBill] Resolving PSID: thread=${threadId} docId=${docId}`);

  const r = await fetch("https://business.facebook.com/api/graphql/", {
    method: "POST",
    body: buildBody({
      av: pageId,
      __user: fbUserId || "",
      __a: "1",
      __req: (reqCount++).toString(36),
      fb_dtsg: fbDtsg,
      ...siteData,
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
  console.log(`[AutoBill] GraphQL ${r.status}: ${text.slice(0, 300)}`);

  const json = JSON.parse(text.replace(/^for\s*\(;;\);/, ""));
  const globalId = json?.data?.commItem?.target_id;

  if (!globalId) {
    console.warn(`[AutoBill] GraphQL no target_id, using threadId`);
    return threadId;
  }

  console.log(`[AutoBill] Resolved: ${threadId} → ${globalId}`);
  recipientCache[threadId] = globalId;
  return globalId;
}

// ── Upload image ───────────────────────────────────────────────────────────────

async function uploadImage(base64Data, pageId) {
  const form = new FormData();
  form.append("upload_1024", base64ToBlob(base64Data), "bill.png");

  const params = new URLSearchParams({
    __user: fbUserId || "0",
    __a: "1",
    fb_dtsg: fbDtsg,
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
  console.log(`[AutoBill] Uploaded image id=${id}`);
  return id;
}

// ── Send message (Pancake: buildSendParams + messaging/send/) ──────────────────

// Pancake generateOfflineThreadingID
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
  // 2. buildParams(): __user, __a, __req, SiteData fields, fb_dtsg, lsd, jazoest
  // 3. Facebook-specific: specific_to_list, other_user_fbid, message_id, client, action_type
  const r = await fetch("https://business.facebook.com/messaging/send/", {
    method: "POST",
    body: buildBody({
      // buildSendParams
      body: text || "",
      offline_threading_id: tid,
      source: "source:page_unified_inbox",
      timestamp: String(Date.now()),
      request_user_id: pageId || "",
      // buildParams() — đầy đủ như Pancake
      __user: fbUserId || "",
      __a: "1",
      __req: (reqCount++).toString(36),
      ...siteData,                           // __csr,__beoa,__pc,dpr,__ccg,__rev,__hsi,__hs,__comet_req,__spin_*,__s,jazoest
      fb_dtsg: fbDtsg,
      [sprinkleParamName]: siteData.jazoest,
      lsd: lsd,
      // facebook-specific (sau buildParams)
      "specific_to_list[0]": `fbid:${recipientId}`,
      "specific_to_list[1]": `fbid:${pageId || fbUserId}`,
      other_user_fbid: recipientId,
      message_id: tid,
      client: "mercury",
      action_type: "ma-type:user-generated-message",
      ephemeral_ttl_mode: "0",
      has_attachment: attachmentId ? "true" : "false",
      ...(attachmentId ? { "image_ids[0]": attachmentId } : {}),
      __usid: "",
    }),
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
      "x-response-format": "JSONStream",
      "x-msgr-region": msgrRegion,
      "Referer": `https://business.facebook.com/latest/inbox/all?asset_id=${pageId}`,
    },
  });

  const resText = await r.text();
  console.log(`[AutoBill] messaging/send ${r.status}: ${resText.slice(0, 300)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${resText.slice(0, 200)}`);

  const json = JSON.parse(resText.replace(/^for\s*\(;;\);/, ""));
  if (json.error) {
    console.error("[AutoBill] FB error:", JSON.stringify(json));
    throw new Error(`FB error: ${JSON.stringify(json.error)}`);
  }
  return { success: true };
}

// ── Main handler ───────────────────────────────────────────────────────────────

async function handleSendMessage({ conversation_id, message, image_base64, page_id }) {
  try {
    await ensureFbContext(page_id);
    const recipientId = await resolveRecipientId(conversation_id, page_id);
    let attachmentId = null;
    if (image_base64) attachmentId = await uploadImage(image_base64, page_id);
    return await sendMessage(recipientId, message, attachmentId, page_id);
  } catch (e) {
    console.error("[AutoBill] Error:", e.message);
    if (/dtsg|logged|auth|session/i.test(e.message)) {
      fbDtsg = null;
      lsd = "";
      msgrRegion = "PRN";
      siteData = {};
    }
    return { success: false, error: e.message };
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

// ── Start ──────────────────────────────────────────────────────────────────────

console.log("[AutoBill] Content script loaded v5.6.0");
connect();
