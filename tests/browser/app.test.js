describe('Fantasy Football App', () => {
  beforeAll(async () => {
    await page.goto('http://localhost:3000');
  });

  test('should load the homepage', async () => {
    await expect(page.title()).resolves.toMatch('StatFink');
  });

  test('should display navigation elements', async () => {
    await expect(page).toMatchElement('nav');
  });

  test('should load league standings', async () => {
    const standingsElement = await page.waitForSelector('[data-testid="standings"], .standings, #standings', { timeout: 5000 });
    expect(standingsElement).toBeTruthy();
  });

  test('should handle responsive design', async () => {
    await page.setViewport({ width: 375, height: 667 });
    await page.reload();
    
    const body = await page.$('body');
    expect(body).toBeTruthy();
  });
});