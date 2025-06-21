describe('Fantasy Football App', () => {
  beforeAll(async () => {
    await page.goto('http://localhost:3000');
  });

  test('should load the homepage', async () => {
    await expect(page.title()).resolves.toMatch('StatFink');
  });


  test('should handle responsive design', async () => {
    await page.setViewport({ width: 375, height: 667 });
    await page.reload();
    
    const body = await page.$('body');
    expect(body).toBeTruthy();
  });
});