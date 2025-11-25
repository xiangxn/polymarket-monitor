import { CryptoPriceSymbol, PolymarketMarket, SlidingWindow, Token } from "../types"
import { eventBus, EVENT_KEY_POLYMARKET_PRICE, EVENT_KEY_UPDATE_PRICE, EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START } from '../event-bus';
import { MarketMonitor } from "../market-monitor";
import { getEventByMarket, getSearchTimeUnit, getStartTime, getSymbol, getTimeUnit } from "../polymarket";
import { secondsLeft } from "../utils/math";
import { ConfigType, getConfig } from "../config";
import { hasPosition, onPriceUpdate } from "../position";
import { enqueueOrder } from "../order-queue";

export class CryptoPriceStrategy {

    private readonly eventType = 'crypto-prices'
    /**
     * binance价格
     * symbol -> price
     */
    private priceMap: Map<string, number> = new Map()
    /**
     * 市场对应币种的开盘价
     * conditionId -> openPrice
     */
    private openPriceMap: Map<string, number> = new Map()
    /**
     * conditionId -> symbol
     * 市场对应的加密货币symbol
     */
    private symbolMap: Map<string, CryptoPriceSymbol> = new Map()
    /**
     * symbol -> SlidingWindow
     * 10s 滑动窗口
     */
    private win10Map: Map<string, SlidingWindow> = new Map()
    /**
     * symbol -> SlidingWindow
     * 30s 滑动窗口
     */
    private win30Map: Map<string, SlidingWindow> = new Map()

    private calcState = new Map<string, { scheduled: boolean }>();
    private config: ConfigType;

    constructor() {
        this.config = getConfig()
        this.onMarketStart = this.onMarketStart.bind(this)
        this.onMarketResolved = this.onMarketResolved.bind(this)
        this.onMarketPriceUpdate = this.onMarketPriceUpdate.bind(this)
        this.onPriceUpdate = this.onPriceUpdate.bind(this)

    }

    public start() {
        eventBus.on(`${EVENT_KEY_MARKET_START}:${this.eventType}`, this.onMarketStart)
        eventBus.on(EVENT_KEY_MARKET_RESOLVED, this.onMarketResolved)
        eventBus.on(EVENT_KEY_POLYMARKET_PRICE, this.onMarketPriceUpdate)
        eventBus.on(EVENT_KEY_UPDATE_PRICE, this.onPriceUpdate)
    }

    public stop() {
        eventBus.off(`${EVENT_KEY_MARKET_START}:${this.eventType}`, this.onMarketStart)
        eventBus.off(EVENT_KEY_MARKET_RESOLVED, this.onMarketResolved)
        eventBus.off(EVENT_KEY_POLYMARKET_PRICE, this.onMarketPriceUpdate)
        eventBus.off(EVENT_KEY_UPDATE_PRICE, this.onPriceUpdate)
    }

    protected onPriceUpdate({ symbol, price, volume, time }: { symbol: string, price: number, volume: number, time: number }) {
        let tokenW10 = this.win10Map.get(symbol)
        if (!tokenW10) {
            tokenW10 = new SlidingWindow(10_000)
            this.win10Map.set(symbol, tokenW10)
        }
        let tokenW30 = this.win30Map.get(symbol)
        if (!tokenW30) {
            tokenW30 = new SlidingWindow(30_000)
            this.win30Map.set(symbol, tokenW30)
        }
        this.priceMap.set(symbol, price)
        tokenW10.push({ ts: time, price: price });
        tokenW30.push({ ts: time, price: price });
    }

