#!/usr/bin/env node

const puppeteer = require('/home/joepaley/statfink2/node_modules/puppeteer');
const path = require('path');
const fs = require('fs');

async function takeScreenshots(url, options = {}) {
  const {
    waitTime = 3000,
    viewportSize = 'desktop',
    fullPage = true,
    outputDir = '/home/joepaley/statfink2/screenshots'
  } = options;

  const viewports = {
    desktop: { width: 1920, height: 1080 },
    laptop: { width: 1366, height: 768 },
    tablet: { width: 768, height: 1024 },
    mobile: { width: 375, height: 812 }
  };

  const viewport = viewports[viewportSize] || viewports.desktop;

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const urlSlug = url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);

  console.log(`Starting Puppeteer to capture ${url}...`);
  console.log(`Viewport: ${viewportSize} (${viewport.width}x${viewport.height})`);
  console.log(`Output directory: ${outputDir}`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  try {
    const page = await browser.newPage();
    
    await page.setViewport(viewport);
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    console.log(`Navigating to ${url}...`);
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });

    console.log(`Waiting ${waitTime}ms for dynamic content...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));

    const viewportScreenshotPath = path.join(outputDir, `${timestamp}_${urlSlug}_${viewportSize}_viewport.png`);
    await page.screenshot({
      path: viewportScreenshotPath,
      fullPage: false
    });
    console.log(`✓ Viewport screenshot saved: ${viewportScreenshotPath}`);

    if (fullPage) {
      const fullPageScreenshotPath = path.join(outputDir, `${timestamp}_${urlSlug}_${viewportSize}_fullpage.png`);
      await page.screenshot({
        path: fullPageScreenshotPath,
        fullPage: true
      });
      console.log(`✓ Full page screenshot saved: ${fullPageScreenshotPath}`);
    }

    const title = await page.title();
    console.log(`Page title: ${title}`);

    const dimensions = await page.evaluate(() => {
      return {
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        deviceScaleFactor: window.devicePixelRatio
      };
    });
    console.log(`Page dimensions: ${dimensions.width}x${dimensions.height} (DPR: ${dimensions.deviceScaleFactor})`);

  } catch (error) {
    console.error('Error taking screenshots:', error);
    throw error;
  } finally {
    await browser.close();
    console.log('Browser closed.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node take_screenshots.js <URL> [options]');
    console.log('\nOptions:');
    console.log('  --viewport <size>  Viewport size: desktop, laptop, tablet, mobile (default: desktop)');
    console.log('  --wait <ms>        Wait time for dynamic content in milliseconds (default: 3000)');
    console.log('  --no-fullpage      Disable full page screenshot');
    console.log('  --output <dir>     Output directory (default: ./screenshots)');
    console.log('\nExamples:');
    console.log('  node take_screenshots.js https://example.com');
    console.log('  node take_screenshots.js https://example.com --viewport mobile --wait 5000');
    console.log('  node take_screenshots.js http://localhost:3000 --no-fullpage');
    process.exit(1);
  }

  const url = args[0];
  const options = {};

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--viewport':
        options.viewportSize = args[++i];
        break;
      case '--wait':
        options.waitTime = parseInt(args[++i], 10);
        break;
      case '--no-fullpage':
        options.fullPage = false;
        break;
      case '--output':
        options.outputDir = args[++i];
        break;
    }
  }

  if (options.outputDir && !path.isAbsolute(options.outputDir)) {
    options.outputDir = path.join(process.cwd(), options.outputDir);
  }

  try {
    await takeScreenshots(url, options);
    console.log('\n✅ Screenshots captured successfully!');
  } catch (error) {
    console.error('\n❌ Failed to capture screenshots:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { takeScreenshots };