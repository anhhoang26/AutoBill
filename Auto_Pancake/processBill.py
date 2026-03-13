import requests
import os
import json
from dotenv import load_dotenv
from uploadToR2 import *
from createImageBill import * 
load_dotenv(override=True)
POS_PANCAKE_API_KEY = os.getenv("POS_PANCAKE_API_KEY")
PANCAKE_ACCESS_TOKEN = os.getenv("PANCAKE_ACCESS_TOKEN")
SHOP_ID = os.getenv("SHOP_ID")
baseUrl = "https://pub-86abf2be138b44ed8036a90b3216cd67.r2.dev/uploads"

def updateStatusOrder(billInPancake, shipFee, iter=0):
    if iter > 5:
        print("Failed update status bill", billInPancake["id"])
        return False

    payload = {
        "status": 2,
        "partner_fee": shipFee
    }
    url = f'https://pos.pancake.vn/api/v1/shops/{SHOP_ID}/orders/{billInPancake["id"]}?api_key={POS_PANCAKE_API_KEY}'
    response = requests.put(url=url, json=payload)
    # print(response)
    if response.status_code // 200 != 1:
        print(billInPancake["id"], response.status_code)
        updateStatusOrder(billInPancake, shipFee, iter+1)    
    else:
        return True
def message(billInPancake, billShipUrl, iter=0):
    # Error L169683TH 0
    ""
    print(billInPancake["id"])
    if iter > 5:
        print("Failed send bill: Retry many", billInPancake["id"])
        return 
    url = f'https://pages.fm/api/v1/pages/{billInPancake["page_id"]}/conversations/{billInPancake["conversation_id"]}/messages?access_token={PANCAKE_ACCESS_TOKEN}'

    payload = json.dumps({
        # "content_url": billShipUrl,
        "content_url": billShipUrl,
        "action": "reply_inbox"
    })
    headers = {
        'page_id': billInPancake["page_id"],
        'conversation_id': billInPancake["conversation_id"],
        'Content-Type': 'application/json'
    }

    response = requests.request("POST", url, headers=headers, data=payload)
    if response.status_code // 200 != 1:
        print(billInPancake["id"], response.status_code)
        return message(billInPancake, billShipUrl, iter+1)
    res = response.json()
    if res["success"]:
        print("Success send billll")
        return True
    print("Failed send bill", res)
    
    return False
def sendViaExtension(billInPancake, billFileName):
    """Fallback: send message via Chrome extension when Pancake API fails (7-day limit)."""
    try:
        from ws_server import send_fb_message
        conversation_id = billInPancake["conversation_id"]
        result = send_fb_message(conversation_id, message="", image_path=billFileName)
        if isinstance(result, dict) and result.get("success"):
            print(f"[EXT] Success send via extension: {billInPancake['id']}")
            return True
        print(f"[EXT] Failed send via extension: {billInPancake['id']}", result)
        return False
    except Exception as e:
        print(f"[EXT] Extension send error: {e}")
        return False

def processBill(billProcessInfo):
    billInPancake, billInShipment, isHal = billProcessInfo[0], billProcessInfo[1], billProcessInfo[2]
    if isHal:
        billFileName = f'image_bill/bill_hal_{billInShipment["id"]}.png'
        shipFee = billInShipment["total_freight"]
        hal(billInShipment)
    else:
        billFileName = f'image_bill/bill_anousith_{billInShipment["_id"]}.png'
        shipFee = billInShipment["packagePrice"]
        anousith(billInShipment)

    # Try Pancake API first, fallback to extension if it fails
    sent = messageBillWithExtPancake(billInPancake, billFileName)
    if not sent:
        print(f"[PROCESS] Pancake API failed for {billInPancake['id']}, trying extension...")
        sent = sendViaExtension(billInPancake, billFileName)

    if sent:
        os.remove(billFileName)
        updateStatusOrder(billInPancake, shipFee)
    # if uploadFile(billFileName):
    #     os.remove(billFileName)
    #     if  message(billInPancake, f'{baseUrl}/{os.path.basename(billFileName)}'):
    #         updateStatusOrder(billInPancake, shipFee)

