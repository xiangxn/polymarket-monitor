import { chunkArray, dirExists, sleep } from "./utils/helper";
import { CryptoPriceSymbol, CryptoPriceUint, PolymarketEvent, PolymarketMarket } from "./types";
import { ConfigType, getConfig } from './config';
import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from 'ws';
import { EventEmitter } from "events";
import { eventBus, EVENT_KEY_UPDATE_PRICE, EVENT_KEY_POLYMARKET_PRICE, EVENT_KEY_MARKET_CREATE, EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START } from "./event-bus";
import { fetchCryptoPrice, fetchMarketByCId, searchMarkets } from "./polymarket";
import path from "path";
import fs from "fs/promises"
import PQueue from 'p-queue';

const EVENT_KEY_BINANCE_PRICES = 'binance:prices'
const EVENT_KEY_CHAINLINK_PRICES = 'chainlink:prices'
const EVENT_KEY_POLYLIVE_PRICES = 'polylive:prices'
const EVENT_KEY_POLYLIVE_MARKET = 'polylive:market'


/**
 * 目前支持处理的市场tag/slug
 */
const TAG_SLUGS = ['crypto-prices', 'sports', 'politics']

export class MarketMonitor extends EventEmitter {
    private config: ConfigType
    private running = false;
    private pinging = false;
    private pingingClob = false;

