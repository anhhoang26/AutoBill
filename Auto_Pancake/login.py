import requests
import json
import time
def updateToken(accessToken):
    url = "https://auto-pancake.anhviethoang2000.workers.dev/auth"

    payload = json.dumps({
        "authorization": accessToken
    })
    headers = {
        'Content-Type': 'application/json'
    }
    response = requests.request("POST", url, headers=headers, data=payload)
    # print(response.status_code)

def loginAnousith():
    df = json.load(open("token.json"))
    if time.time() - df["anousith"]["lastLogin"] <= 22 * 60 * 60:
        return
    url = "https://pro.api.anousith.express/graphql"

    payload = "{\"query\":\"mutation StaffLogin($where: StaffLoginInput!, $data: StaffLoginInputData) {\\n  staffLogin(where: $where, data: $data) {\\n    accessToken\\n  }\\n}\",\"variables\":{\"data\":{\"logInUrl\":\"https://nextday.anousith.express/\"},\"where\":{\"phone_number\":98735835,\"password\":\"ANS98735835\"}}}"
    headers = {
        'Accept': '*/*',
        'Access-Control-Request-Headers': 'authorization,content-type',
        'Access-Control-Request-Method': 'POST',
        'Origin': 'https://nextday.anousith.express',
        'Sec-Fetch-Mode': 'cors',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'sec-ch-ua-platform': '"Linux"',
        'authorization': 'null',
        'Referer': 'https://nextday.anousith.express/',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'accept': '*/*',
        'content-type': 'application/json'
    }

    response = requests.request("POST", url, headers=headers, data=payload)
    print(response.status_code)
    if response.status_code == 200:
        response = response.json()
        print(response)
        updateToken(response["data"]["staffLogin"]["accessToken"])
        df["anousith"] = {
            "accessToken": response["data"]["staffLogin"]["accessToken"],
            "lastLogin": time.time()
        }
        with open("token.json", "w") as file:
            file.write(json.dumps(df, indent=4))
    else:
        print(response.text)
        time.sleep(100)
        print("Try login")
        loginAnousith()

def loginHal():
    with open("token.json", "r") as f:
        df = json.loads(f.read())
        f.close()
    if df["hal"]["exprire"] > time.time():
        return 
    url = "https://hal.hal-logistics.la/api/sign-in"
    payload = json.dumps({
        "id": None,
        "tel": "96018845",
        "password": "T96018845",
        "name": None,
        "roleUser": None
    })
    headers = {
        'Content-Type': 'application/json'
    }
    response = requests.request("POST", url, headers=headers, data=payload)
    print(response.status_code)
    if response.status_code != 200:
        time.sleep(10)
        loginHal()
    response = response.json()
    newLogin = {
        "exprire": time.time() + 8 * 60 * 60,
        "accessToken": response["access_token"],
        "refreshToken": response["refresh_token"],
        "userId": response["authUser"]["userId"]
    }
    df["hal"] = newLogin
    with open("token.json", "w") as f:
        f.write(json.dumps(df, indent=4))
        f.close()
    return newLogin

def login():
    loginAnousith()
    loginHal()
    print("Login success")

if __name__ == "__main__":
    login()