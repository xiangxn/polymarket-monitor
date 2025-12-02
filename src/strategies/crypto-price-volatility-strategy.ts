import { ConfigType, getConfig } from "../config"
import { EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START, EVENT_KEY_UPDATE_PRICE, eventBus } from "../event-bus"
import { MarketMonitor } from "../market-monitor"
import { getMarketStartTime, getSearchTimeUnit, getSymbol, getTimeUnit } from "../polymarket"
import { CryptoPriceSymbol, PolymarketMarket } from "../types"
import { computeVolatilityEWMA, probEndAboveOpen } from "../utils/math"

type PricePoint = { ts: number /* seconds */, price: number }

export class CryptoPriceVolatilityStrategy {
    private readonly eventType = 'crypto-prices'
    private readonly windowSeconds = 60 // 最近1分钟价格窗口
    /**
     * symbol -> price[]
     */
    private priceMap: Map<string, PricePoint[]> = new Map()
    /**
     * symbol -> lastPrice
     */
    private lastPriceMap: Map<string, PricePoint> = new Map()
    /**
     * 市场对应币种的开盘价
     * conditionId -> openPrice
     */
    private openPriceMap: Map<string, number> = new Map()
    /**
     * symbol -> market[]
     */
    private marketMap: Map<string, PolymarketMarket[]> = new Map()
    /**
     * conditionId -> symbol
     * 市场对应的加密货币symbol
     */
    private symbolMap: Map<string, CryptoPriceSymbol> = new Map()

    private config: ConfigType;
    private priceInterval: NodeJS.Timeout | null = null;

    constructor() {
        this.config = getConfig()
        this.onMarketStart = this.onMarketStart.bind(this)
        this.onMarketResolved = this.onMarketResolved.bind(this)
        this.onPriceUpdate = this.onPriceUpdate.bind(this)
    }

    protected async onMarketStart({ market, monitor }: { market: PolymarketMarket, monitor: MarketMonitor }) {
        // 获取市场对应的加密货币symbol
        const symbol = getSymbol(market.tags)
        if (!symbol) return

        const startTime = getMarketStartTime(market)
        if (!startTime) return

        const u = getTimeUnit(market.tags)
        if (!u) return

        const endTime = new Date(market.endDate)

        if (u === '15m') {   // 本策略只处理15分钟的市场
            const markets = this.marketMap.get(symbol)
            if (!markets) {
                this.marketMap.set(symbol, [market])
            } else {
                if (markets.find(m => m.conditionId === market.conditionId)) {
                    return
                }
                markets.push(market)
            }
            const unit = getSearchTimeUnit(u)
            console.debug('onMarketStart:', market.conditionId, symbol, unit, startTime.toISOString(), endTime.toISOString())
            this.symbolMap.set(market.conditionId, symbol)
            let openPrice: number | undefined | null = this.openPriceMap.get(market.conditionId)
            if (!openPrice) {
                openPrice = await monitor.getCryptoPrice(symbol, startTime, endTime, unit)
                console.info(`${symbol} openPrice:`, openPrice)
                if (openPrice)
                    this.openPriceMap.set(market.conditionId, openPrice)
            }
            monitor.subscribeMarket(market)
        }
    }

    public start() {
        console.info(`CryptoPriceVolatilityStrategy start...`)
        eventBus.on(`${EVENT_KEY_MARKET_START}:${this.eventType}`, this.onMarketStart)
        eventBus.on(EVENT_KEY_MARKET_RESOLVED, this.onMarketResolved)
        eventBus.on(EVENT_KEY_UPDATE_PRICE, this.onPriceUpdate)
        this.priceInterval = setInterval(() => {
            this.lastPriceMap.forEach((price, symbol) => {
                this.pushPrice(symbol, price)
                this.checkAndReport(symbol)
            })
        }, 1_000)
    }

