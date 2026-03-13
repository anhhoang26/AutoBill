import requests
import json
import time
from datetime import datetime, timedelta
from dotenv import load_dotenv
import os
load_dotenv(override=True)
POS_PANCAKE_API_KEY = os.getenv("POS_PANCAKE_API_KEY")
PANCAKE_ACCESS_TOKEN = os.getenv("PANCAKE_ACCESS_TOKEN")
SHOP_ID = os.getenv("SHOP_ID")
def getShipmentAnousith(accessToken, skip, limit, iter=0):
    today = datetime.now().strftime("%Y-%m-%d")
    before = (datetime.now() - timedelta(days=2)).strftime("%Y-%m-%d")
    after = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
    if iter > 6:
        return []
    iter += 1
    url = "https://pro.api.anousith.express/graphql"
    payload = {
    "operationName": "ItemsV2",
    "variables": {
        # "where": {
        # "itemStatus": "ORIGIN_BRANCH_RECEIVED_FORWARD",
        # "originBranchId": 338,
        # "customerId": "6936939"
        # },
        # "orderBy": "originReceiveDate_DESC",
        # "skip": skip,
        # "limit": limit
        "where": {
            "multipleItemStatus": [
            "TRANSIT_TO_DEST_BRANCH",
            "TRANSIT_TO_ORIGIN_BRANCH",
            "DEST_BRANCH_RECEIVED_FORWARD",
            "ORIGIN_BRANCH_RECEIVED_BACKWARD",
            "DEST_BRANCH_RECEIVED_BACKWARD",
            "ORIGIN_BRANCH_RECEIVED_FORWARD",
            "COMPLETED"
            ],
            "originReceiveDate_gte": before,
            "originReceiveDate_lt": after,
            "searchMultipleCOD": [
            "0",
            "1"
            ],
            "customerId": 6936939,
            "isDeleted": 0
        },
        "orderBy": "originReceiveDate_DESC",
        "skip": skip,
        "limit": limit
    },
    
    "query": '''query ItemsV2($where: ItemV2WhereInput, $orderBy: OrderByItem, $skip: Int, $limit: Int) {
        itemsV2(where: $where, orderBy: $orderBy, skip: $skip, limit: $limit) {
            total
            data {
            _id
            trackingId
            itemName
            itemValueKIP
            itemValueTHB
            itemValueUSD
            receiverName
            receiverPhone
            originReceiveDate
            charge_on_shop
            width
            weight
            packagePrice
            itemStatus
            isInsurance
            priceItem
            insuranceAmount
            isOvertime
            customerId {
                id_list
                full_name
                contact_info
            }
            destProvinceId {
                provinceName
            }
            originBranchId {
                branch_name
            }
            originProvinceId {
                provinceName
            }
            destBranchId {
                districtName
                branch_name
            }
            updatedBy
            updatedDate
            }
        }
    }'''
    }
    headers = {
        "content-type": "application/json",
        "Accept-Language": "vi-VN,vi;q=0.9",
        "Connection": "keep-alive",
        "Origin": "https://nextday.anousith.express",
        "Referer": "https://nextday.anousith.express/",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "accept": "*/*",
        "authorization": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZF91c2VyIjoxNDE0NCwiZmlyc3RfbmFtZSI6IuC6m-C6teC7iCAiLCJsYXN0X25hbWUiOiLguoLgurHgupTgupfgurTguo3gurAiLCJwcm9maWxlX3BpY3R1cmUiOiJ1bmRlZmluZWQiLCJwaG9uZV9udW1iZXIiOjc2MDk2MTkzLCJ1c2VybmFtZSI6Ijc2MDk2MTkzIiwiZW1haWwiOiIiLCJyb2xlIjoiQ1VTVE9NRVJfU0VSVklDRSIsImFuc1N0YWZmIjowLCJmcmFuY2hpc2VDb21taXNzaW9uIjowLCJicmFuY2hfaWQiOnsicHVibGljIjoxLCJpZF9icmFuY2giOjMzOCwiYnJhbmNoX25hbWUiOiLguqrgurLguoLgurIg4LqI4Lqw4LuA4Lql4Lq14LqZ4LuE4LqKKOC7gOC6guC6lOC7gOC6p-C6teC6meC6hOC6sykiLCJhZGRyZXNzX2luZm8iOiLguprgu4ngurLgupkg4LqI4Lqw4LuA4Lql4Lq14LqZ4LuE4LqKIOC7gOC6oeC6t-C6reC6h-C7hOC6iuC6l-C6suC6meC6tSDgupngurDguoTguq3gupnguqvgurzguqfguofguqfgur3guofguojgurHgupkgMDIwOTIxMzY4ODIifSwiY2VudGVyIjp7InN0X2lkIjpudWxsLCJjZW50ZXJOYW1lIjpudWxsfSwicHJvdmluY2UiOnsiaWRfc3RhdGUiOjEsInByb3ZpbmNlTmFtZSI6IuC6meC6sOC6hOC6reC6meC6q-C6vOC6p-C6h-C6p-C6veC6h-C6iOC6seC6mSJ9LCJoaWtfdmlzaW9uIjoiQUxMIiwiaWF0IjoxNzM5MzQ4OTU3LCJleHAiOjE3Mzk0MzUzNTd9.jJLKvhpt9tXA5xSzDXyAChBianavoYyGa4Abambaow4",
        "sec-ch-ua": "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Linux\""
    }

    response = requests.post(url, json=payload, headers=headers)    
    if response.status_code == 200:
        response = response.json()
        # print(response)
        return response["data"]["itemsV2"]["data"]
    else:
        print(response.text)  
        time.sleep(60)
        print("Try get purchase")
        return getShipmentAnousith(accessToken, skip, limit, iter)
        
def getAllShipmentAnousith(accessToken):
    listPurchases = []
    total = 0
    while True:
        inAPage = getShipmentAnousith(accessToken, len(listPurchases), 100)
        if len(inAPage) == 0:
            break
        listPurchases += inAPage
        total = len(listPurchases)
        with open("listShipmentAnousith.json", "w") as file:
            file.write(json.dumps(listPurchases,indent=4))
    print("Total bill in Annousith: ", total)

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
    nextCursor = None
    allData = []
    while True:
        data = getShipmentHal(accessToken, nextCursor)
        allData += data["data"]
        nextCursor = data["next_cursor"]
        with open("listShipmentHal.json", "w") as f:
            f.write(json.dumps(allData, indent=4))
            f.close()
        if not nextCursor:
            break
    print(f"Total bill in Hal: {len(allData)}")

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