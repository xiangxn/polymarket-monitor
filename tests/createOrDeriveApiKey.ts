import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "../.env") });

import { initConfig } from "../src/config";
initConfig(resolve(__dirname, "../addresses.config.json"))

import { axiosInstance } from "@polymarket/clob-client/dist/http-helpers/index";

const agent = new SocksProxyAgent('socks5h://127.0.0.1:1080');

axiosInstance.defaults.proxy = false;
axiosInstance.defaults.httpsAgent = agent;
axiosInstance.defaults.httpAgent = agent;

import { getConfig } from "../src/config";
import { ApiKeyCreds, Chain, ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { SocksProxyAgent } from "socks-proxy-agent";

const config = getConfig()


async function main() {
    const wallet = new Wallet(`${config.OWNER_ADDRESS_PRI}`);
    const chainId = parseInt(`${process.env.CHAIN_ID || 137}`) as Chain;
    console.log(`Address: ${await wallet.getAddress()}, chainId: ${chainId}`);

    const host = process.env.CLOB_API_URL || "https://clob.polymarket.com/";
    const creds: ApiKeyCreds = {
        key: `${config.CLOB_API_KEY}`,
        secret: `${config.CLOB_SECRET}`,
        passphrase: `${config.CLOB_PASS_PHRASE}`,
    };
    const clobClient = new ClobClient(host, chainId, wallet, creds);

    console.log(`Response: `);
    const resp = await clobClient.createBuilderApiKey();
    console.log(resp);
}

main();