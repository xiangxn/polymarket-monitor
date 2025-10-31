import crypto from 'crypto';

export class Encryptor {
    private algorithm: string = 'aes-256-cbc';
    private key: Buffer;
    private iv: Buffer;

    constructor(password: string) {
        // Derive a 32-byte key and 16-byte IV from the password
        const hash = crypto.createHash('sha256').update(password).digest();
        this.key = hash;
        this.iv = Buffer.from(hash.subarray(0, 16));
    }

    encrypt(text: string): string {
        const cipher = crypto.createCipheriv(this.algorithm, this.key, this.iv);
        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return encrypted;
    }

    decrypt(encryptedText: string): string {
        const decipher = crypto.createDecipheriv(this.algorithm, this.key, this.iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
}
