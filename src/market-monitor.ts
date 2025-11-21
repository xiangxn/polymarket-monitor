import { chunkArray, dirExists, sleep } from "./helper";
import { PolymarketMarket } from "./types";
import { ConfigType, getConfig } from './config';
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from 'ws';
import { EventEmitter } from "events";
import { eventBus, EVENT_KEY_BN_PRICE, EVENT_KEY_POLYMARKET_PRICE, EVENT_KEY_MARKET_CREATE, EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START } from "./event-bus";
import { fetchMarketByCId, searchMarkets } from "./polymarket";
import path from "path";
import fs from "fs/promises"

const EVENT_KEY_BINANCE_PRICES = 'binance:prices'
const EVENT_KEY_POLYLIVE_PRICES = 'polylive:prices'


/**
 * 目前支持处理的市场tag/slug
 */
const TAG_SLUGS = ['crypto-prices', 'sports', 'politics']

export class MarketMonitor extends EventEmitter {
    private config: ConfigType
    private running = false;
    private pinging = false;

    private binanceWS: WebSocket | null = null;
    private polyliveWS: WebSocket | null = null;
    private lastMsgTime = 0;
    private readonly POLYLIVE_WS_BASE = 'wss://ws-live-data.polymarket.com';
    private readonly BINANCE_WS_BASE = "wss://stream.binance.com:9443";
    private readonly marketMapFilePath = `${process.cwd()}/data`
    private readonly marketMapFile;
    // 控制重试/退避
    private reconnectBaseMs = 1000;
    private reconnectMaxMs = 30_000;

    /**
     * 监听Polymarket市场的创建与决议
     */
    private readonly subscriptions = [
        {
            topic: "clob_market",
            type: "market_created",
        },
        {
            topic: "clob_market",
            type: "market_resolved"
        }
    ]

    /**
     * 监听的token
     */
    private subsTokens: Set<string> = new Set()

    private marketMap: Map<string, PolymarketMarket> = new Map()

    constructor() {
        super();
        this.config = getConfig();
        this.marketMapFile = path.join(this.marketMapFilePath, 'markets.json')
        this.onBinanceMessage = this.onBinanceMessage.bind(this)
        this.on(EVENT_KEY_BINANCE_PRICES, this.onBinanceMessage)
        this.onPolyLiveMessage = this.onPolyLiveMessage.bind(this)
        this.on(EVENT_KEY_POLYLIVE_PRICES, this.onPolyLiveMessage)
    }

    public getMarket(conditionId: string) {
        return this.marketMap.get(conditionId)
    }

    public async start() {
        if (this.running) return;
        this.running = true;
        console.info('MarketMonitor starting...');
        this.createBNWS()
        this.attachBNHandlers()
        this.createPolyWS()
        this.attachPolyHandlers()
    }


    public async stop() {
        await this.saveMarketMap()
        // 发出停止信号，runLoop 会结束
        this.running = false;
        this.pinging = false;
        this.off(EVENT_KEY_BINANCE_PRICES, this.onBinanceMessage)
        this.off(EVENT_KEY_POLYLIVE_PRICES, this.onPolyLiveMessage)
        // 等几个 tick 让 pending things 收尾
        await new Promise(res => setTimeout(res, 500));
    }



    public async ping() {
        if (this.pinging) return;
        this.pinging = true;
        while (this.running) {
            if (this.polyliveWS?.readyState === WebSocket.OPEN) {
                this.polyliveWS?.send(JSON.stringify({
                    type: 'PING'
                }))
            }
            await sleep(5)
        }
    }

    private createBNWS() {
        if (this.config.SOCKS_PROXY) {
            const bnUrl = `${this.BINANCE_WS_BASE}/stream?streams=btcusdt@trade/ethusdt@trade/solusdt@trade/xrpusdt@trade`
            this.binanceWS = new WebSocket(bnUrl, { agent: new SocksProxyAgent(this.config.SOCKS_PROXY) as any });
        } else {
            this.binanceWS = new WebSocket(this.BINANCE_WS_BASE);
        }
    }

    private createPolyWS() {
        if (this.config.SOCKS_PROXY) {
            this.polyliveWS = new WebSocket(this.POLYLIVE_WS_BASE, { agent: new SocksProxyAgent(this.config.SOCKS_PROXY) as any });
        } else {
            this.polyliveWS = new WebSocket(this.POLYLIVE_WS_BASE);
        }
    }

