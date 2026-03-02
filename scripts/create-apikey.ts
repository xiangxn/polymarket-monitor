import { Encryptor } from "../src/utils/encryptor";
import * as readlineSync from 'readline-sync';
import { ethers } from "ethers";
import { ApiKeyCreds, Chain, ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

import { axiosInstance } from "@polymarket/clob-client/dist/http-helpers";
import { SocksProxyAgent } from "socks-proxy-agent";
import fs from "fs/promises"

const agent = new SocksProxyAgent("socks5h://127.0.0.1:1080");
axiosInstance.defaults.proxy = false
axiosInstance.defaults.httpsAgent = agent;
axiosInstance.defaults.httpAgent = agent;

export async function createApiKey(wallet: Wallet) {
    const chainId = parseInt(`${process.env.CHAIN_ID || '137'}`) as Chain;
    console.log(`Address: ${await wallet.getAddress()}, chainId: ${chainId}`);

    const host = process.env.CLOB_API_URL || "https://clob.polymarket.com";
    const clobClient = new ClobClient(host, chainId, wallet);

    console.log(`ApiKey: `);
    let resp = await clobClient.createOrDeriveApiKey()
    console.log(resp);
    console.log(`Complete!`);
    return resp
}

export async function createBuilderApiKey(wallet: Wallet, creds: ApiKeyCreds) {
    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    console.log(`Address: ${await wallet.getAddress()}, chainId: ${chainId}`);

    const host = process.env.CLOB_API_URL || "https://clob.polymarket.com/";
    const clobClient = new ClobClient(host, chainId, wallet, creds);

    console.log(`BuilderApiKey: `);
    const resp = await clobClient.createBuilderApiKey();
    console.log(resp);
    return resp
}

export async function createEnv(funderAddr: string, ownerPri: string, apikey: ApiKeyCreds, builderApikey: ApiKeyCreds, encryptor: Encryptor, envName: string) {
    const env = {
        MIN_BALANCE: 140,
        MIN_VOLUME: 1000,
        SEARCH_START_TIME: 0,
        SEARCH_END_TIME: 5,

        MIN_ORDER_SIZE: 10,
        MAX_ORDER_SIZE: 10,

        ENTER_WINDOW: "[0.85,0.98]",
        MIN_END_TIME: 20,

        RELATIVE_PRICE_CHANGE: 0.002,
        FUNDER_ADDRESS: funderAddr,
        OWNER_ADDRESS_PRI: encryptor.encrypt(ownerPri),
        CLOB_API_KEY: encryptor.encrypt(apikey.key),
        CLOB_SECRET: encryptor.encrypt(apikey.secret),
        CLOB_PASS_PHRASE: encryptor.encrypt(apikey.passphrase),

        // CHAIN_RPC_URL: "https://polygon.drpc.org/",
        // USDC_ADDRESS: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        // CTF_ADDRESS: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
        // NEG_RISK_CTF_ADDRESS: "0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296",
        // POLYMARKET_RELAYER_URL: "https://relayer-v2.polymarket.com/",
        BUILDER_API_KEY: encryptor.encrypt(builderApikey.key),
        BUILDER_SECRET: encryptor.encrypt(builderApikey.secret),
        BUILDER_PASS_PHRASE: encryptor.encrypt(builderApikey.passphrase)
    }
    const envStr = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')
    await fs.writeFile(`${envName}.env`, envStr)
}

async function main() {
    const privateKey = readlineSync.question('Enter owner private_key: ', {
        hideEchoBack: true
    });
    const funderAddr = readlineSync.question('Enter funder address: ')
    const envName = readlineSync.question('Enter env name: ')
    const pwd = readlineSync.question('Enter startup password: ', {
        hideEchoBack: true
    });

    const wallet = new ethers.Wallet(`${privateKey}`);
    const encryptor = new Encryptor(pwd);
    const apikey = await createApiKey(wallet);
    const builderApiKey = await createBuilderApiKey(wallet, apikey)

    await createEnv(funderAddr, privateKey, apikey, builderApiKey, encryptor, envName)
}
if (require.main === module) {
    main();
}

