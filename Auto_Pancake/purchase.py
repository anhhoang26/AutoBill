import requests
import json
import time
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os
load_dotenv(os.path.join(os.path.dirname(__file__), ".env.example"), override=True)
POS_PANCAKE_API_KEY = os.getenv("POS_PANCAKE_API_KEY")
PANCAKE_ACCESS_TOKEN = os.getenv("PANCAKE_ACCESS_TOKEN")
SHOP_ID = os.getenv("SHOP_ID")
def getShipmentAnousith(accessToken, skip, limit, iter=0):
    before = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
    tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    if iter > 6:
        return []
    iter += 1
    url = "https://pro.api.anousith.express/graphql"
    payload = {
    "operationName": "ItemsV2",
    "variables": {
        "where": {
            "customerId": 7715280,
            "isDeleted": 0,
            "originReceiveDate_gte": before,
            "originReceiveDate_lt": tomorrow,
            "multipleItemStatus": [
                "TRANSIT_TO_DEST_BRANCH",
                "TRANSIT_TO_ORIGIN_BRANCH",
                "DEST_BRANCH_RECEIVED_FORWARD",
                "ORIGIN_BRANCH_RECEIVED_BACKWARD",
                "DEST_BRANCH_RECEIVED_BACKWARD",
                "ORIGIN_BRANCH_RECEIVED_FORWARD",
                "COMPLETED"
            ],
        },
        "orderBy": "originReceiveDate_DESC",
        "skip": skip,
        "limit": limit
    },
    "query": "query ItemsV2($where: ItemV2WhereInput, $skip: Int, $limit: Int, $noLimit: Boolean, $orderBy: OrderByItem) {\n  itemsV2(where: $where, skip: $skip, limit: $limit, noLimit: $noLimit, orderBy: $orderBy) {\n    total\n    data {\n      _id\n      trackingId\n      itemName\n      itemValueKIP\n      itemValueTHB\n      itemValueUSD\n      realItemValueKIP\n      realItemValueTHB\n      realItemValueUSD\n      receiverName\n      receiverPhone\n      description\n      trackingPlatform\n      isSummary\n      destSendDate\n      charge_on_shop\n      itemStatus\n      contactStatus\n      originSendDate\n      receiveBackwardDate\n      width\n      weight\n      isCod\n      isExtraItem\n      packagePrice\n      isDeposit\n      originReceiveDate\n      destReceiveDate\n      sendCompleteDate\n      isCustomerCreated\n      isBackward\n      billNumber\n      providedBy {\n        _id\n      }\n      originProvinceId {\n        provinceName\n      }\n      destProvinceId {\n        provinceName\n      }\n      originBranchId {\n        branch_name\n      }\n      destBranchId {\n        branch_name\n        branch_address\n        districtName\n        contactInfo\n      }\n      customerId {\n        id_list\n        full_name\n        contact_info\n      }\n      createdBy {\n        first_name\n        phone_number\n      }\n      originReceiveBy {\n        first_name\n        phone_number\n      }\n    }\n  }\n}"
    }
    headers = {
        "content-type": "application/json",
        "accept": "*/*",
        "authorization": accessToken,
        "Referer": "https://app.anousith.express/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua": "\"Chromium\";v=\"146\", \"Not-A.Brand\";v=\"24\", \"Google Chrome\";v=\"146\"",
        "sec-ch-ua-mobile": "?0",
    }

    response = requests.post(url, json=payload, headers=headers)
    if response.status_code == 200:
        result = response.json()
        if result.get("data") and result["data"].get("itemsV2"):
            return result["data"]["itemsV2"]["data"]
        print(f"[ANOUSITH] API returned error: {json.dumps(result.get('errors', []), ensure_ascii=False)[:300]}")
        return []
    else:
        print(response.text)
        time.sleep(60)
        print("Try get purchase")
        return getShipmentAnousith(accessToken, skip, limit, iter)
        
def _purge_old_bills(bills, date_key, max_days=3):
    """Remove bills older than max_days based on date_key field."""
    cutoff = (datetime.now() - timedelta(days=max_days)).isoformat()
    kept = [b for b in bills if (b.get(date_key) or "") >= cutoff]
    removed = len(bills) - len(kept)
    if removed:
        print(f"[CLEANUP] Purged {removed} bills older than {max_days} days")
    return kept

