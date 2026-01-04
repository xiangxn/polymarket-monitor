
import * as fs from 'fs';
import * as path from 'path';

interface AddressData {
    funder_address: string;
    owner_address_pri: string;
    clob_api_key: string;
    clob_secret: string;
    clob_passphrase: string;
    builder_api_key: string;
    builder_secret: string;
    builder_passphrase: string;
}

async function main() {
    const envsDir = path.join(__dirname, '../envs/azz');
    const outputFilePath = path.join(__dirname, '../addresses.config.json');

    // 读取目录下所有.env文件
    const files = fs.readdirSync(envsDir).filter(file => file.endsWith('.env'));

    const addressDataArray: AddressData[] = [];

    // 逐个处理.env文件
    for (const file of files) {
        const filePath = path.join(envsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');

        // 解析环境变量
        const envData: { [key: string]: string } = {};
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;

            const match = trimmedLine.match(/^(\w+)=(.*)$/);
            if (match) {
                const key = match[1];
                let value = match[2];
                // 去除引号
                value = value.replace(/^"|"$/g, '');
                envData[key] = value;
            }
        }

        // 构建地址数据对象
        const addressData: AddressData = {
            funder_address: envData.FUNDER_ADDRESS || '',
            owner_address_pri: envData.OWNER_ADDRESS_PRI || '',
            clob_api_key: envData.CLOB_API_KEY || '',
            clob_secret: envData.CLOB_SECRET || '',
            clob_passphrase: envData.CLOB_PASS_PHRASE || '',
            builder_api_key: envData.BUILDER_API_KEY || '',
            builder_secret: envData.BUILDER_SECRET || '',
            builder_passphrase: envData.BUILDER_PASS_PHRASE || ''
        };

        addressDataArray.push(addressData);
    }

    // 写入JSON文件
    fs.writeFileSync(outputFilePath, JSON.stringify(addressDataArray, null, 4), 'utf-8');

    console.log(`Successfully processed ${addressDataArray.length} files.`);
    console.log(`Output written to: ${outputFilePath}`);

    // 校验JSON数据与.env文件中的值
    console.log('\nValidating JSON data against .env files...');
    const jsonData = JSON.parse(fs.readFileSync(outputFilePath, 'utf-8'));

    let hasErrors = false;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const filePath = path.join(envsDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const jsonEntry = jsonData[i];

        // 解析.env文件
        const envData: { [key: string]: string } = {};
        const lines = content.split('\n');

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine || trimmedLine.startsWith('#')) continue;

            const match = trimmedLine.match(/^(\w+)=(.*)$/);
            if (match) {
                const key = match[1];
                let value = match[2];
                value = value.replace(/^"|"$/g, '');
                envData[key] = value;
            }
        }

        // 校验字段
        const fields: (keyof AddressData)[] = [
            'funder_address',
            'owner_address_pri',
            'clob_api_key',
            'clob_secret',
            'clob_passphrase',
            'builder_api_key',
            'builder_secret',
            'builder_passphrase'
        ];

        const envFieldMap: Record<keyof AddressData, string> = {
            funder_address: 'FUNDER_ADDRESS',
            owner_address_pri: 'OWNER_ADDRESS_PRI',
            clob_api_key: 'CLOB_API_KEY',
            clob_secret: 'CLOB_SECRET',
            clob_passphrase: 'CLOB_PASS_PHRASE',
            builder_api_key: 'BUILDER_API_KEY',
            builder_secret: 'BUILDER_SECRET',
            builder_passphrase: 'BUILDER_PASS_PHRASE'
        };

        for (const field of fields) {
            const envKey = envFieldMap[field];
            const envValue = envData[envKey] || '';
            const jsonValue = jsonEntry[field];

            if (envValue !== jsonValue) {
                console.error(`❌ Mismatch in ${file}:`);
                console.error(`   ${envKey}: .env="${envValue.substring(0, 20)}..." vs JSON="${jsonValue.substring(0, 20)}..."`);
                hasErrors = true;
            }
        }

        if (!hasErrors || i === 0) {
            console.log(`✓ ${file}: All fields match`);
        }
    }

    if (hasErrors) {
        console.error('\n⚠️  Validation failed: Some fields do not match!');
    } else {
        console.log('\n✅ Validation passed: All fields match!');
    }
}

main().catch(console.error);