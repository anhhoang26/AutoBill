from pyppeteer import launch
import asyncio
import os
import time

async def processBillWithPancakeExt():
    pyppeteer_user_data_dir = os.path.expanduser("~/.config/pyppeteer_chrome_profile")
    if not os.path.exists(pyppeteer_user_data_dir):
        os.makedirs(pyppeteer_user_data_dir)
    
    print(f"Pyppeteer user data directory: {pyppeteer_user_data_dir}")

    browser = await launch(
        executablePath='/usr/bin/google-chrome',  # Đường dẫn tới Chrome của bạn
        headless=False,                           # Chạy có giao diện để đăng nhập lần đầu
        userDataDir=pyppeteer_user_data_dir,      # Sử dụng thư mục riêng cho pyppeteer
        args=[
            '--disable-web-security',             # Cẩn thận khi sử dụng tùy chọn này
            '--no-sandbox',                       # Có thể cần trên Linux
            '--start-maximized'
        ],
        handleSIGINT=False,
        handleSIGTERM=False,
        handleSIGHUP=False,
        defaultViewport=None
    )
    page = await browser.newPage()
    await page.goto("https://www.google.com") # Hoặc facebook.com
    print("Vui lòng đăng nhập vào Google/Facebook nếu được yêu cầu.")
    print("Session sẽ được lưu cho các lần chạy sau.")
    await asyncio.sleep(10000) # Chờ 2 phút

    await browser.close()

asyncio.run(processBillWithPancakeExt())