def getAllShipmentAnousith(accessToken):
    # Load existing bills for dedup
    existing_ids = set()
    if os.path.exists("listShipmentAnousith.json"):
        try:
            existing = json.load(open("listShipmentAnousith.json", "r", encoding="utf-8"))
            existing = _purge_old_bills(existing, "originReceiveDate", max_days=3)
            existing_ids = {b["_id"] for b in existing}
        except Exception:
            existing = []
    else:
        existing = []

    # Fetch bills DESC, stop early when hitting existing bill
    new_bills = []
    skip = 0
    hit_existing = False
    while not hit_existing:
        page = getShipmentAnousith(accessToken, skip, 100)
        if not page:
            break
        for b in page:
            if b["_id"] in existing_ids:
                hit_existing = True
                break
            new_bills.append(b)
        skip += len(page)

    if new_bills:
        existing.extend(new_bills)
        with open("listShipmentAnousith.json", "w", encoding="utf-8") as file:
            file.write(json.dumps(existing, indent=4))

    print(f"Total bill in Anousith: {len(new_bills)} new, {len(existing)} total saved")

def getShipmentHal(accessToken, cursor = None, iter=0):
    today = time.strftime("%Y-%m-%d", time.localtime())
    before = time.strftime("%Y-%m-%d", time.localtime(time.time() - 3 * 24 * 60 * 60))
    # print(before, today)
    if cursor:
        url = f"https://hal.hal-logistics.la/api/v1/auth/users/me/shipments/orders?status=arrived_status&sort_order=desc&use_cursor=true&cursor={cursor}&start_date={before}&end_date={today}&limit=100"
    else:
        url = f"https://hal.hal-logistics.la/api/v1/auth/users/me/shipments/orders?status=arrived_status&sort_order=desc&use_cursor=true&start_date={before}&end_date={today}&limit=100"
    headers = {
        "Authorization": f"Bearer {accessToken}"
    }
    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        time.sleep(10)
        getShipmentHal(accessToken, cursor, iter+1)
    response = response.json()
    if iter > 10:
        return
    return response

def getAllShipmentHal(accessToken):
    # Load existing for early stop
    existing_ids = set()
    if os.path.exists("listShipmentHal.json"):
        try:
            existing = json.load(open("listShipmentHal.json", "r", encoding="utf-8"))
            existing = _purge_old_bills(existing, "start_date_actual", max_days=3)
            existing_ids = {b["id"] for b in existing}
        except Exception:
            existing = []
    else:
        existing = []

    # Fetch bills DESC, stop early when hitting existing bill
    new_bills = []
    nextCursor = None
    hit_existing = False
    while not hit_existing:
        data = getShipmentHal(accessToken, nextCursor)
        if not data or not data.get("data"):
            break
        for b in data["data"]:
            if b["id"] in existing_ids:
                hit_existing = True
                break
            new_bills.append(b)
        nextCursor = data.get("next_cursor")
        if not nextCursor:
            break

    if new_bills:
        existing.extend(new_bills)

    with open("listShipmentHal.json", "w", encoding="utf-8") as f:
        json.dump(existing, f, indent=4)

    print(f"Total bill in Hal: {len(new_bills)} new, {len(existing)} total saved")

def getAllShipment():
    df = json.load(open("token.json"))
    getAllShipmentAnousith(df["anousith"]["accessToken"])
    getAllShipmentHal(df["hal"]["accessToken"])

def getAllBillInPancake():

    def getBill(page=0):
        url = f'https://pos.pancake.vn/api/v1/shops/{SHOP_ID}/orders?api_key={POS_PANCAKE_API_KEY}&filter_status[]=8&filter_status[]=9&page_size=200&&page={page}'
        # print(url)    
        headers = {
            'Content-Type': 'application/json'
        }
        respoonse = requests.request("GET", url=url, headers=headers)
        if respoonse.status_code // 200 == 1:
            respoonse = respoonse.json()
            # print(orderId, respoonse)
            return respoonse["data"]
        return []
    page = 1
    allBill = []
    while True:
        bills = getBill(page)
        if len(bills) == 0:
            break
        allBill += bills
        page += 1
    with open("listBillInPancake.json", "w") as f:
        f.write(json.dumps(allBill, indent=4))
        f.close()
    print(f"Total bill in Pancake: {len(allBill)}")
    return allBill

def getAllBillNeedProcess():
    listBillInPancake = json.load(open("listBillInPancake.json"))
    listShipmentAnousith = json.load(open("listShipmentAnousith.json"))
    listShipmentHal = json.load(open("listShipmentHal.json"))
    dictShipmentAnousith = {bill["receiverName"]: bill for bill in listShipmentAnousith}
    dictShipmentHal = {bill["receiver_customer"]["name"]: bill for bill in listShipmentHal}
    
    listBillNeedProcess = []
    for bill in listBillInPancake:
        if bill["id"] in dictShipmentAnousith:
            listBillNeedProcess.append((bill, dictShipmentAnousith[bill["id"]], False))
        elif bill["id"] in dictShipmentHal:
            listBillNeedProcess.append((bill, dictShipmentHal[bill["id"]], True))
    return listBillNeedProcess
if __name__ == "__main__":
    getAllBillInPancake()