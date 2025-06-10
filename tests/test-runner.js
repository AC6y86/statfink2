#!/usr/bin/env node

const { spawn } = require('child_process');
const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

console.log('🏈 StatFink Test Runner');
console.log('=======================\n');

async function checkServerStatus() {
    try {
        const response = await axios.get(`${BASE_URL}/health`, { timeout: 3000 });
        return response.data.status === 'healthy';
    } catch (error) {
        return false;
    }
}

async function runTests(testType = 'all') {
    console.log(`🚀 Running ${testType} tests...\n`);
    
    const serverRunning = await checkServerStatus();
    
    if (!serverRunning && (testType === 'integration' || testType === 'all')) {
        console.log('⚠️  Server not running - integration tests will be skipped');
        console.log('💡 Start server with: npm start\n');
    }

    const testCommands = {
        'unit': 'npm run test:unit',
        'integration': 'npm run test:integration',
        'fast': 'npm run test:fast',
        'all': 'npm test'
    };

    const command = testCommands[testType] || testCommands.all;
    
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = command.split(' ');
        const testProcess = spawn(cmd, args, { 
            stdio: 'inherit',
            shell: true 
        });

        testProcess.on('close', (code) => {
            if (code === 0) {
                console.log(`\n✅ ${testType} tests completed successfully!`);
                resolve(code);
            } else {
                console.log(`\n❌ ${testType} tests failed with code ${code}`);
                resolve(code);
            }
        });

        testProcess.on('error', (error) => {
            console.error(`\n❌ Error running tests: ${error.message}`);
            reject(error);
        });
    });
}

async function showTestInfo() {
    console.log('📋 Available Test Commands:');
    console.log('   npm run test:unit         - Run unit tests only (fast)');
    console.log('   npm run test:integration  - Run integration tests (requires server)');
    console.log('   npm run test:fast         - Run unit tests silently');
    console.log('   npm test                  - Run all tests');
    console.log('   node test-runner.js       - This runner script\n');

    console.log('🧪 Test Structure:');
    console.log('   tests/unit/              - Unit tests (no server required)');
    console.log('     - validation.test.js   - Data validation tests');
    console.log('     - scoringService.test.js - Fantasy scoring tests');
    console.log('     - errorHandler.test.js - Error handling tests');
    console.log('   tests/integration/       - Integration tests (server required)');
    console.log('     - database.test.js     - Database operation tests');
    console.log('     - tank01.test.js       - Tank01 API integration tests');
    console.log('     - dashboard.test.js    - Dashboard web interface tests\n');

    const serverRunning = await checkServerStatus();
    console.log(`🖥️  Server Status: ${serverRunning ? '✅ Running' : '❌ Not running'}`);
    
    if (serverRunning) {
        try {
            const [playersRes, teamsRes] = await Promise.all([
                axios.get(`${BASE_URL}/api/players`),
                axios.get(`${BASE_URL}/api/teams`)
            ]);
            console.log(`📊 Database: ${playersRes.data.data.length} players, ${teamsRes.data.data.length} teams`);
        } catch (error) {
            console.log('📊 Database: Error fetching data');
        }
    }
    console.log();
}

// Handle command line arguments
const testType = process.argv[2];

if (testType === 'help' || testType === '--help' || testType === '-h') {
    showTestInfo();
} else if (testType && ['unit', 'integration', 'fast', 'all'].includes(testType)) {
    runTests(testType);
} else if (testType) {
    console.log(`❌ Unknown test type: ${testType}`);
    console.log('💡 Available types: unit, integration, fast, all');
    showTestInfo();
} else {
    showTestInfo();
    console.log('💡 Usage: node test-runner.js [unit|integration|fast|all|help]');
}