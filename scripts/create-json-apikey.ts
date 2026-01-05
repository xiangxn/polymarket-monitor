import fs from 'fs';
import path from 'path';
import { ethers } from "ethers";
import { Encryptor } from "../src/utils/encryptor";
import { createApiKey, createBuilderApiKey } from './create-apikey';
import * as readlineSync from 'readline-sync';
import { AddressData } from './update-user-data'

async function main() {
    const jsonName = readlineSync.question('Enter json name: ')
    const pwd = readlineSync.question('Enter startup password: ', {
        hideEchoBack: true
    });
    // 读取 addr.csv 文件
    const csvPath = path.join(__dirname, '../addr.csv');
    const csvContent = fs.readFileSync(csvPath, 'utf-8');

    // 解析 CSV 内容到数组
    const lines = csvContent.trim().split('\n');
    const addressArray = lines.map(line => {
        const columns = line.split(',');
        return {
            ownerAddress: columns[0].trim(),
            privateKey: columns[1].trim(),
            funderAddress: columns[2].trim(),
            profileUrl: columns[3].trim()
        };
    });

    console.log(`成功读取 ${addressArray.length} 条地址记录`);

    if (addressArray.length > 0) {
        let addressData: AddressData[] = []
        for (let addr of addressArray) {
            const wallet = new ethers.Wallet(`${addr.privateKey}`);
            const encryptor = new Encryptor(pwd);
            const apikey = await createApiKey(wallet);
            const builderApiKey = await createBuilderApiKey(wallet, apikey)
            addressData.push({
                funder_address: addr.funderAddress,
                owner_address_pri: encryptor.encrypt(addr.privateKey),
                clob_api_key: encryptor.encrypt(apikey.key),
                clob_secret: encryptor.encrypt(apikey.secret),
                clob_passphrase: encryptor.encrypt(apikey.passphrase),
                builder_api_key: encryptor.encrypt(builderApiKey.key),
                builder_secret: encryptor.encrypt(builderApiKey.secret),
                builder_passphrase: encryptor.encrypt(builderApiKey.passphrase),
            })
        }
        console.log(`成功处理 ${addressData.length} 条地址配置`);
        if (addressData.length > 0) {
            fs.writeFileSync(`${jsonName}.config.json`, JSON.stringify(addressData))
        }
    }
}

main();