    protected async checkSignal(market: PolymarketMarket, token: Token) {
        const timeLeft = secondsLeft(market.endDate);
        const position = onPriceUpdate(token.tokenId, token.bid.price)
        if (position) {
            if (position.entryPrice === 0) {    // 如果还没有收到订单数据，就暂时跳过
                return
            }
            const index = market.tokens.findIndex(t => t.tokenId === token.tokenId)
            const symbol = this.symbolMap.get(market.conditionId)!
            const nowPrice = this.priceMap.get(symbol)!
            const openPrice = this.openPriceMap.get(market.conditionId)!
            const distancePCT = Math.abs(nowPrice - openPrice) / openPrice  // 价格距离百分比

            // ======================止盈检查======================
            if (token.bid.price > position.entryPrice * (1 + this.config.TAKE_PROFIT_PERCENTAGE) || token.bid.price >= this.config.TAKE_PROFIT_PRICE) {
                // 如果即将结束，则不止盈，减少滑点损失
                if (timeLeft <= this.config.TAKE_PROFIT_MIN_TIME && distancePCT >= this.config.TAKE_PROFIT_DISTANCE_PCT) return

                console.info(`=== DECISION: TAKE PROFIT [${token.outcome}] ${token.tokenId} ${position.entryPrice} -> ${token.bid.price}, ${token.bid.price}`)
                enqueueOrder({
                    type: 'sell',
                    conditionId: market.conditionId,
                    eventId: getEventByMarket(market)?.id ?? '0',
                    tokenId: token.tokenId,
                    amount: position.size,
                    price: token.bid.price,
                    marketId: market.id,
                    outcome: token.outcome
                })
                return
            }

            // ======================止损检查======================
            // 最高优先级, 硬止损
            const stopLossPCT = (token.price - position.entryPrice) / position.entryPrice
            if (stopLossPCT < this.config.STOP_LOSS_THRESHOLD) {
                console.info(`=== DECISION: STOP LOSS [${token.outcome}] ${token.tokenId} stopLossPCT:${stopLossPCT}, ${position.entryPrice} -> ${token.price}, ${token.bid.price}`)
                enqueueOrder({
                    type: 'sell',
                    conditionId: market.conditionId,
                    eventId: getEventByMarket(market)?.id ?? '0',
                    tokenId: token.tokenId,
                    amount: position.size,
                    price: token.bid.price,
                    marketId: market.id,
                    outcome: token.outcome
                })
                return
            }

            // 逻辑止损, yes/no价格已经翻转
            if (index === 0) { // UP
                if (nowPrice < openPrice) {
                    if (!position.stopLossTime) {
                        position.stopLossTime = Date.now()
                    }
                    if (Date.now() - position.stopLossTime >= this.config.STOP_LOSS_LOGIC_TIME_THRESHOLD) {
                        console.info(`=== DECISION: STOP LOSS [${token.outcome}] ${token.tokenId} stopLossTime:${Date.now() - position.stopLossTime} ${position.entryPrice} -> ${token.price}, ${token.bid.price}`)
                        enqueueOrder({
                            type: 'sell',
                            conditionId: market.conditionId,
                            eventId: getEventByMarket(market)?.id ?? '0',
                            tokenId: token.tokenId,
                            amount: position.size,
                            price: token.bid.price,
                            marketId: market.id,
                            outcome: token.outcome
                        })
                        return
                    }
                } else {
                    position.stopLossTime = undefined
                }
            } else { // DOWN
                if (nowPrice > openPrice) {
                    if (!position.stopLossTime) {
                        position.stopLossTime = Date.now()
                    }
                    if (Date.now() - position.stopLossTime >= this.config.STOP_LOSS_LOGIC_TIME_THRESHOLD) {
                        console.info(`=== DECISION: STOP LOSS [${token.outcome}] ${token.tokenId} stopLossTime:${Date.now() - position.stopLossTime} ${position.entryPrice} -> ${token.price}, ${token.bid.price}`)
                        enqueueOrder({
                            type: 'sell',
                            conditionId: market.conditionId,
                            eventId: getEventByMarket(market)?.id ?? '0',
                            tokenId: token.tokenId,
                            amount: position.size,
                            price: token.bid.price,
                            marketId: market.id,
                            outcome: token.outcome
                        })
                        return
                    }
                } else {
                    position.stopLossTime = undefined
                }
            }

            // 时间距离止损, 如果快结束了, 还低于开盘价, 就止损
            if (timeLeft < this.config.STOP_LOSS_TIME_LAST) {
                if (index === 0) { // UP
                    if (nowPrice < openPrice && distancePCT > this.config.STOP_LOSS_TIME_DISTANCE_PCT) {
                        console.info(`=== DECISION: STOP LOSS [${token.outcome}] ${token.tokenId} distancePCT:${distancePCT}, timeLeft:${timeLeft} ${position.entryPrice} -> ${token.price}, ${token.bid.price}`)
                        enqueueOrder({
                            type: 'sell',
                            conditionId: market.conditionId,
                            eventId: getEventByMarket(market)?.id ?? '0',
                            tokenId: token.tokenId,
                            amount: position.size,
                            price: token.bid.price,
                            marketId: market.id,
                            outcome: token.outcome
                        })
                        return
                    }
                } else {    // DOWN
                    if (nowPrice > openPrice && distancePCT > this.config.STOP_LOSS_TIME_DISTANCE_PCT) {
                        console.info(`=== DECISION: STOP LOSS [${token.outcome}] ${token.tokenId} distancePCT:${distancePCT}, timeLeft:${timeLeft} ${position.entryPrice} -> ${token.price}, ${token.bid.price}`)
                        enqueueOrder({
                            type: 'sell',
                            conditionId: market.conditionId,
                            eventId: getEventByMarket(market)?.id ?? '0',
                            tokenId: token.tokenId,
                            amount: position.size,
                            price: token.bid.price,
                            marketId: market.id,
                            outcome: token.outcome
                        })
                        return
                    }
                }
            }
        } else {
            await this.checkEnter(market, timeLeft)
        }
    }

