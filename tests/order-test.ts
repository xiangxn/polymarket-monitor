import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "../.env") });

import { initEncryptor } from "../src/config";
initEncryptor()

import { axiosInstance } from "@polymarket/clob-client/dist/http-helpers/index";

import { SocksProxyAgent } from "socks-proxy-agent";
const agent = new SocksProxyAgent('socks5h://127.0.0.1:1080');

axiosInstance.defaults.proxy = false;
axiosInstance.defaults.httpsAgent = agent;
axiosInstance.defaults.httpAgent = agent;

import { getConfig } from "../src/config";
import { ApiKeyCreds, Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";
import { SignatureType } from "@polymarket/order-utils";


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
    const clobClient = new ClobClient(host, chainId, wallet, creds, SignatureType.POLY_GNOSIS_SAFE, config.FUNDER_ADDRESS);

    const tokkenId = process.env.TOKEN_ID ?? ""
    const order = await clobClient.createOrder({
        tokenID: tokkenId,
        price: 0.5,
        size: 1.0,
        side: Side.BUY,
    })
    console.log(order);
    const resp = await clobClient.postOrder(order, OrderType.FOK, false)
    console.log(resp);
}

main();