    private attachBNHandlers() {
        if (!this.binanceWS) return

        this.binanceWS.onopen = () => { console.debug("Binance WS connected:", this.BINANCE_WS_BASE); }
        this.binanceWS.onmessage = (raw) => { this.emit('binance:prices', raw.data.toString()) }
        this.binanceWS.onerror = (err) => { console.error(`Binance WS error: ${JSON.stringify(err.message)}`); }
        this.binanceWS.onclose = (info) => {
            console.debug(`Binance WS closed (code=${info.code})`);
            // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
            if (this.running === false) {
                console.info('PriceMonitor stopped.');
                return;
            }

            let backoffMs = this.reconnectBaseMs;
            // 否则我们需要重连（带退避）
            console.debug(`Binance WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
            this.pinging = false
            setTimeout(() => {
                backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                if (this.running) {
                    this.createBNWS()
                    this.attachBNHandlers()
                }
            }, backoffMs);
        }
    }

    private attachPolyHandlers(isReconnect = false) {
        if (!this.polyliveWS) return

        this.polyliveWS.onopen = async () => {
            console.debug(`PolyLive WS connected: ${this.POLYLIVE_WS_BASE}`);
            this.polyliveWS?.send(JSON.stringify({
                "action": "subscribe",
                "subscriptions": this.subscriptions
            }))
            // 如果marketMap有数据，则续订所有market
            if (isReconnect && this.marketMap.size > 0) {
                this.marketMap.forEach((m, _) => {
                    m.clobTokenIds.forEach(tokenId => {
                        this.subsTokens.add(tokenId)
                    })
                })
                this.subscribeMarket()
            }
            setTimeout(() => this.ping(), 1000);
            if (!isReconnect) {
                await this.initMarketMap() // 初始化本地存储的marketMap
                await this.searchMarkets() // 开始搜索市场
            }

        };

        this.polyliveWS.onclose = (ev) => {
            console.debug(`PolyLive WS closed (code=${ev.code})`);
            // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
            if (this.running === false) {
                console.info('PolyLiveMonitor stopped.');
                return;
            }

            let backoffMs = this.reconnectBaseMs;
            // 否则我们需要重连（带退避）
            console.debug(`PolyLive WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
            this.pinging = false
            setTimeout(() => {
                backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                if (this.running) {
                    this.createPolyWS();
                    this.attachPolyHandlers(true);
                }
            }, backoffMs);
        };

        this.polyliveWS.onerror = (err) => { console.error(`PolyLive WS error: ${JSON.stringify(err.message)}`) };

        this.polyliveWS.onmessage = (raw) => {
            if (raw.data === 'PONG' || raw.data === '') return
            this.lastMsgTime = Date.now()
            this.emit(EVENT_KEY_POLYLIVE_PRICES, raw.data.toString())
        }
    }

    /**
     * 订阅市场价格变化
     * @param conditionId 
     */
    public subscribeMarket(m?: PolymarketMarket | string) {
        let market: PolymarketMarket | undefined
        if (!m) {

        } else if (typeof m === 'string') {
            market = this.marketMap.get(m)
            if (market) {
                market.clobTokenIds.forEach(tokenId => {
                    this.subsTokens.add(tokenId)
                })
            } else {
                return
            }
        } else {
            if (this.marketMap.has(m.conditionId) === false) {
                this.marketMap.set(m.conditionId, m)
            }
            m.clobTokenIds.forEach(tokenId => {
                this.subsTokens.add(tokenId)
            })
            market = m
        }

        this.clearSubsTokens()

        let filters = JSON.stringify(Array.from(this.subsTokens))
        const msg = {
            action: "subscribe",
            subscriptions: [
                {
                    topic: "clob_market",
                    type: "price_change",
                    filters
                },
                {
                    topic: "clob_market",
                    type: "agg_orderbook",
                    filters
                },
                {
                    topic: "clob_market",
                    type: "last_trade_price",
                    filters
                }
            ]
        }
        this.polyliveWS?.send(JSON.stringify(msg), (err?: Error) => {
            if (err) {
                console.error(`Subscribe market error: ${err.message}`)
            }
        })
        console.debug(`Subscribed to market: ${JSON.stringify(msg)}`)
    }

    /**
     * 取消市场价格的订阅
     * @param conditionId 
     */
    public unSubscribeMarket(conditionId: string) {
        const market = this.marketMap.get(conditionId)
        if (market && this.polyliveWS && this.polyliveWS.readyState === WebSocket.OPEN) {
            this.polyliveWS.send(JSON.stringify({
                action: "unsubscribe",
                subscriptions: [
                    {
                        topic: "clob_market",
                        type: "price_change",
                        filters: JSON.stringify(market.clobTokenIds)
                    },
                    {
                        topic: "clob_market",
                        type: "agg_orderbook",
                        filters: JSON.stringify(market.clobTokenIds)
                    },
                    {
                        topic: "clob_market",
                        type: "last_trade_price",
                        filters: JSON.stringify(market.clobTokenIds)
                    }
                ]
            }), (err?: Error) => {
                if (err) {
                    console.error(`Unsubscribe market error: ${err.message}`)
                }
            })
        }
    }

    private onBinanceMessage(data: string) {
        /**
         * {
                "stream": "btcusdt@trade",
                "data": {
                    "e": "trade",
                    "E": 1763299122001,
                    "s": "BTCUSDT",
                    "t": 5500212729,
                    "p": "95789.67000000",
                    "q": "0.00013000",
                    "T": 1763299122001,
                    "m": false,
                    "M": true
                }
            }
         */
        try {
            const msg = JSON.parse(data);
            if (!msg.data?.p) return;
            eventBus.emit(EVENT_KEY_BN_PRICE, {
                symbol: msg.data.s.replace("USDT", ''), price: Number(msg.data.p), volume: Number(msg.data.q), time: Number(msg.data.T)
            })
        } catch (err) {
            console.warn('onBinanceMessage error', err);
        }
    }

    private async onPolyLiveMessage(data: string) {
        try {
            const msg = JSON.parse(data)
            if (msg.topic !== 'clob_market') return

            if (msg.type === 'market_created') {
                // await this.onMarketCreated(msg.payload.market)
            } else if (msg.type === 'market_resolved') {
                await this.onMarketResolved(msg)
            } else if (msg.type === 'agg_orderbook') {
                const market = this.marketMap.get(msg.payload.market)
                if (!market) return

                const token = market.tokens.find((t: any) => t.tokenId === msg.payload.asset_id);
                if (!token) return;

                const bidIndex = msg.payload.bids.length - 1;
                const askIndex = msg.payload.asks.length - 1;
                token.bid = msg.payload.bids.length > 0 ? { price: parseFloat(msg.payload.bids[bidIndex].price), size: parseFloat(msg.payload.bids[bidIndex].size) } : { price: 0, size: 0 };
                token.ask = msg.payload.asks.length > 0 ? { price: parseFloat(msg.payload.asks[askIndex].price), size: parseFloat(msg.payload.asks[askIndex].size) } : { price: 0, size: 0 };

                eventBus.emit(EVENT_KEY_POLYMARKET_PRICE, market)
            } else if (msg.type === 'price_change') {

            } else if (msg.type === 'last_trade_price') {
                // console.log('last_trade_price:', JSON.stringify(msg.payload))
                const market = this.marketMap.get(msg.payload.market)
                if (!market) return

                const token = market.tokens.find((t: any) => t.tokenId === msg.payload.asset_id);
                if (!token) return;

                token.price = parseFloat(msg.payload.price);
                if (msg.payload.side.toUpperCase() === 'BUY') {
                    token.lastBuy.push({ time: Date.now(), price: parseFloat(msg.payload.price), size: parseFloat(msg.payload.size) });
                    token.lastBuy = token.lastBuy.filter(t => t.time > Date.now() - this.config.KEEP_LAST_TRADE_TIME * 1000)
                } else {
                    token.lastSell.push({ time: Date.now(), price: parseFloat(msg.payload.price), size: parseFloat(msg.payload.size) });
                    token.lastSell = token.lastSell.filter(t => t.time > Date.now() - this.config.KEEP_LAST_TRADE_TIME * 1000)
                }
            }
        } catch (err) {
            console.warn('onPolyLiveMessage error', err);
        }
    }

    async onMarketCreated(conditionId: string) {
        const market = await this.getMarketByCId(conditionId)
        if (!market) return

        console.debug(`create market: ${JSON.stringify(market)}`)

        // 把市场分发给处理器, 根据slug分类
        TAG_SLUGS.forEach(slug => {
            const tag = market.tags.find(t => t.slug === slug)
            if (tag) {
                eventBus.emit(`${EVENT_KEY_MARKET_CREATE}:${slug}`, { market, monitor: this })
            }
        })
    }

    async onMarketResolved(msg: any) {
        console.debug(`resolved market: ${JSON.stringify(msg)}`)
        const market = this.marketMap.get(msg.payload.market)
        if (!market) return

        // 清理订阅的token
        market.clobTokenIds.forEach(t => {
            this.subsTokens.delete(t)
        })

        eventBus.emit(EVENT_KEY_MARKET_RESOLVED, { market, monitor: this })

        // 取消订阅
        this.unSubscribeMarket(market.conditionId)

        // 删除市场
        this.marketMap.delete(market.conditionId)
    }

    private async initMarketMap() {
        console.info("Initialize market data...")
        try {
            if (!(await dirExists(this.marketMapFilePath))) {
                await fs.mkdir(this.marketMapFilePath, { recursive: true });
                return
            }
            const content = await fs.readFile(this.marketMapFile, 'utf-8');
            const data = JSON.parse(content);
            if (Array.isArray(data)) {
                const chunks = chunkArray(data, 5)
                for (const chunk of chunks) {
                    const markets = await Promise.all(chunk.map(c => this.getMarketByCId(c)))
                    markets.forEach(m => {
                        if (m && m.closed === false && new Date(m.endDate).getTime() > Date.now()) {
                            TAG_SLUGS.forEach(slug => {
                                const tag = m.tags.find(t => t.slug === slug)
                                if (tag) {
                                    this.marketMap.set(m.conditionId, m)
                                    eventBus.emit(`${EVENT_KEY_MARKET_START}:${slug}`, { market: m, monitor: this })
                                }
                            })
                        }
                    })
                }
                console.info(`Initialize ${this.marketMap.size}/${data.length} market data.`)
            }
        } catch (err) {
            console.error(`Initialize market data error: ${err}`)
        }
    }

    private async saveMarketMap() {
        const cids = Array.from(this.marketMap.keys())
        await fs.writeFile(this.marketMapFile, JSON.stringify(cids))
    }

    private async getMarketByCId(conditionId: string) {
        const market = await fetchMarketByCId(conditionId)
        if (!market) return null
        return market
    }

    /**
     * 清理已经结束的市场token监听
     */
    private clearSubsTokens() {
        this.marketMap.forEach((m, _) => {
            if (new Date(m.endDate).getTime() <= Date.now()) {
                m.clobTokenIds.forEach(tokenId => {
                    this.subsTokens.delete(tokenId)
                })
            }
        })
    }

    private async searchMarkets() {
        while (this.running) {
            this.clearSubsTokens()
            if (Date.now() - this.lastMsgTime > 1000 * 60) {
                // this.subscribeMarket()
                this.polyliveWS?.close()
            }
            // 获取新的市场数据
            const endDateMin = new Date()
            endDateMin.setMinutes(endDateMin.getMinutes() + 7)  // 最早7分钟后结束
            endDateMin.setSeconds(0)
            endDateMin.setMilliseconds(0)
            const endDateMax = new Date(endDateMin.getTime())
            endDateMax.setDate(endDateMax.getDate() + 7)    // 最晚1周后结束
            const markets = await searchMarkets(endDateMin, endDateMax)
            if (markets) {
                markets.forEach(m => {
                    if (this.marketMap.has(m.conditionId)) return

                    if (m.closed === false && new Date(m.eventStartTime).getTime() <= Date.now() && new Date(m.endDate).getTime() > Date.now()) {
                        TAG_SLUGS.forEach(slug => {
                            const tag = m.tags?.find(t => t.slug === slug)
                            if (tag) {
                                eventBus.emit(`${EVENT_KEY_MARKET_START}:${slug}`, { market: m, monitor: this })
                            }
                        })
                    }
                })
            }
            await sleep(60) // 每分钟检查一次
        }
    }
}