def uploadBillToPancake(billInPancake, fileLocal, iter=0):
    if iter > 5:
        print("Failed send bill: Retry many", billInPancake["id"])
        return None
    url = f'https://pancake.vn/api/v1/pages/{billInPancake["page_id"]}/contents?access_token={PANCAKE_ACCESS_TOKEN}'

    payload = {}
    files=[
        ('file',(os.path.basename(fileLocal),open(fileLocal,'rb'),'image/png'))
    ]
    headers = {
        'Accept': 'application/json',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Connection': 'keep-alive',
        'Origin': 'https://pancake.vn',
        'Referer': 'https://pancake.vn/103924851328372',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cookie': '__stripe_mid=005d5d40-99f6-4f16-9378-d7a75e412797f2cbc3; jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiVGjDuXkgTGnDqm4gQ2FyZSBWaeG7h3QiLCJleHAiOjE3NTU1MDkyNjAsImFwcGxpY2F0aW9uIjoxLCJ1aWQiOiJjNzkyNDNhOS1jZTdiLTQwZmEtODU4Ni03MGFlZTExM2U1NGUiLCJzZXNzaW9uX2lkIjoiMjliL2NJelQ3cG5tYTlCNWlaNStubW9HV2pYemo5U1o0cEN0OERXemtQdyIsImlhdCI6MTc0NzczMzI2MCwiZmJfaWQiOiI5OTgwNzM4MzgyMjk1MTkiLCJsb2dpbl9zZXNzaW9uIjpudWxsLCJmYl9uYW1lIjoiVGjDuXkgTGnDqm4gQ2FyZSBWaeG7h3QifQ.DlaXVXqQotBrmAWf0qXV9EOOJOOTGQVezkgBHJypwws; locale=vi; _gid=GA1.2.591884371.1748182251; _ga_5N5FG6VLHC=GS2.1.s1748182548^$o362^$g0^$t1748182557^$j51^$l0^$h0^$dcuyzn3f56bMMuPScd0FTC4ZOhgXm7qxjYQ; _ga=GA1.1.2025781104.1740792750; _ga_VG3LFY1C9R=GS2.1.s1748185069^$o203^$g1^$t1748185282^$j0^$l0^$h0'
    }
    response = requests.request("POST", url, headers=headers, data=payload, files=files)
    if response.status_code // 200 != 1:
        print("Upload bill failed", billInPancake["id"], response.status_code)
        # return uploadBillToPancake(billInPancake, fileLocal, iter+1)
    response = response.json()
    if response["success"]:
        return response
    return uploadBillToPancake(billInPancake, fileLocal, iter+1)

def createFbIds(billInPancake, contentIds, iter=0):
    if iter > 5:
        print("Failed create fb ids: Retry many", billInPancake["id"])
        return None
    url = f'https://pancake.vn/api/v1/pages/{billInPancake["page_id"]}/contents/facebook?access_token={PANCAKE_ACCESS_TOKEN}&is_reusable=true&async=false'
    payload = json.dumps({
        "content_ids": [contentIds]
    })
    headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Origin': 'https://pancake.vn',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cookie': '__stripe_mid=005d5d40-99f6-4f16-9378-d7a75e412797f2cbc3; jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiVGjDuXkgTGnDqm4gQ2FyZSBWaeG7h3QiLCJleHAiOjE3NTU1MDkyNjAsImFwcGxpY2F0aW9uIjoxLCJ1aWQiOiJjNzkyNDNhOS1jZTdiLTQwZmEtODU4Ni03MGFlZTExM2U1NGUiLCJzZXNzaW9uX2lkIjoiMjliL2NJelQ3cG5tYTlCNWlaNStubW9HV2pYemo5U1o0cEN0OERXemtQdyIsImlhdCI6MTc0NzczMzI2MCwiZmJfaWQiOiI5OTgwNzM4MzgyMjk1MTkiLCJsb2dpbl9zZXNzaW9uIjpudWxsLCJmYl9uYW1lIjoiVGjDuXkgTGnDqm4gQ2FyZSBWaeG7h3QifQ.DlaXVXqQotBrmAWf0qXV9EOOJOOTGQVezkgBHJypwws; locale=vi; _gid=GA1.2.591884371.1748182251; _ga_5N5FG6VLHC=GS2.1.s1748182548^$o362^$g0^$t1748182557^$j51^$l0^$h0^$dcuyzn3f56bMMuPScd0FTC4ZOhgXm7qxjYQ; _ga=GA1.1.2025781104.1740792750; _ga_VG3LFY1C9R=GS2.1.s1748221643^$o207^$g1^$t1748221977^$j0^$l0^$h0'
    }
    response = requests.request("POST", url, headers=headers, data=payload)
    if response.status_code // 200 != 1:
        print("Create fb ids failed", billInPancake["id"], response.status_code)
        # return createFbIds(billInPancake, contentIds, iter+1)
    res = response.json()
    if res["success"]:
        return res["fb_ids"][0]
    return createFbIds(billInPancake, contentIds, iter+1)
