Manifest v2:
  web_accessible_resources: pancext.html
  - dùng để public resource cho client có thể load (cụ thể ở đây là contentscript.js)

  sandbox: sandbox.html
  - sandbox dùng để chạy một số hàm mà trong extension không cho phép

Manifest v3:
  Luồng thực hiện hàm eval, do không thể gọi hàm eval trong sw và offscreen page nên cần tạo iframe trong offscreen để gọi hàm này (https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Zs40acHcxGw/m/d5eKpfr0BQAJ):
  - service worker -> offscreen page -> sanbox (iframe)
  - KHÔNG NÊN SỬ DỤNG GLOBAL VARIABLE DO WORKER CÓ THỂ BỊ RELOAD NHIỀU LẦN TRONG LIFE TIME
  - KHÔNG ĐĂNG KÝ SỰ KIỆN THÔNG QUA ASYNC
  - HẠN CHẾ SỬ DỤNG setTimeout, setInterval DO TIMER CÓ THỂ BỊ FAIL QUA CÁC LẦN WAKEUP CỦA WORKER

EVENTS:

0 CRAWL_LIVESTREAM_DATA --> merge phần sửa mới (thiếu doc_id)
v BATCH_GET_GLOBAL_ID --> đang không được sử dụng
v LISTEN_IG_COMMENT
v STOP_LISTEN_IG_COMMENT
v PLZ_DONT_STOP_LISTEN_IG_COMMENT_THIS_PAGE
v LISTEN_INBOX
v STOP_LISTEN_INBOX
v PLZ_DONT_STOP_LISTEN_INBOX_THIS_PAGE
v LISTEN_WS
v STOP_LISTEN_WS
v PLZ_DONT_STOP_LISTEN_THIS_PAGE
v SET_ACCESS_TOKEN
v CHECK_EXTENSION_VERSION
v CHECK_EXTENSION
v REPORT_EXTENSION_STATUS
v POS_SYNC_PRODUCT_TO_FBSHOP
v CHANGE_CONV_STATUS_TO_ARCHIVED
v REPLY_INBOX_PRODUCT
v SYNC_PRODUCT_FROM_FBSHOP_TO_POS --> không sử dụng nữa
v PREINITIALIZE_PAGES
v PRELOAD_DOC_IDS
v LOAD_FACEBOOK_MESSAGES
v GET_POST_ID_FROM_LINK
v GET_IMG_FROM_SHARED_ATTACHMENT
v CACHE_PAGES_ROUTING_APP
v UPLOAD_MEDIA_TO_PANCAKE
LINE:INITIALIZE_PAGE
LINE:TURN_ON_RETRY_WEBHOOK
LINE:GET_CONVERSATIONS
APPROVE_APPOINTMENT
DENY_APPOINTMENT










=============================================================================================
v CONFIG_ROUTING_APP

v SEND_COMMENT: Cần chuyển profile cá nhân trước khi gửi comment
v UPLOAD_INBOX_PHOTO
v REPLY_INBOX_PHOTO --> check instagram (case send photo, nếu check theo cả name nữa để tìm đúng customer)
  "PHOTO" v
  "FILE" v -> api
  "TEMPLATE" -> api
  "STICKER" v
  "PRODUCT" -> api
  "AUDIO" -> api
  "VIDEO" v
  "CUSTOMER_ADDRESS" -> api
  "SEND_TEXT_ONLY" v

v SEND_PRIVATE_REPLY
v GET_STICKERS
v GET_PACK_STICKERS
v LOAD_ECOMMERCE_PRODUCT -> không có trên pancake
v SEND_STICKER_COMMENT -> không có trên pancake
v GET_PROFILE_INFO
v GET_PROFILE_LINK
v GET_BIRTHDAY_INFO
v INVITE_LIKE_PAGE
v MAKE_MESSENGER_LINK
v BLOCK_FACEBOOK_USER
v REACT_MESSAGE
v REMOVE_COMMENT --> api đang xoá được nhưng trả về error