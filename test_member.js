const puppeteer = require('puppeteer');

(async () => {
    try {
        const browser = await puppeteer.launch({ headless: true });
        const page = await browser.newPage();
        
        page.on('console', msg => console.log('PAGE LOG:', msg.text()));
        page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
        
        console.log('Navigating...');
        await page.goto('file://' + __dirname + '/memberDB.html');
        await page.waitForTimeout(3000);
        await browser.close();
        console.log('Done.');
    } catch (e) {
        console.log('Error:', e);
    }
})();
