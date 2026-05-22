from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    
    page.on("console", lambda msg: print(f"CONSOLE {msg.type}: {msg.text}"))
    page.on("pageerror", lambda exc: print(f"PAGE ERROR: {exc}"))
    
    print("Navigating to index.html with bypass parameter...")
    page.goto("file:///Users/louiseadrianvnonog/XFitTrack/MCSPROJ/index.html?bypass=member")
    
    # Wait for the redirection and the dashboard to fully load
    page.wait_for_selector("#navMenu", timeout=5000)
    print("SUCCESS: Sidebar navigation menu (#navMenu) loaded!")
    
    # Verify key DOM elements on the member dashboard
    elements_to_check = {
        "#pageTitle": "Page Title",
        "#greetingText": "Greeting/Overview Header",
        "#liveClock": "Live Clock",
        "#myPlanName": "Plan Name Display",
        "#mySessionsRemaining": "Sessions Remaining Count",
        "#myAttendanceTable": "Attendance Records Table",
        "#fitnessGoalsInput": "Fitness Goals Textarea",
        "#dashActiveTrainersFeed": "Active Trainers Feed Panel",
        "#memberBookingModal": "Trainer Booking Modal Window"
    }
    
    print("\n--- Running DOM Elements Audit ---")
    for selector, name in elements_to_check.items():
        element = page.query_selector(selector)
        if element:
            text_content = element.inner_text().strip() or element.get_attribute("placeholder") or "Loaded (No Visible Text)"
            # Clean up newlines for cleaner print
            text_content = text_content.replace('\n', ' ')[:50]
            print(f"✅ {name} ({selector}) exists! Value/Text: '{text_content}'")
        else:
            print(f"❌ {name} ({selector}) NOT FOUND in DOM!")
            
    print("\n--- Checking Active Navigation Elements ---")
    nav_links = page.query_selector_all("#navMenu li")
    print(f"Found {len(nav_links)} navigation items in sidebar menu.")
    for idx, link in enumerate(nav_links):
        print(f"  [{idx + 1}] {link.inner_text().strip()}")
        
    print("\nDOM verification completed successfully.")
    browser.close()