    /**
     * 检查信号
     * @param market Polymarket市场对象
     * @returns 
     */
    protected async checkEnter(market: PolymarketMarket, timeLeft: number) {
        // console.log('timeLeft:', timeLeft)
        // 时间窗口内入场
        if (timeLeft > this.config.ENTRY_WINDOW_HIGH || timeLeft < this.config.ENTRY_WINDOW_LOW) return

        // compute PM YES/NO[UP/DOWN] price diff using bestSell/bestBuy as approximations
        const bestYesBid = market.tokens[0].bid.price
        const bestYesAsk = market.tokens[0].ask.price
        const bestNoBid = market.tokens[1].bid.price
        const bestNoAsk = market.tokens[1].ask.price

        const symbol = this.symbolMap.get(market.conditionId)
        if (!symbol) return

        const nowPrice = this.priceMap.get(symbol)
        if (!nowPrice) return

        const openPrice = this.openPriceMap.get(market.conditionId)
        if (!openPrice) return

        const win10 = this.win10Map.get(symbol)!
        const win30 = this.win30Map.get(symbol)!

        // 相对开盘偏离
        const p_open = openPrice
        const p_now = nowPrice
        const vol = Math.abs((p_now - p_open) / p_open);
        if (vol < this.config.MIN_PRICE_DELTA_THRESHOLD || vol > this.config.MAX_PRICE_DELTA_THRESHOLD) return

        // 10秒算术平均价格
        const avg10 = win10.avg();
        // 30秒算术平均价格
        const avg30 = win30.avg();
        if (!avg10 || !avg30) return;

        // 方向信号
        const trendScore = (avg10 - avg30) / avg30;

        // 对数收益标准差
        const volatility_10s = win10.std()
        const volatility_30s = win30.std()
        if (!volatility_10s || !volatility_30s) return;

        if (volatility_10s <= this.config.VOLATILITY_MARGIN * volatility_30s) return


        console.debug(`symbol: ${symbol}, openPrice: ${openPrice}, nowPrice: ${nowPrice}, bestYesAsk: ${bestYesAsk}, bestNoAsk: ${bestNoAsk}
            avg10: ${avg10}, avg30: ${avg30}, volatility_10s: ${volatility_10s}, volatility_30s: ${volatility_30s}
            trendScore: ${trendScore}, vol: ${vol}, bookDiff: ${bestYesBid - bestNoAsk}, ${bestNoBid - bestYesAsk}
            trendScore >= TREND_THRESHOLD[${this.config.TREND_THRESHOLD}]: ${trendScore >= this.config.TREND_THRESHOLD},${trendScore <= -this.config.TREND_THRESHOLD}
            (vol >= MIN_PRICE_DELTA_THRESHOLD[${this.config.MIN_PRICE_DELTA_THRESHOLD}] && vol <= MAX_PRICE_DELTA_THRESHOLD[${this.config.MAX_PRICE_DELTA_THRESHOLD}]): ${(vol >= this.config.MIN_PRICE_DELTA_THRESHOLD && vol <= this.config.MAX_PRICE_DELTA_THRESHOLD)}
            (p_now >= p_open && p_now >= avg10 && avg10 >= avg30): ${(p_now >= p_open && p_now >= avg10 && avg10 >= avg30)}, ${(p_now < p_open && p_now <= avg10 && avg10 <= avg30)}
            volatility_10s > VOLATILITY_MARGIN[${this.config.VOLATILITY_MARGIN}] * volatility_30s: ${volatility_10s > this.config.VOLATILITY_MARGIN * volatility_30s}`)

        // BUY UP condition
        if (trendScore >= this.config.TREND_THRESHOLD && (p_now >= p_open && p_now >= avg10 && avg10 >= avg30)) {
            // 持有仓位
            if (hasPosition(market.tokens[0].tokenId)) return
            // 入场限价
            if (!bestYesAsk || bestYesAsk > this.config.MAX_ENTRY_PRICE) return
            // 盘口差
            if (bestYesBid - bestNoAsk > this.config.MAX_BOOK_DIFF) return

            console.info("=== DECISION: BUY UP", JSON.stringify({ tokenId: market.tokens[0].tokenId, timeLeft, trendScore, p_now, p_open, vol, bestYesAsk, bestNoAsk, avg10, avg30, volatility_10s, volatility_30s }));
            // place order via Polymarket CLOB REST / relayer.
            enqueueOrder({
                type: 'buy',
                eventId: getEventByMarket(market)?.id ?? '0',
                conditionId: market.conditionId,
                marketId: market.id,
                tokenId: market.tokens[0].tokenId,
                amount: +market.tokens[0].ask.size.toFixed(4),
                price: market.tokens[0].ask.price,
                outcome: market.tokens[0].outcome
            })
        }

        // BUY DOWN condition
        if (trendScore <= -this.config.TREND_THRESHOLD && (p_now < p_open && p_now <= avg10 && avg10 <= avg30)) {
            // 持有仓位
            if (hasPosition(market.tokens[1].tokenId)) return
            // 入场限价
            if (!bestNoAsk || bestNoAsk > this.config.MAX_ENTRY_PRICE) return
            // 盘口差
            if (bestNoBid - bestYesAsk > this.config.MAX_BOOK_DIFF) return

            console.info("=== DECISION: BUY DOWN", JSON.stringify({ tokenId: market.tokens[1].tokenId, timeLeft, trendScore, p_now, p_open, vol, bestYesAsk, bestNoAsk, avg10, avg30, volatility_10s, volatility_30s }));
            // place order...
            enqueueOrder({
                type: 'buy',
                eventId: getEventByMarket(market)?.id ?? '0',
                conditionId: market.conditionId,
                marketId: market.id,
                tokenId: market.tokens[1].tokenId,
                amount: +market.tokens[1].ask.size.toFixed(4),
                price: market.tokens[1].ask.price,
                outcome: market.tokens[1].outcome
            })
        }
    }