def sendMessageFaceBookWithPancake(billInPancake, responseUploadBill, fbIds, iter=0):
    if iter > 5:
        print("Failed send message: Retry many", billInPancake["id"])
        return False
    url = f'https://pancake.vn/api/v1/pages/{billInPancake["page_id"]}/conversations/{billInPancake["conversation_id"]}/messages?access_token={PANCAKE_ACCESS_TOKEN}'
    payload = {
        'action': 'reply_inbox',
        'message': '',
        'content_id': responseUploadBill["id"],
        'attachment_id': fbIds,
        'content_url': responseUploadBill["content_url"],
        'width': responseUploadBill["image_data"]["width"],
        'height': responseUploadBill["image_data"]["height"],
        'send_by_platform': 'web'
    }
    files= []
    headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'vi,fr-FR;q=0.9,fr;q=0.8,en-US;q=0.7,en;q=0.6',
        'Connection': 'keep-alive',
        'Origin': 'https://pancake.vn',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Cookie': '__stripe_mid=005d5d40-99f6-4f16-9378-d7a75e412797f2cbc3; jwt=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJuYW1lIjoiVGjDuXkgTGnDqm4gQ2FyZSBWaeG7h3QiLCJleHAiOjE3NTU1MDkyNjAsImFwcGxpY2F0aW9uIjoxLCJ1aWQiOiJjNzkyNDNhOS1jZTdiLTQwZmEtODU4Ni03MGFlZTExM2U1NGUiLCJzZXNzaW9uX2lkIjoiMjliL2NJelQ3cG5tYTlCNWlaNStubW9HV2pYemo5U1o0cEN0OERXemtQdyIsImlhdCI6MTc0NzczMzI2MCwiZmJfaWQiOiI5OTgwNzM4MzgyMjk1MTkiLCJsb2dpbl9zZXNzaW9uIjpudWxsLCJmYl9uYW1lIjoiVGjDuXkgTGnDqm4gQ2FyZSBWaeG7h3QifQ.DlaXVXqQotBrmAWf0qXV9EOOJOOTGQVezkgBHJypwws; locale=vi; _gid=GA1.2.591884371.1748182251; _ga_5N5FG6VLHC=GS2.1.s1748182548^$o362^$g0^$t1748182557^$j51^$l0^$h0^$dcuyzn3f56bMMuPScd0FTC4ZOhgXm7qxjYQ; _ga=GA1.1.2025781104.1740792750; _ga_VG3LFY1C9R=GS2.1.s1748227845^$o208^$g1^$t1748228582^$j0^$l0^$h0'
    }

    response = requests.request("POST", url, headers=headers, data=payload, files=files)
    if response.status_code // 200 != 1:
        print("Failed send message", billInPancake["id"], response.status_code)
        return False
        # return sendMessageFaceBookWithPancake(billInPancake, responseUploadBill, fbIds, iter+1)
    res = response.json()
    if res["success"]:
        print("Success send message", billInPancake["id"])
        return True
    print("Failed send message", billInPancake["id"], res)
    return False
    
def messageBillWithExtPancake(billInPancake, fileLocal, iter=0):
    # print(billInPancake["id"])
    responseUploadBill = uploadBillToPancake(billInPancake, fileLocal, iter)
    if responseUploadBill:
        fbIds = createFbIds(billInPancake, responseUploadBill["id"], iter)
        if fbIds:
            return sendMessageFaceBookWithPancake(billInPancake, responseUploadBill, fbIds, iter)
    return False
if __name__ == "__main__":
    billNeedProcess = json.load(open("billNeedProcess.json"))
    for bill in billNeedProcess:
        processBill(bill)
        break
    # anousith(billNeedProcess[0][1])
    # billFileName = f'image_bill/bill_anousith_{billNeedProcess[0][1]["_id"]}.png'
    # print(billFileName)
    # messageBillWithExtPancake(billNeedProcess[0][0], billFileName)
