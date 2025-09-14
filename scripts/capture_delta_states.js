#!/usr/bin/env node

/**
 * Delta State Screenshot Capture Script
 * Automatically captures screenshots at key moments during delta testing
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SCREENSHOT_DIR = path.join(__dirname, '../screenshots/delta-tests');
const TEST_PAGE = '/mocks/delta-test';

// Ensure screenshot directory exists
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

/**
 * Capture screenshots at specific intervals after a delta update
 */
async function captureDeltaLifecycle(browser, scenario) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  const sessionDir = path.join(SCREENSHOT_DIR, `${scenario}-${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  
  console.log(`Starting delta lifecycle capture for: ${scenario}`);
  console.log(`Screenshots will be saved to: ${sessionDir}`);
  
  try {
    // Navigate to test page
    await page.goto(`${BASE_URL}${TEST_PAGE}`, { waitUntil: 'networkidle2' });
    await page.waitForTimeout(2000); // Let page initialize
    
    // Take baseline screenshot
    await page.screenshot({
      path: path.join(sessionDir, '00-baseline.png'),
      fullPage: false
    });
    console.log('✓ Captured baseline');
    
    // Trigger the scenario
    await page.evaluate((scenarioName) => {
      window.runScenario(scenarioName);
    }, scenario);
    
    // Capture at specific intervals
    const capturePoints = [
      { time: 100, name: '01-immediate', description: 'Immediately after update' },
      { time: 5000, name: '02-5seconds', description: 'After 5 seconds' },
      { time: 10000, name: '03-10seconds', description: 'After 10 seconds' },
      { time: 15000, name: '04-15seconds', description: 'After 15 seconds' },
      { time: 20000, name: '05-20seconds', description: 'After 20 seconds' },
      { time: 25000, name: '06-25seconds', description: 'After 25 seconds' },
      { time: 29000, name: '07-29seconds', description: 'At 29 seconds (should still be visible)' },
      { time: 30500, name: '08-30.5seconds', description: 'At 30.5 seconds (should be gone)' },
      { time: 31000, name: '09-31seconds', description: 'At 31 seconds (confirmed gone)' }
    ];
    
    let lastTime = 0;
    for (const point of capturePoints) {
      await page.waitForTimeout(point.time - lastTime);
      lastTime = point.time;
      
      // Capture full screenshot
      await page.screenshot({
        path: path.join(sessionDir, `${point.name}.png`),
        fullPage: false
      });
      
      // Also capture just the matchup area
      const matchupElement = await page.$('#teams');
      if (matchupElement) {
        await matchupElement.screenshot({
          path: path.join(sessionDir, `${point.name}-matchup.png`)
        });
      }
      
      // Capture delta state from page
      const deltaState = await page.evaluate(() => {
        return fetch('/api/matchups/mock/delta/state')
          .then(res => res.json())
          .then(data => ({
            activeCount: data.activeDeltas?.length || 0,
            stats: data.stats
          }))
          .catch(() => null);
      });
      
      console.log(`✓ Captured ${point.description} - Active deltas: ${deltaState?.activeCount || 0}`);
    }
    
    // Generate summary HTML
    generateSummaryHTML(sessionDir, scenario, capturePoints);
    
  } catch (error) {
    console.error(`Error capturing screenshots: ${error.message}`);
  } finally {
    await page.close();
  }
}

/**
 * Generate an HTML summary of the captured screenshots
 */
function generateSummaryHTML(sessionDir, scenario, capturePoints) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Delta Test Screenshots - ${scenario}</title>
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
    h1 { color: #333; }
    .screenshot-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px; }
    .screenshot { background: white; border: 1px solid #ddd; padding: 10px; border-radius: 5px; }
    .screenshot img { width: 100%; height: auto; border: 1px solid #eee; }
    .screenshot h3 { margin: 10px 0 5px 0; color: #556; }
    .screenshot p { margin: 5px 0; color: #666; font-size: 14px; }
    .highlight { background: #ffffcc; padding: 2px 4px; }
    .expired { color: #999; }
    .active { color: #2e7d32; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Delta Test Screenshots: ${scenario}</h1>
  <p>Captured: ${new Date().toLocaleString()}</p>
  
  <h2>Timeline</h2>
  <div class="screenshot-grid">
    <div class="screenshot">
      <h3>Baseline</h3>
      <p>Before any updates</p>
      <img src="00-baseline.png" alt="Baseline">
    </div>
    ${capturePoints.map(point => `
      <div class="screenshot">
        <h3>${point.description}</h3>
        <p>Time: ${(point.time / 1000).toFixed(1)}s</p>
        <p class="${point.time < 30000 ? 'active' : 'expired'}">
          Expected: ${point.time < 30000 ? 'Delta visible' : 'Delta expired'}
        </p>
        <img src="${point.name}.png" alt="${point.description}">
      </div>
    `).join('')}
  </div>
  
  <h2>Key Observations</h2>
  <ul>
    <li>Delta should appear immediately after update (screenshot 01)</li>
    <li>Delta should remain visible for exactly 30 seconds</li>
    <li>Delta should disappear between screenshots 07 (29s) and 08 (30.5s)</li>
    <li>Bold text on changed stats should follow the same timing</li>
  </ul>
</body>
</html>
  `;
  
  fs.writeFileSync(path.join(sessionDir, 'index.html'), html);
  console.log(`\n✓ Summary generated: ${path.join(sessionDir, 'index.html')}`);
}

