const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const TOKEN_PATH = path.join(__dirname, 'token.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');

async function authorize() {
  try {
    const content = await fs.readFile(CREDENTIALS_PATH);
    const credentials = JSON.parse(content);
    const { client_secret, client_id, redirect_uris } = credentials.installed;
    
    const oAuth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris[0]
    );

    // Check if we have a previously stored token
    try {
      const token = await fs.readFile(TOKEN_PATH);
      oAuth2Client.setCredentials(JSON.parse(token));
      console.log('Using existing token');
      return oAuth2Client;
    } catch (err) {
      console.log('No existing token found, need to authorize');
      return getNewToken(oAuth2Client);
    }
  } catch (err) {
    console.error('Error loading client secret file:', err);
    throw err;
  }
}

async function getNewToken(oAuth2Client) {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });
  
  console.log('\n==============================================');
  console.log('AUTHORIZATION REQUIRED');
  console.log('==============================================\n');
  console.log('Since this machine cannot open a browser, please:');
  console.log('\n1. Copy this entire URL and open it in a browser on another machine:\n');
  console.log(authUrl);
  console.log('\n2. Sign in with your Google account');
  console.log('3. Grant permissions to read Gmail');
  console.log('4. You will be redirected to a URL that looks like:');
  console.log('   http://localhost/?code=XXXXXXXXX&scope=...');
  console.log('5. Copy the ENTIRE redirect URL');
  console.log('\n==============================================\n');
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  return new Promise((resolve, reject) => {
    rl.question('Paste the ENTIRE redirect URL here: ', async (url) => {
      rl.close();
      
      try {
        // Extract the code from the URL
        const urlObj = new URL(url);
        const code = urlObj.searchParams.get('code');
        
        if (!code) {
          throw new Error('No authorization code found in URL');
        }
        
        // Exchange code for tokens
        const { tokens } = await oAuth2Client.getToken(code);
        oAuth2Client.setCredentials(tokens);
        
        // Store the token for future use
        await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
        console.log('\nToken stored successfully in', TOKEN_PATH);
        console.log('You won\'t need to do this again unless the token expires.\n');
        
        resolve(oAuth2Client);
      } catch (err) {
        console.error('Error parsing authorization code:', err.message);
        reject(err);
      }
    });
  });
}

async function testConnection() {
  try {
    const auth = await authorize();
    const gmail = google.gmail({ version: 'v1', auth });
    
    console.log('Testing Gmail connection...');
    const res = await gmail.users.getProfile({ userId: 'me' });
    console.log('✓ Successfully connected to Gmail');
    console.log('  Email address:', res.data.emailAddress);
    console.log('  Total messages:', res.data.messagesTotal);
    console.log('\nSetup complete! You can now run the monitoring service.\n');
  } catch (error) {
    console.error('Connection test failed:', error.message);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  console.log('Gmail API Authorization Setup');
  console.log('==============================\n');
  testConnection();
}

module.exports = { authorize };