    private binanceWS: WebSocket | null = null;
    private polyliveWS: WebSocket | null = null;
    private polyclobWS: WebSocket | null = null;
    private fetchPriceQueue = new PQueue({ concurrency: 1, interval: 3_000 })
    private lastClobMsgTime = 0
    private lastClobCheck = false
    private readonly POLY_LIVE_BASE = 'wss://ws-live-data.polymarket.com';
    private readonly POLY_MARKET_BASE = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
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
        },
        {
            topic: "crypto_prices_chainlink",
            type: "update",
            filters: `[{"symbol":"btc/usd"},{"symbol":"eth/usd"},{"symbol":"sol/usd"},{"symbol":"xrp/usd"}]`
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

        this.onChainLinkMessage = this.onChainLinkMessage.bind(this)
        this.on(EVENT_KEY_CHAINLINK_PRICES, this.onChainLinkMessage)

        this.onBinanceMessage = this.onBinanceMessage.bind(this)
        this.on(EVENT_KEY_BINANCE_PRICES, this.onBinanceMessage)

        this.onPolyClobMessage = this.onPolyClobMessage.bind(this)
        this.on(EVENT_KEY_POLYLIVE_PRICES, this.onPolyClobMessage)

        this.onPolyLiveMessage = this.onPolyLiveMessage.bind(this)
        this.on(EVENT_KEY_POLYLIVE_MARKET, this.onPolyLiveMessage)
    }

    public getMarket(conditionId: string) {
        return this.marketMap.get(conditionId)
    }

    public async start() {
        if (this.running) return;
        this.running = true;
        console.info('MarketMonitor starting...');
        // this.createBNWS()
        // this.attachBNHandlers()

        this.createPolyWS()
        this.attachPolyHandlers()
        this.createPolyClobWS()
        this.attachPolyClobHandlers()
    }


    public async stop() {
        await this.saveMarketMap()
        // 发出停止信号，runLoop 会结束
        this.running = false;
        this.pinging = false;
        this.off(EVENT_KEY_BINANCE_PRICES, this.onBinanceMessage)
        this.off(EVENT_KEY_CHAINLINK_PRICES, this.onChainLinkMessage)
        this.off(EVENT_KEY_POLYLIVE_PRICES, this.onPolyClobMessage)
        this.off(EVENT_KEY_POLYLIVE_MARKET, this.onPolyLiveMessage)
        // 等几个 tick 让 pending things 收尾
        await new Promise(res => setTimeout(res, 500));
        console.info('MarketMonitor stopped.');
    }



    public async pingLive() {
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

    public async pingClob() {
        if (this.pingingClob) return;
        this.pingingClob = true;
        while (this.running) {
            if (this.polyclobWS?.readyState === WebSocket.OPEN) {
                // this.polyclobWS?.send(JSON.stringify({
                //     type: 'PING'
                // }))
                this.polyclobWS?.send('PING')
            }
            await sleep(10)
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
            this.polyliveWS = new WebSocket(this.POLY_LIVE_BASE, { agent: new SocksProxyAgent(this.config.SOCKS_PROXY) as any });
        } else {
            this.polyliveWS = new WebSocket(this.POLY_LIVE_BASE);
        }
    }

    private createPolyClobWS() {
        if (this.config.SOCKS_PROXY) {
            this.polyclobWS = new WebSocket(this.POLY_MARKET_BASE, { agent: new SocksProxyAgent(this.config.SOCKS_PROXY) as any });
        } else {
            this.polyclobWS = new WebSocket(this.POLY_MARKET_BASE);
        }
    }

    private attachBNHandlers() {
        if (!this.binanceWS) return

        this.binanceWS.onopen = () => { console.debug("Binance WS connected:", this.BINANCE_WS_BASE); }
        this.binanceWS.onmessage = (raw) => { this.emit(EVENT_KEY_BINANCE_PRICES, raw.data.toString()) }
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

    private attachPolyHandlers() {
        if (!this.polyliveWS) return

        this.polyliveWS.onopen = async () => {
            console.debug(`PolyLive WS connected: ${this.POLY_LIVE_BASE}`);
            this.polyliveWS?.send(JSON.stringify({
                "action": "subscribe",
                "subscriptions": this.subscriptions
            }))
            setTimeout(() => this.pingLive(), 1000);
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
                    this.attachPolyHandlers();
                }
            }, backoffMs);
        };

        this.polyliveWS.onerror = (err) => { console.error(`PolyLive WS error: ${JSON.stringify(err.message)}`) };

        this.polyliveWS.onmessage = (raw) => {
            if (raw.data === 'PONG' || raw.data === '') return
            try {
                const data = JSON.parse(raw.data.toString())
                if (data.topic == 'crypto_prices_chainlink') {
                    this.emit(EVENT_KEY_CHAINLINK_PRICES, data)
                } else {
                    this.emit(EVENT_KEY_POLYLIVE_MARKET, data)
                }
            } catch (err) {
                console.warn('polyliveWS error', err);
            }
        }
    }

    private attachPolyClobHandlers(isReconnect = false) {
        if (!this.polyclobWS) return

        this.polyclobWS.onopen = async () => {
            console.debug("PolyClob WS connected:", this.POLY_MARKET_BASE);
            // 如果marketMap有数据，则续订所有market
            if (isReconnect) {
                this.subscribeMarket()
            } else {
                await this.initMarketMap() // 初始化本地存储的marketMap
                this.searchMarkets() // 开始搜索市场
                // this.checkClobMessage()
            }
            this.lastClobMsgTime = Date.now()
            // setTimeout(() => this.pingClob(), 10_000);
        }

        this.polyclobWS.onclose = (ev) => {
            console.debug(`PolyClob WS closed (code=${ev.code})`);
            // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
            if (this.running === false) {
                console.info('PolyClobMonitor stopped.');
                return;
            }

            let backoffMs = this.reconnectBaseMs;
            // 否则我们需要重连（带退避）
            console.debug(`PolyClob WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
            this.pingingClob = false
            setTimeout(() => {
                backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                if (this.running) {
                    this.createPolyClobWS();
                    this.attachPolyClobHandlers(true);
                }
            }, backoffMs);
        };

        this.polyclobWS.onerror = (err) => {
            // console.error(`PolyClob WS error: ${JSON.stringify(err.message)}`)
        };

        this.polyclobWS.onmessage = (raw) => {
            if (raw.data === 'PONG' || raw.data === '') return
            this.lastClobMsgTime = Date.now()
            this.emit(EVENT_KEY_POLYLIVE_PRICES, raw.data.toString())
        }
    }

    /**
     * 订阅市场价格变化
     * @param conditionId 
     */
    public subscribeMarket(m?: PolymarketMarket | string) {
        if (!m) {
            this.clearSubsTokens()
            const msg = { type: 'MARKET', assets_ids: Array.from(this.subsTokens) }
            if (this.polyclobWS && this.polyclobWS.readyState === WebSocket.OPEN && this.subsTokens.size > 0) {
                this.polyclobWS.send(JSON.stringify(msg), (err?: Error) => {
                    if (err) {
                        console.error(`Subscribe market error: ${err.message}`)
                    }
                })
                console.debug(`Subscribed to market: ${JSON.stringify(msg)}`)
            }
            console.info(`monitor market count: ${this.marketMap.size}`)
        } else if (typeof m === 'string') {
            let market = this.marketMap.get(m)
            if (market) {
                market.clobTokenIds.forEach(tokenId => {
                    this.subsTokens.add(tokenId)
                })

                if (this.polyclobWS) {
                    this.polyclobWS.close()
                }
            }
        } else {
            if (this.marketMap.has(m.conditionId) === false) {
                this.marketMap.set(m.conditionId, m)
            }
            m.clobTokenIds.forEach(tokenId => {
                this.subsTokens.add(tokenId)
            })

            if (this.polyclobWS) {
                this.polyclobWS.close()
            }
        }
    }

    /**
     * 取消市场价格的订阅
     * @param conditionId 
     */
    public unSubscribeMarket(conditionId: string) {
        const market = this.marketMap.get(conditionId)
        if (market && this.polyclobWS && this.polyclobWS.readyState === WebSocket.OPEN) {
            // api不提供取消订阅
        }
    }

    private onChainLinkMessage(data: any) {
        /**
        {
            "connection_id": "UgFFReb0rPECGmg=",
            "payload": {
                "full_accuracy_value": "2830920258000000000000",
                "symbol": "eth/usd",
                "timestamp": 1763908539000,
                "value": 2830.920258
            },
            "timestamp": 1763908540007,
            "topic": "crypto_prices_chainlink",
            "type": "update"
        }
        */
        if (data.type !== 'update') return

        const { payload } = data
        eventBus.emit(EVENT_KEY_UPDATE_PRICE, {
            symbol: payload.symbol.split('/')[0].toUpperCase(), price: Number(payload.value), volume: 0, time: Number(payload.timestamp)
        })
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
            eventBus.emit(EVENT_KEY_UPDATE_PRICE, {
                symbol: msg.data.s.replace("USDT", ''), price: Number(msg.data.p), volume: Number(msg.data.q), time: Number(msg.data.T)
            })
        } catch (err) {
            console.warn('onBinanceMessage error', err);
        }
    }

    private async onPolyClobMessage(data: string) {
        try {
            const update = JSON.parse(data);
            const { event_type } = update;
            if (event_type === 'book') {
                const market = this.marketMap.get(update.market)
                if (!market) return

                const token = market.tokens.find((t: any) => t.tokenId === update.asset_id);
                if (!token) return;

                const bidIndex = update.bids.length - 1;
                const askIndex = update.asks.length - 1;
                token.bid = update.bids.length > 0 ? { price: parseFloat(update.bids[bidIndex].price), size: parseFloat(update.bids[bidIndex].size) } : { price: 0, size: 0 };
                token.ask = update.asks.length > 0 ? { price: parseFloat(update.asks[askIndex].price), size: parseFloat(update.asks[askIndex].size) } : { price: 0, size: 0 };

                eventBus.emit(EVENT_KEY_POLYMARKET_PRICE, { market, token })
            } else if (event_type === 'last_trade_price') {
                const market = this.marketMap.get(update.market)
                if (!market) return

                const token = market.tokens.find((t: any) => t.tokenId === update.asset_id);
                if (!token) return;

                const trade = update as any;
                const event = (market as any).events[0]
                const vol = parseFloat(trade.size) * parseFloat(trade.price);
                event.volume = (event.volume || 0) + vol;
                event.tradeCount = (event.tradeCount || 0) + 1;

                token.price = parseFloat(update.price);
                if (update.side.toUpperCase() === 'BUY') {
                    token.lastBuy.push({ time: Date.now(), price: parseFloat(update.price), size: parseFloat(update.size) });
                    token.lastBuy = token.lastBuy.filter(t => t.time > Date.now() - this.config.KEEP_LAST_TRADE_TIME * 1000)
                } else {
                    token.lastSell.push({ time: Date.now(), price: parseFloat(update.price), size: parseFloat(update.size) });
                    token.lastSell = token.lastSell.filter(t => t.time > Date.now() - this.config.KEEP_LAST_TRADE_TIME * 1000)
                }
            }
        } catch (err) {
            console.warn('onPolyClobMessage error', err);
        }
    }

    private async onPolyLiveMessage(msg: any) {
        if (msg.topic !== 'clob_market') return

        if (msg.type === 'market_created') {
            // await this.onMarketCreated(msg.payload.market)
        } else if (msg.type === 'market_resolved') {
            await this.onMarketResolved(msg)
        }

    }

    async onMarketCreated(conditionId: string) {
        const market = await fetchMarketByCId(conditionId)
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

    /**
     * 主要用于清理订阅的token, redeem不依靠这个, 这个可能不稳定有漏领取的风险
     * @param msg 
     * @returns 
     */
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
        console.info(`monitor market count: ${this.marketMap.size}`)
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
                    const markets = await Promise.all(chunk.map(c => fetchMarketByCId(c)))
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

    /**
     * 清理已经结束的市场token监听
     */
    private clearSubsTokens() {
        // 及时清理订阅
        this.marketMap.forEach((m, _) => {
            if (new Date(m.endDate).getTime() <= Date.now()) {
                m.clobTokenIds.forEach(tokenId => {
                    this.subsTokens.delete(tokenId)
                })
            }
        })
        // 延迟清理市场(结束15分钟的就无条件清理)
        const mIds = Array.from(this.marketMap.values()).filter(m => new Date(m.endDate).getTime() + 15 * 60 * 1000 <= Date.now()).map(m => m.conditionId)
        mIds.forEach(mId => {
            this.marketMap.delete(mId)
        })
    }

    /**
     * 暂时停用, 已经改为在订阅时重新连接ws
     * @returns 
     */
    private async checkClobMessage() {
        if (this.lastClobCheck) return
        this.lastClobCheck = true
        while (this.running) {
            if (Date.now() - this.lastClobMsgTime > 1000 * 30) {
                this.polyclobWS?.close()
            }
            await sleep(20)
        }
    }

    private async searchMarkets() {
        while (this.running) {
            // 获取新的市场数据
            const endDateMin = new Date()
            endDateMin.setMinutes(endDateMin.getMinutes() + this.config.SEARCH_START_TIME)  // 最早7分钟后结束
            endDateMin.setSeconds(0)
            endDateMin.setMilliseconds(0)
            const endDateMax = new Date()
            endDateMax.setMinutes(endDateMax.getMinutes() + this.config.SEARCH_END_TIME)    // 最晚1周后结束
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

    public getCryptoPrice(symbol: CryptoPriceSymbol, startTime: Date, endTime: Date, unit: CryptoPriceUint, retries: number = 20) {
        return this.fetchPriceQueue.add(() => {
            return fetchCryptoPrice(symbol, startTime, endTime, unit, retries)
        })
    }

    public getEvents() {
        const events: PolymarketEvent[] = []
        this.marketMap.forEach(m => {
            const mk = m as any
            if (mk.events && mk.events.length > 0) {
                events.push(mk.events[0])
            }
        })
        return events
    }
}