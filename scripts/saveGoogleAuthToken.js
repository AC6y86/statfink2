#!/usr/bin/env node

/**
 * Save Google authorization token after OAuth flow
 * 
 * Usage:
 *   node scripts/saveGoogleAuthToken.js YOUR_AUTH_CODE
 * 
 * The auth code comes from the URL after authorizing the app
 */

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, '../server/config/sheets-token.json');
const CREDENTIALS_PATH = path.join(__dirname, '../roster_moves/credentials.json');

async function saveToken(authCode) {
    if (!authCode) {
        console.error('Error: Please provide the authorization code as an argument');
        console.error('Usage: node scripts/saveGoogleAuthToken.js YOUR_AUTH_CODE');
        console.error('\nTo get a new auth code:');
        console.error('1. Run: node utils/setupGoogleSheetsAuth.js');
        console.error('2. Follow the URL and authorize the app');
        console.error('3. Copy the code from the redirect URL');
        console.error('4. Run this script with the code');
        process.exit(1);
    }
    
    console.log('Saving Google Sheets authorization token...');
    console.log('Auth code:', authCode.substring(0, 20) + '...');
    
    const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    
    try {
        const { tokens } = await oAuth2Client.getToken(authCode);
        
        // Ensure config directory exists
        const configDir = path.dirname(TOKEN_PATH);
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }
        
        // Save the token
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('✓ Token saved successfully to:', TOKEN_PATH);
        console.log('  This token will be used for all Google Sheets exports');
        
        // Test access to the sheet
        oAuth2Client.setCredentials(tokens);
        const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });
        
        const spreadsheetId = '1jMMoRej0I9jaQkweZV_ePQ2HVKFETvs4F7swIAgopV0';
        console.log('\nTesting access to your StatFink Google Sheet...');
        
        const response = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'properties.title'
        });
        
        console.log(`✓ Successfully accessed sheet: "${response.data.properties.title}"`);
        console.log('\n🎉 Google Sheets authentication is set up and working!');
        console.log('\nYou can now:');
        console.log('1. Use the export button in the admin dashboard (/admin)');
        console.log('2. Run exports from command line with: node utils/exportWeekToSheets.js');
        console.log('\nThe refresh token will keep the auth working indefinitely.');
        console.log('You should only need to re-authenticate if:');
        console.log('- You revoke access in your Google account');
        console.log('- The app credentials change');
        console.log('- You need to add new permissions/scopes');
        
    } catch (error) {
        console.error('\n❌ Error saving token:', error.message);
        
        if (error.message.includes('invalid_grant')) {
            console.error('\nThe authorization code has expired or was already used.');
            console.error('Authorization codes can only be used once and expire quickly.');
            console.error('\nTo get a new code:');
            console.error('1. Run: node utils/setupGoogleSheetsAuth.js');
            console.error('2. Follow the URL and authorize the app');
            console.error('3. Copy the NEW code from the redirect URL');
            console.error('4. Run this script immediately with the new code');
        } else if (error.message.includes('invalid_client')) {
            console.error('\nThe client credentials are invalid.');
            console.error('Check roster_moves/credentials.json');
        }
        
        process.exit(1);
    }
}

// Get auth code from command line argument
const authCode = process.argv[2];
saveToken(authCode).catch(console.error);