/**
 * Run all test scenarios
 */
async function runAllScenarios() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const scenarios = [
    'touchdown',
    'fieldgoal',
    'teamscores',
    'correction',
    'defense',
    'bigplay'
  ];
  
  console.log('Delta Screenshot Capture Tool');
  console.log('=============================\n');
  
  for (const scenario of scenarios) {
    await captureDeltaLifecycle(browser, scenario);
    console.log(`\nCompleted: ${scenario}\n`);
    
    // Wait between scenarios
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  await browser.close();
  
  console.log('\n=============================');
  console.log('All scenarios captured successfully!');
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
}

/**
 * Capture rapid-fire scenario
 */
async function captureRapidFire() {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  
  const sessionDir = path.join(SCREENSHOT_DIR, `rapid-fire-${Date.now()}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  
  console.log('Starting rapid-fire capture...');
  
  try {
    await page.goto(`${BASE_URL}${TEST_PAGE}`, { waitUntil: 'networkidle2' });
    await page.waitForTimeout(2000);
    
    // Start rapid fire test
    await page.evaluate(() => {
      window.rapidFireTest();
    });
    
    // Capture every 2 seconds for 40 seconds
    for (let i = 0; i <= 20; i++) {
      await page.waitForTimeout(2000);
      
      await page.screenshot({
        path: path.join(sessionDir, `rapid-${String(i).padStart(2, '0')}.png`),
        fullPage: false
      });
      
      const deltaState = await page.evaluate(() => {
        return fetch('/api/matchups/mock/delta/state')
          .then(res => res.json())
          .then(data => data.activeDeltas?.length || 0)
          .catch(() => 0);
      });
      
      console.log(`✓ Captured at ${i * 2}s - Active deltas: ${deltaState}`);
    }
    
  } catch (error) {
    console.error(`Error: ${error.message}`);
  } finally {
    await page.close();
    await browser.close();
  }
  
  console.log(`\nRapid-fire capture complete: ${sessionDir}`);
}

/**
 * Interactive capture mode
 */
async function interactiveCapture() {
  const browser = await puppeteer.launch({
    headless: false, // Show browser for interactive mode
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 }
  });
  
  const page = await browser.newPage();
  await page.goto(`${BASE_URL}${TEST_PAGE}`);
  
  console.log('\nInteractive Mode Started');
  console.log('Browser window is open. Interact with the page manually.');
  console.log('Press Ctrl+C to exit.\n');
  
  // Keep process alive
  process.stdin.resume();
}

// Parse command line arguments
const args = process.argv.slice(2);
const command = args[0] || 'all';

// Main execution
(async () => {
  try {
    switch (command) {
      case 'all':
        await runAllScenarios();
        break;
      case 'rapid':
        await captureRapidFire();
        break;
      case 'interactive':
        await interactiveCapture();
        break;
      case 'scenario':
        if (!args[1]) {
          console.error('Please specify a scenario name');
          process.exit(1);
        }
        const browser = await puppeteer.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        await captureDeltaLifecycle(browser, args[1]);
        await browser.close();
        break;
      default:
        console.log('Usage: node capture_delta_states.js [command] [options]');
        console.log('\nCommands:');
        console.log('  all         - Capture all scenarios (default)');
        console.log('  rapid       - Capture rapid-fire test');
        console.log('  interactive - Open browser for manual testing');
        console.log('  scenario <name> - Capture specific scenario');
        console.log('\nScenarios: touchdown, fieldgoal, teamscores, correction, defense, bigplay');
    }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
})();