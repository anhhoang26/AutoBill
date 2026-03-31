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

    payload = json.dumps({
        "operationName": "CustomerLogin",
        "variables": {
            "where": {
                "username": "98709576",
                "password": "98709576"
            }
        },
        "query": """mutation CustomerLogin($where: CustomerLoginInput!) {
  customerLogin(where: $where) {
    accessToken
    data {
      id_list
      full_name
      profile_img
      status
      contact_info
      address
      village
      district {
        id_list
        title
      }
      state {
        provinceName
        id_state
      }
      Bank_KIP
      BANK_THB
      BANK_USD
      BANK_NAME
      gender
      isActive
      isVerify
    }
  }
}"""
    })
    headers = {
        'sec-ch-ua-platform': '"Windows"',
        'authorization': 'undefined',
        'Referer': 'https://app.anousith.express/',
        'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
        'sec-ch-ua-mobile': '?0',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'accept': '*/*',
        'content-type': 'application/json'
    }

    response = requests.request("POST", url, headers=headers, data=payload)
    print(response.status_code)
    if response.status_code == 200:
        response = response.json()
        print(response)
        updateToken(response["data"]["customerLogin"]["accessToken"])
        df["anousith"] = {
            "accessToken": response["data"]["customerLogin"]["accessToken"],
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
        "tel": "98709576",
        "password": "N98709576",
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