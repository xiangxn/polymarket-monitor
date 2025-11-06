import { SocksProxyAgent } from "socks-proxy-agent";
import { fetchWithProxy, sleep } from "./helper";
import { PolymarketEvent, PostOrderResult, Token } from "./types";

import { getConfig } from './config';
import { SignatureType } from "@polymarket/order-utils";
import { ApiKeyCreds, Chain, ClobClient, OrderType, Side } from "@polymarket/clob-client";
import { OperationType, RelayClient, SafeTransaction } from "@polymarket/builder-relayer-client";
import { BuilderApiKeyCreds, BuilderConfig } from "@polymarket/builder-signing-sdk";
import { axiosInstance } from '@polymarket/clob-client/dist/http-helpers/index'
import { Interface } from "@ethersproject/abi";
import { ethers } from "ethers";
import { HashZero } from "@ethersproject/constants"

const config = getConfig()
type ConfigType = typeof config

export function convertTokens(market: any) {
    const tokens: Token[] = []
    if (typeof market.clobTokenIds === 'string') {
        market.clobTokenIds = JSON.parse(market.clobTokenIds)
    }
    if (typeof market.outcomes === 'string') {
        market.outcomes = JSON.parse(market.outcomes)
    }
    if (typeof market.outcomePrices === 'string') {
        market.outcomePrices = JSON.parse(market.outcomePrices)
    }
    for (let i = 0; i < market.clobTokenIds.length; i++) {
        const price = parseFloat(market.outcomePrices[i]?.toString() ?? "0")
        tokens.push({
            tokenId: market.clobTokenIds[i],
            outcome: market.outcomes[i],
            price: price,
            bid: {
                price: 0,
                size: 0
            },
            ask: {
                price: 0,
                size: 0
            },
            lastBuy: [],
            lastSell: []
        })
    }
    return tokens
}

export function calcTotalPrice(outcomePrices: string | string[]): number {
    if (typeof outcomePrices === 'string') {
        outcomePrices = JSON.parse(outcomePrices)
    }
    return (outcomePrices as string[]).reduce((a: any, b: any) => parseFloat(a) + parseFloat(b), 0)
}

export async function fetchTokensBook(tokens: string[]) {
    if (!Array.isArray(tokens) || tokens.length === 0) return []

    try {
        const url = `${config.CLOB_API_URL}/books`
        const response = await fetchWithProxy(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(tokens.map(t => ({ token_id: t })))
        }, config.HTTPS_PROXY);
        if (!response.ok) throw new Error(`CLOB API failed: ${response.status}`);
        const data = await response.json() as any[];
        return data
    } catch (e) {
        console.error("fetchTokensBook error:", e)
        return []
    }
}

export async function searchPositions(proxyWallet: string) {
    if (ethers.utils.isAddress(proxyWallet)) {
        try {
            const url = `https://data-api.polymarket.com/positions?redeemable=true&limit=100&sortBy=TOKENS&sortDirection=DESC&user=${proxyWallet}`
            const response = await fetchWithProxy(url, {}, config.HTTPS_PROXY);
            if (!response.ok) throw new Error(`Data API failed: ${response.status}`);
            const data = await response.json() as any[];
            return data
        } catch (e) {
            console.error("searchPositions error:", e)
        }
    }
    return []
}

