#!/usr/bin/env node

/**
 * Setup Google Sheets authentication with proper scopes
 * This script will open a browser for you to authorize the app
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

// Define the scopes we need
const SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',  // Read/write Google Sheets
    'https://www.googleapis.com/auth/gmail.readonly' // Keep existing Gmail scope
];

const TOKEN_PATH = path.join(__dirname, '../server/config/sheets-token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../roster_moves/credentials.json');

async function main() {
    console.log('Google Sheets Authentication Setup');
    console.log('==================================\n');
    
    // Check if credentials exist
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error('Error: credentials.json not found at', CREDENTIALS_PATH);
        console.error('Please ensure roster_moves/credentials.json exists');
        process.exit(1);
    }
    
    // Load client secrets
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    
    // Authorize
    const auth = await authorize(credentials);
    
    console.log('\n✓ Authentication successful!');
    console.log(`Token saved to: ${TOKEN_PATH}`);
    console.log('\nYou can now use the Google Sheets export feature.');
}

/**
 * Create an OAuth2 client and get new token
 */
async function authorize(credentials) {
    const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    
    // Check if we already have a token
    if (fs.existsSync(TOKEN_PATH)) {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        
        // Check if token has required scopes
        if (token.scope && token.scope.includes('spreadsheets')) {
            console.log('Existing token already has Google Sheets access.');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });
            
            const answer = await new Promise(resolve => {
                rl.question('Do you want to re-authenticate anyway? (y/N): ', resolve);
            });
            rl.close();
            
            if (answer.toLowerCase() !== 'y') {
                oAuth2Client.setCredentials(token);
                return oAuth2Client;
            }
        }
    }
    
    // Get new token
    return getNewToken(oAuth2Client);
}

/**
 * Get and store new token
 */
async function getNewToken(oAuth2Client) {
    const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent' // Force consent screen to ensure we get refresh token
    });
    
    console.log('\nAuthorize this app by visiting this URL:');
    console.log('\n' + authUrl + '\n');
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    const code = await new Promise((resolve) => {
        rl.question('Enter the authorization code from that page here: ', resolve);
    });
    rl.close();
    
    try {
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        
        // Store the token
        const configDir = path.dirname(TOKEN_PATH);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('\n✓ Token stored successfully');
        
        return oAuth2Client;
    } catch (error) {
        console.error('Error retrieving access token:', error.message);
        process.exit(1);
    }
}

// Test the authentication
async function testAuth() {
    try {
        const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
        const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
        const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
        const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
        auth.setCredentials(token);
        
        const sheets = google.sheets({ version: 'v4', auth });
        
        // Try to get spreadsheet info for the StatFink sheet
        const spreadsheetId = '1jMMoRej0I9jaQkweZV_ePQ2HVKFETvs4F7swIAgopV0';
        console.log('\nTesting access to your StatFink Google Sheet...');
        
        const response = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'properties.title'
        });
        
        console.log(`✓ Successfully accessed sheet: "${response.data.properties.title}"`);
        console.log('\nAuthentication is working correctly!');
        
    } catch (error) {
        console.error('\n✗ Test failed:', error.message);
        if (error.message.includes('403')) {
            console.error('\nYou need to share the Google Sheet with your account or make it publicly editable.');
        }
    }
}

// Run the setup
main().then(() => {
    // Test the authentication after setup
    return testAuth();
}).catch(error => {
    console.error('Setup failed:', error);
    process.exit(1);
});