    protected onMarketPriceUpdate({ market, token }: { market: PolymarketMarket, token: Token }) {
        const symbol = this.symbolMap.get(market.conditionId)
        if (!symbol) return

        const nowPrice = this.priceMap.get(symbol)
        if (!nowPrice) return

        const openPrice = this.openPriceMap.get(market.conditionId)
        if (!openPrice) return

        const win10 = this.win10Map.get(symbol)
        if (!win10) return

        const win30 = this.win30Map.get(symbol)
        if (!win30) return

        // 防抖处理
        let item = this.calcState.get(market.conditionId);
        if (!item) {
            item = { scheduled: false };
            this.calcState.set(market.conditionId, item);
        }
        if (item.scheduled) return;
        console.debug(`onUpdateMarket: ${market.conditionId} ${symbol} ${openPrice} -> ${nowPrice}`)
        item.scheduled = true;
        setTimeout(() => {
            item.scheduled = false;
            this.checkSignal(market, token)
        }, this.config.DATA_JITTER_DELAY);
    }

    protected async onMarketResolved({ market, monitor }: { market: PolymarketMarket, monitor: MarketMonitor }) {
        console.debug('onMarketResolved:', market.conditionId)
        this.openPriceMap.delete(market.conditionId)
        this.symbolMap.delete(market.conditionId)
        // TODO: 可以在这里触发redeem
    }

    protected async onMarketStart({ market, monitor }: { market: PolymarketMarket, monitor: MarketMonitor }) {
        // 获取市场对应的加密货币symbol
        const symbol = getSymbol(market.tags)
        if (!symbol) return

        this.priceMap.delete(symbol)    // 删除历史价格

        const u = getTimeUnit(market.tags)
        if (!u) return

        const unit = getSearchTimeUnit(u)
        const startTime = getStartTime(unit, market.endDate)
        if (!startTime) return
        const endTime = new Date(market.endDate)

        if (u === '15m') {   // 本策略只处理15分钟的市场
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
}