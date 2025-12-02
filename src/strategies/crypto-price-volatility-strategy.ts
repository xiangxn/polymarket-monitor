import { ConfigType, getConfig } from "../config"
import { EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START, EVENT_KEY_UPDATE_PRICE, eventBus } from "../event-bus"
import { MarketMonitor } from "../market-monitor"
import { getMarketStartTime, getSearchTimeUnit, getSymbol, getTimeUnit } from "../polymarket"
import { addPosition, getCash, hasPosition, onPriceUpdate, subPosition } from "../position"
import { CryptoPriceSymbol, PolymarketMarket } from "../types"
import { computeVolatilityEWMA, probEndAboveOpen } from "../utils/math"

type PricePoint = { ts: number /* seconds */, price: number }
type CalcResult = { probUp: number; sigma: number }

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
    /**
     * 进入时概率
     * tokenId -> prob
     */
    private entryProbMap: Map<string, number> = new Map();

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
                    // 删除对应的tokenId的entryProbMap
                    markets[index].tokens.forEach(token => {
                        this.entryProbMap.delete(token.tokenId)
                    })
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
            // console.info(`${symbol} Price data is being prepared... [${prices.length}]`)
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
                market.upProb = result.probUp
                // 检查下单或者止盈/损
                this.checkSignal(market, result, secondsLeft)
            })
        }

    }

    private checkSweepEWMA(
        P_start: number,
        P_now: number,
        prices: number[],
        remainingT: number,
        lambda: number = 0.98
    ): CalcResult {
        const sigma = computeVolatilityEWMA(prices, lambda)
        const probUp = probEndAboveOpen(P_start, P_now, sigma, remainingT)
        return { probUp, sigma }
    }

    protected async checkSignal(market: PolymarketMarket, calcResult: CalcResult, secondsLeft: number) {
        // 更新Position, 检查止盈止损
        market.tokens.forEach((token, index) => {
            const position = onPriceUpdate(token.tokenId, token.bid.price)
            if (position) {
                if (position.entryPrice === 0) {    // 如果还没有收到订单数据，就暂时跳过
                    return
                }

                const prob = index === 0 ? calcResult.probUp : 1 - calcResult.probUp
                const price = token.bid.price
                const spread = token.ask.price - token.bid.price

                /********************止损********************/
                const entryProb = this.entryProbMap.get(token.tokenId) ?? 0
                // 买入理由消失
                if (prob < entryProb - 0.05) {
                    console.warn(`=== DECISION: STOP LOSS [Prob < entryProb] ==== ${token.outcome} ${token.tokenId} ${position.entryPrice} -> ${token.price}, ${token.bid.price}, prob:${entryProb}->${prob}`)
                    subPosition(token.tokenId, position.size)
                    return
                }
                // 剩余时间非常短
                if (secondsLeft < 20 && prob < 0.5) {
                    console.warn(`=== DECISION: STOP LOSS [Prob < 0.5 && secondsLeft < 20] ==== ${token.outcome} ${token.tokenId} ${position.entryPrice} -> ${token.price}, ${token.bid.price}, prob:${entryProb}->${prob}`)
                    subPosition(token.tokenId, position.size)
                    return
                }
                // 订单簿瞬间断层
                if (spread > 0.06 && price < position.entryPrice - 0.03) {
                    console.warn(`=== DECISION: STOP LOSS [spread < 0.06] ==== ${token.outcome} ${token.tokenId} ${position.entryPrice} -> ${token.price}, ${token.bid.price}, prob:${entryProb}->${prob}`)
                    subPosition(token.tokenId, position.size)
                    return
                }

                /********************止盈*******************/
                // 用概率止盈
                if (prob > 0.85) {
                    console.warn(`=== DECISION: TAKE PROFIT [Prob > 0.85] ==== ${token.outcome} ${token.tokenId} ${position.entryPrice} -> ${token.price}, ${token.bid.price}, prob:${entryProb}->${prob}`)
                    subPosition(token.tokenId, position.size)
                    return
                }
                // 用价格止盈
                if (token.bid.price > position.entryPrice * (1 + this.config.TAKE_PROFIT_PERCENTAGE) || token.bid.price >= this.config.TAKE_PROFIT_PRICE) {
                    console.warn(`=== DECISION: TAKE PROFIT [Price > entryPrice] ==== ${token.outcome} ${token.tokenId} ${position.entryPrice} -> ${token.price}, ${token.bid.price}, prob:${entryProb}->${prob}`)
                    subPosition(token.tokenId, position.size)
                    return
                }
            }
        })
        // 检查是否可以下单
        if (calcResult.probUp >= 0.8 || calcResult.probUp <= 0.2) {
            const tokenIndex = calcResult.probUp >= 0.8 ? 0 : 1
            const prob = tokenIndex === 0 ? calcResult.probUp : 1 - calcResult.probUp
            if (prob <= 0 || prob >= 1) return

            // 时间窗口内入场
            if (secondsLeft > this.config.ENTRY_WINDOW_HIGH || secondsLeft < this.config.ENTRY_WINDOW_LOW) return

            const token = market.tokens[tokenIndex]
            if (hasPosition(token.tokenId)) return

            // 订单金额限制
            let size = Math.min(token.ask.size * token.ask.price, this.config.MAX_ORDER_SIZE)
            size = Math.max(size, this.config.MIN_ORDER_SIZE)
            if (size < this.config.MIN_ORDER_SIZE) return    // size太小，不操作
            // 风控过滤
            const cash = getCash()
            if (cash - size < this.config.MIN_BALANCE) return

            if (token.ask.price < prob - 0.04) {
                this.entryProbMap.set(token.tokenId, prob)
                console.warn(`=== DECISION: BUY ==== ${token.outcome} ${token.tokenId} size: ${size} askPrice: ${token.ask.price}, Price: ${token.price}, Prob:${(prob * 100).toFixed(3)}%`)
                addPosition({
                    eventId: "0",
                    conditionId: market.conditionId,
                    marketId: market.id,
                    tokenId: token.tokenId,
                    outcome: token.outcome,
                    entryPrice: token.ask.price,
                    currentPrice: token.ask.price,
                    stopLoss: 0,
                    size: +(size / token.ask.price).toFixed(2),
                    realizedPnL: 0,
                    timestamp: Date.now()
                })
                return
            }
        }
    }
}