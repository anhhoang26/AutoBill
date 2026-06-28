# Plan: Per-Page Parallel Queue

## Vấn đề hiện tại

`_ext_worker_loop` ở [processBill.py:122](processBill.py#L122) chỉ có **1 worker duy nhất** xử lý queue tuần tự.

- Throughput: ~6-10 bill/phút
- 1709 bills / 30 pages → ~4-5 giờ
- Bottleneck: `await asyncio.sleep(EXT_SEND_DELAY=3)` sau mỗi bill chặn toàn bộ queue

Distribution thực tế (snapshot lúc plan):
```
page 284876098048753: 780 bills  (45%)
page 461405200382709: 300 bills  (17%)
page 396243866910001:  97 bills
page 104356132633504:  92 bills
... (26 pages còn lại < 80 bills mỗi page)
```

## Giải pháp: Per-page worker pool

FB rate-limit là **per-page**, không phải global account. → Mỗi page có thể chạy worker riêng với throttle riêng, song song với các page khác.

```
[Queue page A] → worker A → 1 bill / 2s →┐
[Queue page B] → worker B → 1 bill / 2s →┼→ Extension (concurrent fetch)
[Queue page C] → worker C → 1 bill / 2s →┘
   ...
```

**Wall time mới = thời gian của page lớn nhất** (780 bills × 2s ≈ 26 phút).

## Architecture thay đổi

### State mới

Thay `_ext_queue` (single) bằng map per-page:

```python
_page_queues: dict[str, asyncio.Queue] = {}
_page_workers: dict[str, asyncio.Task] = {}
_workers_lock = asyncio.Lock()  # bảo vệ create_worker race
```

### Enqueue (gọi từ `process_bill`)

```python
async def _enqueue_to_page(item: dict):
    page_id = _get_page_id(item["bill_pancake"])
    async with _workers_lock:
        if page_id not in _page_queues:
            _page_queues[page_id] = asyncio.Queue()
            _page_workers[page_id] = asyncio.create_task(
                _page_worker_loop(page_id)
            )
    await _page_queues[page_id].put(item)
```

Cập nhật `process_bill` ở [processBill.py:433](processBill.py#L433) — thay `queue.put({...})` bằng `await _enqueue_to_page({...})`.

### Worker per-page

```python
PER_PAGE_DELAY = 2.0  # giây giữa mỗi bill TRÊN CÙNG page

async def _page_worker_loop(page_id: str):
    from ws_server import send_via_external_server
    queue = _page_queues[page_id]
    while True:
        item = await queue.get()
        bill_pancake = item["bill_pancake"]
        bill_file = item["bill_file"]
        ship_fee = item["ship_fee"]

        # Cooldown check (giữ logic cũ)
        unblock_at = _blocked_pages.get(page_id)
        if unblock_at and time.time() < unblock_at:
            print(f"[EXT-Q:{page_id[-6:]}] Drop {bill_pancake['id']} (cooldown)")
            queue.task_done()
            continue

        # PSID fetch + send loop (copy nguyên từ _ext_worker_loop)
        # ... (giữ nguyên đoạn từ L149-L195 của processBill.py hiện tại)

        queue.task_done()
        await asyncio.sleep(PER_PAGE_DELAY)
```

### Khởi tạo

`start_ext_worker` ở [processBill.py:106](processBill.py#L106) chỉ cần làm 1 việc: đảm bảo lock + dict tồn tại. Workers tự sinh khi có bill đầu tiên của page đó.

### Cleanup

Khi shutdown:
```python
async def stop_all_workers():
    for task in _page_workers.values():
        task.cancel()
    await asyncio.gather(*_page_workers.values(), return_exceptions=True)
```

## Cấu hình rate limit

| Setting | Hiện tại | Đề xuất | Lý do |
|---|---|---|---|
| `EXT_SEND_DELAY` (global) | 3s | **Xóa** | Không còn ý nghĩa với per-page worker |
| `PER_PAGE_DELAY` | — | **2s** | An toàn cho FB throttle per-page (~1800/h/page) |
| `EXT_PAGE_COOLDOWN` | 15 min | 15 min | Giữ nguyên |
| `MAX_CONCURRENT_PAGES` | — | **Tùy chọn, mặc định không giới hạn** | Nếu lo lắng resource, dùng Semaphore giới hạn (vd N=10) |

### Tùy chọn: giới hạn concurrency

Nếu sợ 30 workers spam fetch cùng lúc:

```python
_send_semaphore = asyncio.Semaphore(10)  # max 10 worker gửi đồng thời

# Trong worker loop:
async with _send_semaphore:
    result = await send_via_external_server(...)
```

→ Vẫn có 30 worker nhưng chỉ 10 fetch chạy đồng thời. Compromise giữa throughput và an toàn.

## Estimated improvement

| Approach | Wall time (1709 bills) |
|---|---|
| Hiện tại (1 worker, 3s delay) | ~4.5h |
| Per-page parallel, delay 2s | **~26 phút** (page lớn nhất 780 × 2s) |
| Per-page + delay 1.5s | ~20 phút |
| Concurrency cap 10, delay 2s | ~35 phút |

## Edge cases cần xử lý

1. **Bill mới cho page chưa có worker** → enqueue tự create worker (đã có trong code skeleton)
2. **Worker crash giữa chừng** → cần wrap loop trong try/except + restart logic; hoặc dùng `Task.add_done_callback` log error
3. **Cooldown page → bill bị drop** → giữ logic hiện tại, bill sẽ được main.py cycle sau fetch lại
4. **Pancake POS lock per-page** → check xem `_full_bills_cache` và `_blocked_pages` có thread-safe không (asyncio single-thread → OK, không cần lock)
5. **WS server overload**: extension chỉ có 1 service worker → nếu spawn 30 worker gửi simultaneously, các request sẽ queue trong WS server. Cần test xem có gây timeout không.

## Implementation checklist

- [ ] Backup `processBill.py` trước khi sửa
- [ ] Thay `_ext_queue` → `_page_queues` dict
- [ ] Tách `_ext_worker_loop` → `_page_worker_loop(page_id)`
- [ ] Thêm `_enqueue_to_page()` helper
- [ ] Cập nhật `process_bill` để gọi enqueue mới
- [ ] Xóa `EXT_SEND_DELAY`, thêm `PER_PAGE_DELAY`
- [ ] (Optional) Thêm `MAX_CONCURRENT_PAGES` semaphore
- [ ] Test với 5-10 bills trước, sau đó scale
- [ ] Monitor FB error rate — nếu 1545012/3252001 tăng đột biến → tăng `PER_PAGE_DELAY`
- [ ] Cleanup logic trong shutdown handler ở main.py

## Câu hỏi cần quyết định trước khi code

1. Có cần `MAX_CONCURRENT_PAGES` semaphore không, hay để 30 worker fully parallel?
2. `PER_PAGE_DELAY` chọn 1.5s, 2s, hay 3s?
3. Có muốn priority queue (page nhiều bill ưu tiên trước) không? Hay FIFO bình thường?
4. Khi worker idle (queue rỗng), kill task hay giữ alive chờ bill mới?
