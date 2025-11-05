import { Encryptor } from './encryptor';
import * as dotenv from 'dotenv';
import * as readlineSync from 'readline-sync';

// Load environment variables
dotenv.config();

// Get password from CLI input (hidden)
const password = readlineSync.question('Enter encryption password: ', {
    hideEchoBack: true
});

if (!password) {
    console.error('Password is required');
    process.exit(1);
}

const encryptor = new Encryptor(password);

// List of environment variables to encrypt
const envVars = [
    'OWNER_ADDRESS_PRI',
    'CLOB_API_KEY',
    'CLOB_SECRET',
    'CLOB_PASS_PHRASE',
    'BUILDER_PASS_PHRASE',
    'BUILDER_SECRET',
    'BUILDER_API_KEY'
];

// Encrypt each variable and print the result
envVars.forEach(varName => {
    const value = process.env[varName];
    if (value) {
        const encrypted = encryptor.encrypt(value);
        console.log(`${varName} = ${encrypted}`);
    }
});