export async function fetchUpcomingEvents(startHours: number = 0, endHours: number = 24, maxCount: number = 10000): Promise<PolymarketEvent[]> {
    const now = new Date();
    const nowIso = (new Date(now.getTime() + startHours * 60 * 60 * 1000)).toISOString();
    const endDateMax = new Date(now.getTime() + endHours * 60 * 60 * 1000);
    const endDateMaxIso = endDateMax.toISOString();
    const limit: number = 500;
    let offset: number = 0;
    let allEvents: PolymarketEvent[] = [];
    const retryDelay = 20;

    while (true) {
        const url = `https://gamma-api.polymarket.com/events?end_date_min=${nowIso}&end_date_max=${endDateMaxIso}&closed=false&offset=${offset}&limit=${limit}&order=endDate&ascending=true`;

        try {
            const response = await fetchWithProxy(url, {}, config.HTTPS_PROXY);
            if (!response.ok) throw new Error(`Gamma API failed: ${response.status}`);
            const data = await response.json() as PolymarketEvent[];
            // console.log(data.length)
            if (data.length === 0) break;

            // 过滤掉小于最小交易量的事件
            const parsedEvents = data.filter(e => (e.volume || 0) >= config.MIN_VOLUME);
            parsedEvents.forEach(e => {
                // 初始化数据
                e.tradeCount = 0

                e.markets = e.markets.filter(m => m.closed === false && m.active === true);
                e.markets.forEach(m => {
                    m.clobTokenIds = (typeof m.clobTokenIds === 'string') ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
                    m.outcomes = (typeof m.outcomes === 'string') ? JSON.parse(m.outcomes) : m.outcomes;
                    m.outcomePrices = (typeof m.outcomePrices === 'string') ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                    m.tokens = convertTokens(m);
                    m.totalPrice = calcTotalPrice(m.outcomePrices);
                });
            });

            const validEvents = Object.values(parsedEvents).filter(e => e.negRisk === true || (e.negRisk === false && e.markets.length < 6));
            // 处理初始book
            const books = await fetchTokensBook(validEvents.flatMap(e => e.markets.flatMap(m => m.tokens.map(t => t.tokenId))))
            books.forEach(b => {
                validEvents.forEach(e => {
                    const market = e.markets.find(m => m.conditionId === b.market)
                    if (market) {
                        const token = market.tokens.find(t => t.tokenId === b.asset_id)
                        if (token) {
                            token.bid = { ...b.bids[b.bids.length - 1] }
                            token.ask = { ...b.asks[b.asks.length - 1] }
                        }
                    }
                })
            })
            allEvents = [...allEvents, ...validEvents];

            if (data.length < limit || allEvents.length >= maxCount) break;
            offset += limit;
            await sleep(0.5)
        } catch (error) {
            console.error('Fetch error:', error, "\n", url);
            console.info(`${retryDelay} 秒后重试...`)
            await sleep(retryDelay);
        }
    }

    console.debug(`Fetched ${allEvents.length} events (<=${endHours}h end)`);
    return allEvents;
}



export class PolymarketClient {
    private config: ConfigType
    private client: ClobClient
    private relayer: RelayClient
    private provider: ethers.providers.JsonRpcProvider

    constructor() {
        this.config = getConfig()
        this.provider = new ethers.providers.JsonRpcProvider(this.config.CHAIN_RPC_URL);
        const wallet = new ethers.Wallet(this.config.OWNER_ADDRESS_PRI, this.provider);
        const chainId = this.config.CHAIN_ID as Chain;
        const creds: ApiKeyCreds = {
            key: this.config.CLOB_API_KEY,
            secret: this.config.CLOB_SECRET,
            passphrase: this.config.CLOB_PASS_PHRASE,
        };
        this.client = new ClobClient(
            this.config.CLOB_API_URL,
            chainId,
            wallet,
            creds,
            SignatureType.POLY_GNOSIS_SAFE,
            this.config.FUNDER_ADDRESS,
        );
        if (this.config.SOCKS_PROXY) {
            const agent = new SocksProxyAgent(this.config.SOCKS_PROXY);
            axiosInstance.defaults.proxy = false;
            axiosInstance.defaults.httpsAgent = agent;
            axiosInstance.defaults.httpAgent = agent;
        }

        const builderCreds: BuilderApiKeyCreds = {
            key: this.config.BUILDER_API_KEY,
            secret: this.config.BUILDER_SECRET,
            passphrase: this.config.BUILDER_PASS_PHRASE
        };

        const builderConfig = new BuilderConfig({
            localBuilderCreds: builderCreds
        });
        this.relayer = new RelayClient(this.config.POLYMARKET_RELAYER_URL, this.config.CHAIN_ID, wallet, builderConfig);
        if (this.config.SOCKS_PROXY) {
            const agent = new SocksProxyAgent(this.config.SOCKS_PROXY);
            this.relayer.httpClient.instance.defaults.proxy = false;
            this.relayer.httpClient.instance.defaults.httpsAgent = agent;
            this.relayer.httpClient.instance.defaults.httpAgent = agent;
        }
    }

