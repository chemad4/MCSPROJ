from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    
    page.on("console", lambda msg: print(f"CONSOLE {msg.type}: {msg.text}"))
    page.on("pageerror", lambda exc: print(f"PAGE ERROR: {exc}"))
    
    print("Navigating to memberDB.html...")
    page.goto("file:///Users/louiseadrianvnonog/XFitTrack/MCSPROJ/memberDB.html")
    page.wait_for_timeout(3000)
    browser.close()
