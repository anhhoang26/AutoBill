import requests
import os
def uploadFile(image, iter = 0):
    # print(image)
    if iter > 5:
        return False
    url = "https://auto-pancake.anhviethoang2000.workers.dev/upload"

    payload = {}
    files=[
        ('file',(os.path.basename(image),open(image,'rb'),'image/png'))
    ]
    headers = {}
    response = requests.request("POST", url, headers=headers, data=payload, files=files)
    if response.status_code == 200:
        return True
    print(response.text)
    return uploadFile(image, iter+1)
if __name__ == "__main__":
    uploadFile(("login.py", "login.py"))
    # https://pos.pancake.vn/api/v1/shops/1290016971/orders?api_key=a0cdbff0101e497282e183e40f9baca4&&search=349000&&page_size=1000&&page=0