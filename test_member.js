const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
        
        console.log('Navigating via test bypass URL...');
        await page.goto('file://' + __dirname + '/index.html?bypass=member');
        
        // Wait for dashboard container to render
        await page.waitForSelector('#navMenu', { timeout: 5000 });
        console.log('SUCCESS: Sidebar navigation menu (#navMenu) loaded!');
        
        const elementsToCheck = {
            '#pageTitle': 'Page Title',
            '#greetingText': 'Greeting Header',
            '#liveClock': 'Live Clock',
            '#myPlanName': 'Plan Name',
            '#mySessionsRemaining': 'Remaining Sessions Count',
            '#myAttendanceTable': 'Attendance Table',
            '#fitnessGoalsInput': 'Fitness Goals Input',
            '#dashActiveTrainersFeed': 'Trainers Feed Container',
            '#memberBookingModal': 'Booking Modal'
        };
        
        console.log('\n--- Running DOM Elements Audit (Puppeteer) ---');
        for (const [selector, name] of Object.entries(elementsToCheck)) {
            const element = await page.$(selector);
            if (element) {
                const text = await page.evaluate(el => el.innerText || el.placeholder || 'Loaded (No Visible Text)', element);
                console.log(`✅ ${name} (${selector}) exists! Value/Text: '${text.trim().replace(/\n/g, ' ').substring(0, 50)}'`);
            } else {
                console.log(`❌ ${name} (${selector}) NOT FOUND in DOM!`);
            }
        }
        
        console.log('\n--- Auditing Sidebar Navigation Elements ---');
        const menuItems = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('#navMenu li'));
            return items.map(el => el.innerText.trim());
        });
        console.log(`Found ${menuItems.length} menu items:`, menuItems);
        
        await browser.close();
        console.log('\nDOM verification completed successfully.');
    } catch (e) {
        console.log('Error:', e);
    }
})();
