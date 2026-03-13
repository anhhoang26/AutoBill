import random
import asyncio
import os
from pyppeteer import launch
import time
import json
async def generate_image_anousith(bill):
    raw_html = open("app.anousith-express.com/search_item.html", "r", encoding="utf-8").read()
    raw_html = raw_html.replace("{{trackingId}}", bill["trackingId"])
    raw_html = raw_html.replace("{{originProvinceId.provinceName}}", bill["originProvinceId"]["provinceName"])
    raw_html = raw_html.replace("{{destProvinceId.provinceName}}", bill["destProvinceId"]["provinceName"])
    raw_html = raw_html.replace("{{originBranchId.branch_name}}", bill["originBranchId"]["branch_name"])
    raw_html = raw_html.replace("{{destBranchId.branch_name}}", bill["destBranchId"]["branch_name"])
    raw_html = raw_html.replace("{{customerId.full_name}}", bill["customerId"]["full_name"])
    raw_html = raw_html.replace("{{customerId.contact_info}}", bill["customerId"]["contact_info"])
    raw_html = raw_html.replace("{{receiverName}}", bill["receiverName"])
    raw_html = raw_html.replace("{{receiverPhone}}", bill["receiverPhone"])
    raw_html = raw_html.replace("{{width}}", str(bill["width"]))
    raw_html = raw_html.replace("{{weight}}", str(bill["weight"]))
    raw_html = raw_html.replace("{{packagePrice}}", f'{bill["packagePrice"]:,}')
    raw_html = raw_html.replace("{{itemValueKIP}}", f'{bill["itemValueKIP"]:,}')
    raw_html = raw_html.replace("{{totalValueInKip}}", f'{bill["packagePrice"] + bill["itemValueKIP"]:,}')

    htmlFilename = f"app.anousith-express.com/{bill['_id']}.html"
    # Ensure the directory for the HTML file exists
    os.makedirs(os.path.dirname(htmlFilename), exist_ok=True)
    with open(htmlFilename, "w", encoding="utf-8") as f:
        f.write(raw_html)
    try: 
        browser = await launch(
            executablePath='/usr/bin/google-chrome', 
            headless=True,
            args=['--disable-web-security'],
            handleSIGINT=False,
            handleSIGTERM=False,
            handleSIGHUP=False
        )
        page = await browser.newPage()
        
        # Set viewport
        await page.setViewport({'width': 700, 'height': 600, 'deviceScaleFactor': 1})
        
        # Construct file URL
        abs_html_path = os.path.abspath(htmlFilename)
        file_url = f'file:///{abs_html_path}'

        await page.goto(file_url, {'waitUntil': 'networkidle0'})
        output_image_path = f'image_bill/bill_anousith_{bill["_id"]}.png'
        os.makedirs(os.path.dirname(output_image_path), exist_ok=True)
        # Screenshot only the bill element to avoid whitespace
        bill_el = await page.querySelector('.bill-content')
        if bill_el:
            await bill_el.screenshot({'path': output_image_path})
        else:
            await page.screenshot({'path': output_image_path})
        # time.sleep(1)
    finally:
        if browser:
            await browser.close()
        os.remove(htmlFilename)
async def generate_image_hal(bill):
    raw_html = open("halOrder/index.html", "r", encoding="utf-8").read()
    raw_html = raw_html.replace("{{start_date_actual}}", bill["start_date_actual"])
    raw_html = raw_html.replace("{{shipment_number}}", bill["shipment_number"])
    raw_html = raw_html.replace("{{sender_customer.name}}", bill["sender_customer"]["name"])
    raw_html = raw_html.replace("{{sender_customer.tel}}", bill["sender_customer"]["tel"])
    raw_html = raw_html.replace("{{receiver_customer.name}}", bill["receiver_customer"]["name"])
    raw_html = raw_html.replace("{{receiver_customer.tel}}", bill["receiver_customer"]["tel"])
    raw_html = raw_html.replace("{{start_branch.name}}", bill["start_branch"]["name"])     
    raw_html = raw_html.replace("{{end_branch.name}}", bill["end_branch"]["name"])
    if bill["parcel"]["name"]:
        raw_html = raw_html.replace("{{parcel.name}}", bill["parcel"]["name"])
    else:
        raw_html = raw_html.replace("{{parcel.name}}", "ແປ້ງທາຜິວກາຍ")
    raw_html = raw_html.replace("{{pieces}}", str(bill["pieces"]))
    raw_html = raw_html.replace("{{parcel.weight}}", str(bill["parcel"]["weight"]))
    raw_html = raw_html.replace("{{parcel.weight_unit}}", bill["parcel"]["weight_unit"])   
    raw_html = raw_html.replace("{{parcel.dimension_length}}", str(bill["parcel"]["dimension_length"]))
    raw_html = raw_html.replace("{{total_freight}}", str(bill["total_freight"]))
    raw_html = raw_html.replace("{{total_price}}", str(bill["total_price"]))
    htmlFilename = f"halOrder/{bill['id']}.html"
    with open(htmlFilename, "w", encoding="utf-8") as f:
        f.write(raw_html)
    try:
        browser = await launch(
            executablePath='/usr/bin/google-chrome', 
            # headless=False,
            args=['--disable-web-security']
        )
        page = await browser.newPage()
        
        # Set viewport
        await page.setViewport({'width': 400, 'height': 600, 'deviceScaleFactor': 1})
        
        # Construct file URL
        abs_html_path = os.path.abspath(htmlFilename)
        file_url = f'file:///{abs_html_path}'

        await page.goto(file_url, {'waitUntil': 'networkidle0'})
        output_path = f'image_bill/bill_hal_{bill["id"]}.png'
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        # Screenshot only the card element to get clean output
        card_el = await page.querySelector('.outer')
        if card_el:
            await card_el.screenshot({'path': output_path})
        else:
            await page.screenshot({'path': output_path})
        # time.sleep(1)
    finally:
        if browser:
            await browser.close()
        os.remove(htmlFilename)
def anousith(bill):
    asyncio.run(generate_image_anousith(bill))

def hal(bill):
    asyncio.run(generate_image_hal(bill))

if __name__ == "__main__":
    orders = json.load(open("listCurrentProcess.json", "r", encoding="utf-8"))
    anousith(orders[0])
