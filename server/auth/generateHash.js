#!/usr/bin/env node
const bcrypt = require('bcrypt');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

console.log('🔐 StatFink Password Hash Generator\n');

rl.question('Enter the password you want to hash: ', async (password) => {
    try {
        if (password.length < 8) {
            console.error('❌ Password must be at least 8 characters long');
            rl.close();
            return;
        }
        
        const saltRounds = 12;
        const hash = await bcrypt.hash(password, saltRounds);
        
        console.log('\n✅ Password hashed successfully!\n');
        console.log('Hash:', hash);
        console.log('\nAdd this to your .env file:');
        console.log(`ADMIN_PASSWORD_HASH="${hash}"`);
        
    } catch (error) {
        console.error('❌ Error hashing password:', error.message);
    }
    
    rl.close();
});

rl.on('close', () => {
    process.exit(0);
});