/**
 * Browser test for Mock Week Game Times
 * Tests that game times are actually rendered in the browser
 */

describe('Mock Week Game Times Browser Test', () => {
  const baseUrl = 'http://localhost:8000';

  beforeEach(async () => {
    // Reset mock game progression state
    await fetch('http://localhost:8000/api/matchups/mock/reset', { method: 'POST' });
    
    // Enable console logging to debug
    page.on('console', async msg => {
      if (msg.type() === 'error') {
        const args = await Promise.all(msg.args().map(arg => arg.jsonValue().catch(() => arg.toString())));
        console.log('Browser console error:', args.join(' '));
      }
    });
    
    // Log any page errors
    page.on('pageerror', error => {
      console.log('Page error:', error.message);
    });
  });

  describe('Mock Week 3 In-Progress Games', () => {
    it('should display game times for in-progress games', async () => {
      console.log('Navigating to mock week 3...');
      
      // Navigate to the page
      await page.goto(`${baseUrl}/statfink/mock/3?matchup=1`, {
        waitUntil: 'networkidle0',
        timeout: 10000
      });
      
      // Wait for the data to load
      console.log('Waiting for player rows to load...');
      await page.waitForSelector('.playerrow1', { 
        visible: true,
        timeout: 10000 
      });
      
      // Wait for the matchup data to be loaded by checking for a specific element
      await page.waitForFunction(
        () => {
          const cells = document.querySelectorAll('td.status');
          return cells.length > 10; // Ensure we have player status cells
        },
        { timeout: 5000 }
      );
      
      // Wait a bit more to ensure JavaScript has executed
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Get all status cells
      const statusCells = await page.$$eval('td.status', cells => 
        cells.map(cell => ({
          text: cell.textContent.trim(),
          html: cell.innerHTML,
          className: cell.className
        }))
      );
      
      console.log(`Found ${statusCells.length} status cells`);
      
      // Filter out header cells
      const playerStatuses = statusCells.filter(cell => 
        cell.text && cell.text !== 'Game Status'
      );
      
      console.log(`Found ${playerStatuses.length} player status cells`);
      
      // Log first few statuses for debugging
      console.log('First 5 player statuses:');
      playerStatuses.slice(0, 5).forEach((status, i) => {
        console.log(`  ${i + 1}. "${status.text}"`);
      });
      
      // Check for in-progress games
      const inProgressGames = playerStatuses.filter(status => 
        /\d[Q] \d{1,2}:\d{2}/.test(status.text)
      );
      
      console.log(`Found ${inProgressGames.length} in-progress games`);
      
      // Should have at least some in-progress games
      expect(inProgressGames.length).toBeGreaterThan(0);
      
      // Check for specific game times we expect
      const gameTexts = playerStatuses.map(s => s.text);
      expect(gameTexts).toContain('3Q 12:45');
      expect(gameTexts).toContain('3Q 8:22');
    });

    it('should check if getPlayerGameStatus function is available', async () => {
      await page.goto(`${baseUrl}/statfink/mock/3?matchup=1`, {
        waitUntil: 'networkidle0'
      });
      
      // Check if the function exists in the page context
      const functionExists = await page.evaluate(() => {
        return typeof getPlayerGameStatus === 'function';
      });
      
      expect(functionExists).toBe(true);
      
      // Test the function directly
      const testResult = await page.evaluate(() => {
        // Test with mock data
        const testCases = [
          { game_status: 'InProgress', game_time: '3Q 12:45' },
          { game_status: 'Halftime', game_time: 'Halftime' },
          { game_status: 'Scheduled', game_time: '4:25 PM ET' },
          { game_status: 'Final' }
        ];
        
        return testCases.map(testCase => ({
          input: testCase,
          output: getPlayerGameStatus(testCase)
        }));
      });
      
      console.log('Function test results:', testResult);
      
      // Verify the function works correctly
      expect(testResult[0].output).toBe('3Q 12:45');
      expect(testResult[1].output).toBe('Halftime');
      expect(testResult[2].output).toBe('1:25 PM'); // 4:25 PM ET converted to PST
      expect(testResult[3].output).toBe('Final');
    });

    it('should verify data is loaded before display', async () => {
      await page.goto(`${baseUrl}/statfink/mock/3?matchup=1`);
      
      // Wait for the API call to complete
      const apiResponse = await page.waitForResponse(
        response => response.url().includes('/api/matchups/mock-game/1'),
        { timeout: 10000 }
      );
      
      const apiData = await apiResponse.json();
      console.log('API response received:', apiData.success);
      
      // Wait for DOM to update
      await page.waitForSelector('.playerrow1', { visible: true });
      await new Promise(resolve => setTimeout(resolve, 500)); // Extra wait for JS execution
      
      // Check if data made it to the DOM
      const domData = await page.evaluate(() => {
        const rows = document.querySelectorAll('.playerrow1, .playerrow2');
        return Array.from(rows).map(row => {
          const statusCell = row.querySelector('td.status');
          return statusCell ? statusCell.textContent.trim() : null;
        });
      });
      
      console.log('DOM status values:', domData.slice(0, 5));
      
      // Verify at least some in-progress games
      const inProgressInDom = domData.filter(status => 
        status && /\d[Q] \d{1,2}:\d{2}/.test(status)
      );
      
      expect(inProgressInDom.length).toBeGreaterThan(0);
    });

    it('should check innerHTML vs textContent', async () => {
      await page.goto(`${baseUrl}/statfink/mock/3?matchup=1`, {
        waitUntil: 'networkidle0'
      });
      
      await page.waitForSelector('.playerrow1');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Get both innerHTML and textContent
      const cellData = await page.evaluate(() => {
        const cells = document.querySelectorAll('td.status');
        return Array.from(cells).slice(0, 5).map(cell => ({
          innerHTML: cell.innerHTML,
          textContent: cell.textContent,
          innerText: cell.innerText
        }));
      });
      
      console.log('Cell data inspection:');
      cellData.forEach((cell, i) => {
        console.log(`Cell ${i}:`);
        console.log(`  innerHTML: "${cell.innerHTML}"`);
        console.log(`  textContent: "${cell.textContent}"`);
        console.log(`  innerText: "${cell.innerText}"`);
      });
      
      // Check if any cells contain unrendered template literals
      const hasTemplateLiterals = cellData.some(cell => 
        cell.innerHTML.includes('${')
      );
      
      expect(hasTemplateLiterals).toBe(false);
    });
  });

  describe('Debug Display Function', () => {
    it('should trace displayTeamRoster execution', async () => {
      await page.goto(`${baseUrl}/statfink/mock/3?matchup=1`, {
        waitUntil: 'networkidle0'
      });
      
      // Wait for the displayTeamRoster function to be available
      await page.waitForFunction(() => typeof displayTeamRoster === 'function', {
        timeout: 5000
      });
      
      // Check if the function was called and data was rendered
      const result = await page.evaluate(() => {
        // Check if we have rendered player rows
        const team0Rows = document.querySelectorAll('#team0 .playerrow1, #team0 .playerrow2');
        const team1Rows = document.querySelectorAll('#team1 .playerrow1, #team1 .playerrow2');
        
        // Get status cells
        const statusCells = document.querySelectorAll('td.status');
        const statuses = Array.from(statusCells).map(cell => cell.textContent.trim());
        
        return {
          team0RowCount: team0Rows.length,
          team1RowCount: team1Rows.length,
          totalStatusCells: statusCells.length,
          sampleStatuses: statuses.slice(0, 5),
          functionExists: typeof displayTeamRoster === 'function'
        };
      });
      
      console.log('Display function result:', result);
      
      // Verify that displayTeamRoster exists and rendered data
      expect(result.functionExists).toBe(true);
      expect(result.team0RowCount).toBeGreaterThan(0);
      expect(result.team1RowCount).toBeGreaterThan(0);
      expect(result.totalStatusCells).toBeGreaterThan(0);
    });
  });
});