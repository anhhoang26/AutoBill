from login import *
from purchase import *
from processBill import *
import time
if __name__ == "__main__":
    while True:
        try:
            print("-----------Start process---------")
            login()
            getAllShipment()
            getAllBillInPancake()
            billNeedProcess = getAllBillNeedProcess()
            print(f"Total bill need process: {len(billNeedProcess)}")
            open("billNeedProcess.json", "w").write(json.dumps(billNeedProcess, indent=4))
            for bill in billNeedProcess:
                processBill(bill)
            time.sleep(5 * 60)
        except Exception as e:
            print(e)
            time.sleep(60)