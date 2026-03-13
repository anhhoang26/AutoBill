"""Crawl orders from HAL Logistics and Anousith Express via network interception."""

import json
import os
import asyncio
from datetime import datetime


async def crawl_orders(context, site_key: str, site_config: dict) -> list:
    """Crawl orders by intercepting API responses when loading orders page."""
    orders_url = site_config["orders_url"]
    name = site_config["name"]
    print(f"[CRAWL] Fetching orders from {name}...")

    page = await context.new_page()
    captured_responses = []

    async def handle_response(response):
        """Capture API responses that look like order data."""
        url = response.url
        content_type = response.headers.get("content-type", "")

        if "application/json" in content_type:
            try:
                body = await response.json()
                captured_responses.append({
                    "url": url,
                    "status": response.status,
                    "data": body
                })
            except Exception:
                pass

    page.on("response", handle_response)

    try:
        await page.goto(orders_url, wait_until="networkidle", timeout=60000)
        # Wait a bit more for any lazy-loaded API calls
        await page.wait_for_timeout(3000)
    except Exception as e:
        print(f"[CRAWL] Error loading page: {e}")
        await page.close()
        return []

    await page.close()

    # Parse captured responses to find order data
    orders = []
    if site_key == "hal":
        orders = parse_hal_responses(captured_responses)
    elif site_key == "anousith":
        orders = parse_anousith_responses(captured_responses)

    print(f"[CRAWL] Found {len(orders)} orders from {name}")
    print(f"[CRAWL] Captured {len(captured_responses)} API responses")

    # Debug: save raw responses for analysis
    debug_dir = "data/debug"
    os.makedirs(debug_dir, exist_ok=True)
    debug_file = os.path.join(debug_dir, f"{site_key}_responses_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
    with open(debug_file, "w", encoding="utf-8") as f:
        json.dump(captured_responses, f, ensure_ascii=False, indent=2, default=str)
    print(f"[CRAWL] Raw responses saved to {debug_file}")

    return orders


def parse_hal_responses(responses: list) -> list:
    """Parse HAL Logistics API responses to extract order data."""
    orders = []
    for resp in responses:
        data = resp.get("data")
        if not data:
            continue

        # Try to find order list in various response structures
        order_list = None
        if isinstance(data, list):
            order_list = data
        elif isinstance(data, dict):
            # Common patterns: data.data, data.items, data.results, data.shipments
            for key in ["data", "items", "results", "shipments", "parcels", "orders", "records"]:
                if key in data and isinstance(data[key], list):
                    order_list = data[key]
                    break
            # Nested: data.data.data, data.data.items
            if not order_list and "data" in data and isinstance(data["data"], dict):
                inner = data["data"]
                for key in ["data", "items", "results", "shipments", "parcels", "records"]:
                    if key in inner and isinstance(inner[key], list):
                        order_list = inner[key]
                        break

        if not order_list or len(order_list) == 0:
            continue

        # Check if items look like orders (have tracking number or shipment fields)
        sample = order_list[0]
        if not isinstance(sample, dict):
            continue

        # Look for tracking number field
        tracking_fields = ["tracking_number", "trackingNumber", "tracking_no", "parcel_code",
                          "shipment_number", "shipment_code", "code", "barcode", "waybill"]
        has_tracking = any(f in sample for f in tracking_fields)

        if not has_tracking and len(order_list) < 3:
            continue

        print(f"[CRAWL-HAL] Found order list with {len(order_list)} items from {resp['url']}")
        print(f"[CRAWL-HAL] Sample keys: {list(sample.keys())[:15]}")

        for item in order_list:
            order = normalize_hal_order(item)
            if order:
                orders.append(order)

    return orders


def normalize_hal_order(raw: dict) -> dict:
    """Normalize a raw HAL order into standard format."""
    def get_field(obj, *keys, default=""):
        for k in keys:
            if k in obj:
                return obj[k]
            # Try nested
            parts = k.split(".")
            val = obj
            for p in parts:
                if isinstance(val, dict) and p in val:
                    val = val[p]
                else:
                    val = None
                    break
            if val is not None:
                return val
        return default

    return {
        "source": "hal",
        "tracking_number": get_field(raw, "tracking_number", "trackingNumber", "tracking_no",
                                      "parcel_code", "shipment_code", "code", "barcode"),
        "sender_name": get_field(raw, "sender_name", "senderName", "sender.name", "from_name"),
        "sender_phone": get_field(raw, "sender_phone", "senderPhone", "sender.phone", "from_phone"),
        "receiver_name": get_field(raw, "receiver_name", "receiverName", "receiver.name", "to_name"),
        "receiver_phone": get_field(raw, "receiver_phone", "receiverPhone", "receiver.phone", "to_phone"),
        "from_branch": get_field(raw, "from_branch", "fromBranch", "origin", "from_location",
                                  "sender_branch", "from_branch_name"),
        "to_branch": get_field(raw, "to_branch", "toBranch", "destination", "to_location",
                                "receiver_branch", "to_branch_name"),
        "item_description": get_field(raw, "item_description", "description", "item_name",
                                       "goods_description", "product_name", "remark"),
        "quantity": get_field(raw, "quantity", "qty", "item_qty", "total_qty", default=1),
        "weight": get_field(raw, "weight", "total_weight", "item_weight", default=""),
        "size": get_field(raw, "size", "dimension", "item_size", default=""),
        "cod_amount": get_field(raw, "cod_amount", "codAmount", "cod", "cod_value", default=0),
        "cdc_amount": get_field(raw, "cdc_amount", "cdcAmount", "cdc", "shipping_fee",
                                 "delivery_fee", default=0),
        "date": get_field(raw, "created_at", "createdAt", "date", "shipment_date", "create_date"),
        "express_code": get_field(raw, "express_code", "expressCode", "service_code",
                                   "express_type", default=""),
        "raw": raw,
    }


def parse_anousith_responses(responses: list) -> list:
    """Parse Anousith Express API responses to extract order data."""
    orders = []
    for resp in responses:
        data = resp.get("data")
        if not data:
            continue

        order_list = None
        if isinstance(data, list):
            order_list = data
        elif isinstance(data, dict):
            for key in ["data", "items", "results", "orders", "records", "cods", "parcels"]:
                if key in data and isinstance(data[key], list):
                    order_list = data[key]
                    break
            if not order_list and "data" in data and isinstance(data["data"], dict):
                inner = data["data"]
                for key in ["data", "items", "results", "orders", "records"]:
                    if key in inner and isinstance(inner[key], list):
                        order_list = inner[key]
                        break

        if not order_list or len(order_list) == 0:
            continue

        sample = order_list[0]
        if not isinstance(sample, dict):
            continue

        print(f"[CRAWL-ANS] Found order list with {len(order_list)} items from {resp['url']}")
        print(f"[CRAWL-ANS] Sample keys: {list(sample.keys())[:15]}")

        for item in order_list:
            order = normalize_anousith_order(item)
            if order:
                orders.append(order)

    return orders


def normalize_anousith_order(raw: dict) -> dict:
    """Normalize a raw Anousith order into standard format."""
    def get_field(obj, *keys, default=""):
        for k in keys:
            if k in obj:
                return obj[k]
        return default

    return {
        "source": "anousith",
        "tracking_number": get_field(raw, "tracking_number", "trackingNumber", "tracking_no",
                                      "parcel_code", "code", "barcode"),
        "sender_name": get_field(raw, "sender_name", "senderName", "from_name"),
        "sender_phone": get_field(raw, "sender_phone", "senderPhone", "from_phone"),
        "receiver_name": get_field(raw, "receiver_name", "receiverName", "to_name"),
        "receiver_phone": get_field(raw, "receiver_phone", "receiverPhone", "to_phone"),
        "from_branch": get_field(raw, "from_branch", "fromBranch", "origin", "from_location"),
        "to_branch": get_field(raw, "to_branch", "toBranch", "destination", "to_location"),
        "item_description": get_field(raw, "item_description", "description", "item_name", "remark"),
        "quantity": get_field(raw, "quantity", "qty", default=1),
        "weight": get_field(raw, "weight", "total_weight", default=""),
        "size": get_field(raw, "size", "dimension", default=""),
        "cod_amount": get_field(raw, "cod_amount", "codAmount", "cod", default=0),
        "cdc_amount": get_field(raw, "cdc_amount", "cdcAmount", "cdc", "shipping_fee", default=0),
        "date": get_field(raw, "created_at", "createdAt", "date"),
        "express_code": get_field(raw, "express_code", "expressCode", "service_code", default=""),
        "raw": raw,
    }


def load_existing_orders(data_dir: str = "data") -> dict:
    """Load previously crawled orders to avoid duplicates."""
    orders_file = os.path.join(data_dir, "orders.json")
    if not os.path.exists(orders_file):
        return {}
    with open(orders_file, "r", encoding="utf-8") as f:
        return json.load(f)


def save_orders(orders: dict, data_dir: str = "data"):
    """Save orders to data file."""
    os.makedirs(data_dir, exist_ok=True)
    orders_file = os.path.join(data_dir, "orders.json")
    with open(orders_file, "w", encoding="utf-8") as f:
        json.dump(orders, f, ensure_ascii=False, indent=2, default=str)


def get_new_orders(crawled: list, existing: dict) -> list:
    """Filter out orders that have already been processed."""
    new_orders = []
    for order in crawled:
        tracking = order.get("tracking_number", "")
        if tracking and tracking not in existing:
            new_orders.append(order)
    return new_orders
