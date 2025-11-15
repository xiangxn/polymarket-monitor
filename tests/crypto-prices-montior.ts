import WebSocket from "ws";
import { erf } from "mathjs";
import { SocksProxyAgent } from "socks-proxy-agent";

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, `../${process.env.ENV_FILE || ''}.env`) });

import { initEncryptor } from "../src/config";
initEncryptor()

import { convertTokens, fetchCryptoPrice, fetchMarketByCId, getStartTime, getSymbolBySlug, getUnitBySeriesSlug } from "../src/polymarket";
import { PolymarketMarket } from "../src/types";

// ---------- 工具函数 ----------
function normalCDF(x: number): number {
    return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

interface ProbResult {
    predictedProb: number;
    upPrice: number;
    difference: number;
    signal: "overvalued" | "undervalued" | "fair";
    timestamp: number;
}

function calculateProbability(
    binancePrice: number,
    strikePrice: number,
    upPrice: number,
    volatility: number,
    timeMinutes: number
): ProbResult {
    const t = timeMinutes / 60; // 按小时
    const sigmaSqrtT = volatility * Math.sqrt(t);
    const d = Math.log(strikePrice / binancePrice) / sigmaSqrtT;

    const predictedProb = 1 - normalCDF(d);
    const difference = upPrice - predictedProb;

    let signal: "overvalued" | "undervalued" | "fair" = "fair";
    if (difference > 0.01) signal = "overvalued";
    else if (difference < -0.01) signal = "undervalued";

    return {
        predictedProb,
        upPrice,
        difference,
        signal,
        timestamp: Date.now(),
    };
}

// ---------- Binance WS ----------
class BinanceTracker {
    private prices: number[] = [];
    private windowSize: number;

    constructor(windowSize = 30) {
        this.windowSize = windowSize;
    }

    connect(symbol: string = "btcusdt", onPrice: (price: number) => void) {
        const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`;
        const ws = new WebSocket(wsUrl, { agent: new SocksProxyAgent("socks5h://127.0.0.1:1080") as any });

        ws.on("open", () => console.log("[Binance WS] Connected"));
        ws.on("message", (data) => {
            try {
                const msg = JSON.parse(data.toString());
                const price = parseFloat(msg.p); // 成交价格
                this.prices.push(price);
                if (this.prices.length > this.windowSize) this.prices.shift();
                onPrice(price);
            } catch (err) {
                console.error("Binance WS parse error", err);
            }
        });
        ws.on("close", () => console.log("[Binance WS] Closed"));
        ws.on("error", (err) => console.error("[Binance WS] Error", err));
    }

    getVolatility(): number {
        if (this.prices.length < 2) return 0.01; // 默认1%
        const logReturns = [];
        for (let i = 1; i < this.prices.length; i++) {
            logReturns.push(Math.log(this.prices[i] / this.prices[i - 1]));
        }
        const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
        const variance =
            logReturns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) /
            (logReturns.length - 1);
        return Math.sqrt(variance);
    }
}

// ---------- Polymarket WS ----------
interface PolymarketUpdate {
    upPrice: number;
    downPrice: number;
    strikePrice: number;
}

function startPolymarketWS(callback: (update: PolymarketUpdate) => void) {
    const wsUrl = "wss://ws-live-data.polymarket.com";
    const ws = new WebSocket(wsUrl, { agent: new SocksProxyAgent("socks5h://127.0.0.1:1080") as any });

    // const upToken = '55652889524970298398388309975461768504847309072207775924664302525102749066215'
    let pingInterval: NodeJS.Timeout | null = null

    ws.onopen = (event) => {
        console.log("[Polymarket WS] Connected")
        ws.send(JSON.stringify({
            action: "subscribe",
            subscriptions: [
                // {
                //     topic: "clob_market",
                //     type: "price_change",
                //     filters: `["${upToken}"]`
                // },
                {
                    topic: "clob_market",
                    type: "market_created"
                },
                {
                    topic: "clob_market",
                    type: "market_resolved"
                },
                // {
                //     topic: "crypto_prices",
                //     type: "update",
                //     filters: `{"symbol":"btcusdt"}`
                // }
            ]
        }))
        pingInterval = setInterval(() => {
            ws.ping(JSON.stringify({
                type: 'PING'
            }))
        }, 10000)
    };
    ws.onmessage = (event) => {
        if (event.data === "") return
        // console.log(event.data.toString())
        try {
            const msg = JSON.parse(event.data.toString());
            if (msg.type === "price_change") {
                const prices = getPrices(msg)
                const update: PolymarketUpdate = {
                    upPrice: prices.upPrice,
                    downPrice: prices.downPrice,
                    strikePrice: prices.strikePrice
                };
                callback(update);
            } else if (msg.type === "market_created") {
                console.log("market_created:", msg)
                onMarketCreated(msg, ws)
            } else if (msg.type === "market_resolved") {
                // console.log("market_resolved:", msg)
                onMarketResolved(msg, ws)
            }
        } catch (err) {
            console.error("Polymarket WS parse error", err);
        }
    };
    ws.onclose = (event) => console.log("[Polymarket WS] Closed");
    ws.onerror = (err) => console.error("Polymarket WS Error", err);
}

/**
 * 缓存所有市场信息，用于查询与后续计算
 */
const marketMap = new Map<string, PolymarketMarket>()
async function onMarketCreated(msg: any, ws: WebSocket) {
    const market = await fetchMarketByCId(msg.payload.market)
    if (!market) return

    console.log(`market: ${JSON.stringify(market)}`)

    // 检查市场类型与周期
    const objM = market as any
    const serie = objM.events[0].series[0]
    if (serie.seriesType !== 'single') return

    const timeUnit = getUnitBySeriesSlug(serie.slug)
    if (!timeUnit) return

    const symbol = getSymbolBySlug(serie.slug)
    if (!symbol) return

    const startTime = getStartTime(timeUnit, market.endDate)
    if (!startTime) return

    const cryptoPrice = await fetchCryptoPrice(symbol, startTime, new Date(market.endDate), timeUnit)
    if (!cryptoPrice) return

    market.openPrice = cryptoPrice

    marketMap.set(market.conditionId, market)
    ws.send(JSON.stringify({
        action: "subscribe",
        subscriptions: [
            {
                topic: "clob_market",
                type: "price_change",
                filters: `["${market.clobTokenIds[0]}"]`
            }
        ]
    }))
}

function onMarketResolved(msg: any, ws: WebSocket) {
    // TODO: 可以处理掉已结束的市场
    const market = marketMap.get(msg.payload.market)
    if (!market) return

    // 取消订阅
    ws.send(JSON.stringify({
        action: "unsubscribe",
        subscriptions: [
            {
                topic: "clob_market",
                type: "price_change",
                filters: `["${market.clobTokenIds[0]}"]`
            }
        ]
    }))
}

function getPrices(data: any) {
    const prices = { upPrice: 0, downPrice: 0, strikePrice: 0 }
    const market = marketMap.get(data.payload.m)
    if (market) {
        prices.strikePrice = market.openPrice
        data.payload.pc.forEach((pc: any) => {
            if (pc.a === market.clobTokenIds[0]) {
                prices.upPrice = parseFloat(pc.p)
            } else {
                prices.downPrice = parseFloat(pc.p)
            }
        })
    }
    return prices
}

// ---------- 主逻辑 ----------
function main() {
    const binanceTracker = new BinanceTracker(30);
    let latestBinancePrice: number | null = null;
    let latestPolymarket: PolymarketUpdate | null = null;
    const timeMinutes = 15;

    // Binance WS
    // binanceTracker.connect("btcusdt", (price) => {
    //     latestBinancePrice = price;
    //     tryCompute();
    // });

    // Polymarket WS
    startPolymarketWS((update) => {
        latestPolymarket = update;
        // tryCompute();
    });

    function tryCompute() {
        if (latestBinancePrice !== null && latestPolymarket !== null) {
            const startTime = Date.now();
            const volatility = binanceTracker.getVolatility();
            const result = calculateProbability(
                latestBinancePrice,
                latestPolymarket.strikePrice,
                latestPolymarket.upPrice,
                volatility,
                timeMinutes
            );
            const latency = Date.now() - startTime;

            console.log({
                binancePrice: latestBinancePrice,
                volatility,
                ...result,
                latency,
            });
        }
    }
}

main();