    async placeOrder(tokenID: string, amount: number, side: Side, orderType: OrderType.FOK | OrderType.FAK = OrderType.FAK): Promise<PostOrderResult | null> {
        const marketBuyOrder = await this.client.createMarketOrder({
            tokenID,
            amount,
            side,
            orderType
        });
        console.debug(`placeOrder: ${JSON.stringify(marketBuyOrder)}`)
        const resp = await this.client.postOrder(marketBuyOrder, orderType)
        console.debug(`postOrder: ${JSON.stringify(resp)}`)
        if (resp.success) {
            if (resp.status === 'matched') {
                return { ...resp, takingAmount: parseFloat(resp.takingAmount || '0'), makingAmount: parseFloat(resp.makingAmount || '0') } as PostOrderResult
            }
        }
        return null
    }

    async cancelMarketOrders(conditionId: string, tokenId?: string) {
        let playload = { market: conditionId } as any

        if (tokenId) {
            playload.asset_id = tokenId
        }

        const resp = await this.client.cancelMarketOrders(playload)
        console.debug(`cancelMarketOrders: ${resp}`)
        return resp
    }

    async cancelOrders(orderIds: string[]) {
        if (!orderIds || orderIds.length === 0) return
        const resp = await this.client.cancelOrders(orderIds)
        console.debug(`cancelOrders: ${resp}`)
        return resp
    }

    async redeem(conditionId: string, negRisk: boolean, amounts?: string[]) {
        if (negRisk) {
            await redeemNegRisk(this.relayer, conditionId, amounts!)
        } else {
            await redeem(this.relayer, this.config.USDC_ADDRESS, conditionId)
        }
    }

    async getBalance(funder?: string): Promise<number> {
        if (!funder) {
            funder = this.config.FUNDER_ADDRESS
        }
        const ERC20_ABI = [
            "function balanceOf(address owner) view returns (uint256)",
            "function decimals() view returns (uint8)",
            "function symbol() view returns (string)"
        ];
        try {
            const token = new ethers.Contract(this.config.USDC_ADDRESS, ERC20_ABI, this.provider);
            const [decimals, symbol, rawBalance] = await Promise.all([
                token.decimals().catch(() => 18), // 若合约没有 decimals，回退 18（很少见）
                token.symbol().catch(() => ""),
                token.balanceOf(funder)
            ]);
            const balance = ethers.utils.formatUnits(rawBalance, decimals);
            console.debug(`${funder} balance: ${balance} ${symbol}`);
            return +parseFloat(balance).toFixed(2)
        } catch (err: any) {
            console.error(`getBalance error: ${err.message ? err.message : err}`)
            return 0
        }
    }
}

export const CTF_INTERFACE = new Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] indexSets)"
]);
export const NEG_RISK_INTERFACE = new Interface([
    "function redeemPositions(bytes32 _conditionId,uint256[] _amounts)"
])

export const encodeRedeem = (collateralToken: string, conditionId: string): string => {
    return CTF_INTERFACE.encodeFunctionData(
        "redeemPositions",
        [collateralToken, HashZero, conditionId, [1, 2]],
    );
}

export const encodeRedeemNegRisk = (conditionId: string, amounts: string[]): string => {
    return NEG_RISK_INTERFACE.encodeFunctionData(
        "redeemPositions",
        [conditionId, amounts],
    );
}

export async function redeem(client: RelayClient, collateralToken: string, conditionId: string) {
    const redeemTx: SafeTransaction = {
        to: config.CTF_ADDRESS,
        operation: OperationType.Call,
        data: encodeRedeem(collateralToken, conditionId),
        value: "0"
    };
    const response = await client.execute([redeemTx], "Redeem position");
    console.debug(`redeem response: ${JSON.stringify(response)}`)
    const result = await response.wait()
    console.debug(`redeem result: ${JSON.stringify(result)}`)
}

export async function redeemNegRisk(client: RelayClient, conditionId: string, amounts: string[]) {
    const redeemTx: SafeTransaction = {
        to: config.NEG_RISK_CTF_ADDRESS,
        operation: OperationType.Call,
        data: encodeRedeemNegRisk(conditionId, amounts),
        value: "0"
    };
    const response = await client.execute([redeemTx], "Redeem position");
    console.debug(`redeemNegRisk response: ${JSON.stringify(response)}`)
    const result = await response.wait()
    console.debug(`redeemNegRisk result: ${JSON.stringify(result)}`)
}