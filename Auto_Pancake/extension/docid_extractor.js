/**
 * docid_extractor.js - Content Script on business.facebook.com
 *
 * Chỉ làm 1 việc: scan các <script src> đã load trong browser
 * (đã có trong cache → rất nhanh) để tìm relay doc_ids,
 * rồi push vào background service worker.
 *
 * Chạy mỗi khi user mở bất kỳ trang nào của business.facebook.com.
 */

"use strict";

(async function () {
  const TARGET = "PagesManagerInboxAdminAssignerRootQuery";

  function searchDocIds(text) {
    const found = {};
    for (const m of text.matchAll(/operationKind:"[^"]*",name:"([^"]+)",id:"(\d+)"/g))
      found[m[1]] = m[2];
    for (const m of text.matchAll(/id:"(\d+)",[^"]{0,80}name:"([^"]+)"/g))
      found[m[2]] = m[1];
    for (const m of text.matchAll(/__d\("([^"]+)_facebookRelayOperation"[^)]*\)[^"]*"(\d+)"/g))
      found[m[1]] = m[2];
    for (const m of text.matchAll(/__d\("([^"]+)"[^)]*\).+?__getDocID=function\(\)\{return"(\d+)"/g))
      found[m[1]] = m[2];
    // Thêm pattern: name trước id
    for (const m of text.matchAll(/name:"([^"]+)",[^"]{0,80}id:"(\d+)"/g))
      found[m[1]] = m[2];
    return found;
  }

  // Scan inline HTML trước
  const pageHtml = document.documentElement.outerHTML;
  let allDocIds = searchDocIds(pageHtml);

  // Lấy tất cả <script src> đã load (trong browser cache)
  const srcs = [...document.querySelectorAll("script[src]")]
    .map(s => s.src)
    .filter(s => s.startsWith("https://"));

  console.log(`[AutoBill:extractor] Scanning ${srcs.length} scripts...`);

  // Fetch song song (cached → fast)
  await Promise.all(srcs.map(async (url) => {
    try {
      const r = await fetch(url);
      const found = searchDocIds(await r.text());
      Object.assign(allDocIds, found);
    } catch (_) {}
  }));

  const count = Object.keys(allDocIds).length;
  const hasTarget = !!allDocIds[TARGET];
  console.log(`[AutoBill:extractor] Found ${count} doc_ids, ${TARGET}=${allDocIds[TARGET] || "MISSING"}`);

  // Push vào background để cache vào chrome.storage.local
  if (count > 0) {
    chrome.runtime.sendMessage({ type: "doc_ids_from_page", docIds: allDocIds })
      .catch(() => {});
  }

  // Nếu chưa có target, theo dõi scripts mới được inject vào (bootloader lazy load)
  if (!hasTarget) {
    const observer = new MutationObserver(async (mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.tagName === "SCRIPT" && node.src?.startsWith("https://")) {
            try {
              const r = await fetch(node.src);
              const found = searchDocIds(await r.text());
              if (Object.keys(found).length > 0) {
                chrome.runtime.sendMessage({ type: "doc_ids_from_page", docIds: found }).catch(() => {});
                if (found[TARGET]) {
                  console.log(`[AutoBill:extractor] Found ${TARGET}=${found[TARGET]} (lazy)`);
                  observer.disconnect();
                }
              }
            } catch (_) {}
          }
        }
      }
    });
    observer.observe(document.head, { childList: true });
    // Dừng observe sau 60s
    setTimeout(() => observer.disconnect(), 60000);
  }
})();