    public stop() {
        if (this.priceInterval) {
            clearInterval(this.priceInterval)
            this.priceInterval = null
        }
        eventBus.off(`${EVENT_KEY_MARKET_START}:${this.eventType}`, this.onMarketStart)
        eventBus.off(EVENT_KEY_MARKET_RESOLVED, this.onMarketResolved)
        eventBus.off(EVENT_KEY_UPDATE_PRICE, this.onPriceUpdate)

        console.info(`CryptoPriceVolatilityStrategy stopped.`)
    }

    protected async onMarketResolved({ market, monitor }: { market: PolymarketMarket, monitor: MarketMonitor }) {
        console.debug('onMarketResolved:', market.conditionId)
        this.openPriceMap.delete(market.conditionId)
        const symbol = this.symbolMap.get(market.conditionId)
        if (symbol) {
            const markets = this.marketMap.get(symbol)
            if (markets) {
                const index = markets.findIndex(m => m.conditionId === market.conditionId)
                if (index !== -1) {
                    markets.splice(index, 1)
                }
            }
        }
        this.symbolMap.delete(market.conditionId)


        // TODO: 可以在这里触发redeem
    }

    protected onPriceUpdate({ symbol, price, volume, time }: { symbol: string, price: number, volume: number, time: number }) {
        const ts = Math.floor(time / 1000)
        this.lastPriceMap.set(symbol, { ts, price })
    }

    // 插入新价格（price，timestamp可选默认 now）
    private pushPrice(symbol: string, price: PricePoint) {
        let prices = this.priceMap.get(symbol)
        if (!prices) {
            this.priceMap.set(symbol, [price])
            prices = this.priceMap.get(symbol)
        } else {
            prices.push(price)
        }
        const cutoff = price.ts - this.windowSeconds
        prices = prices!.filter(p => p.ts >= cutoff)
    }

    private checkAndReport(symbol: string) {
        const now = Math.floor(Date.now() / 1000)
        const prices = this.priceMap.get(symbol)
        if (!prices) return

        if (prices.length === 0 || now - prices[0].ts < this.windowSeconds) {
            console.info(`${symbol} Price data is being prepared... [${prices.length}]`)
            return
        }

        const markets = this.marketMap.get(symbol)
        if (markets) {
            markets.forEach(market => {
                const secondsLeft = new Date(market.endDate).getTime() / 1000 - now
                if (secondsLeft <= 0) return

                const openPrice = this.openPriceMap.get(market.conditionId)
                if (!openPrice) return

                const currentPrice = prices[prices.length - 1].price
                const result = this.checkSweepEWMA(openPrice, currentPrice, prices.map(p => p.price), secondsLeft)
                console.debug(`
                    time (UTC secs)   : ${now}
                    openPrice         : ${openPrice}
                    currentPrice      : ${currentPrice}
                    secondsLeft       : ${secondsLeft}
                    sigma1m (1m std)  : ${result.sigma}
                    Probability       : ${(result.probUp * 100).toFixed(3)} %
                    signal            : ${result.shouldSweep} ${result.tokenIndex ? market.tokens[result.tokenIndex].outcome : 'NULL'}
                    `)
                // TODO: 检查下单或者止盈/损
            })
        }

    }

    private checkSweepEWMA(
        P_start: number,
        P_now: number,
        prices: number[],
        remainingT: number,
        p_limit: number = 0.03,
        lambda: number = 0.98
    ): { shouldSweep: boolean; tokenIndex: number | null; probUp: number; sigma: number } {
        const sigma = computeVolatilityEWMA(prices, lambda)
        const probUp = probEndAboveOpen(P_start, P_now, sigma, remainingT)

        let shouldSweep = false
        let tokenIndex: number | null = null

        if (probUp > 1 - p_limit) {
            shouldSweep = true
            tokenIndex = 0
        } else if (probUp < p_limit) {
            shouldSweep = true
            tokenIndex = 1
        }

        return { shouldSweep, tokenIndex, probUp, sigma }
    }
}