import { CryptoPriceSymbol, PolymarketMarket, SlidingWindow } from "../types"
import { eventBus, EVENT_KEY_POLYMARKET_PRICE, EVENT_KEY_BN_PRICE, EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START } from '../event-bus';
import { MarketMonitor } from "../market-monitor";
import { getSearchTimeUnit, getStartTime, getSymbol, getTimeUnit } from "../polymarket";
import { secondsLeft } from "../utils/math";
import { ConfigType, getConfig } from "../config";

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
        this.onBinancePriceUpdate = this.onBinancePriceUpdate.bind(this)

    }

    public start() {
        eventBus.on(`${EVENT_KEY_MARKET_START}:${this.eventType}`, this.onMarketStart)
        eventBus.on(EVENT_KEY_MARKET_RESOLVED, this.onMarketResolved)
        eventBus.on(EVENT_KEY_POLYMARKET_PRICE, this.onMarketPriceUpdate)
        eventBus.on(EVENT_KEY_BN_PRICE, this.onBinancePriceUpdate)
    }

    public stop() {
        eventBus.off(`${EVENT_KEY_MARKET_START}:${this.eventType}`, this.onMarketStart)
        eventBus.off(EVENT_KEY_MARKET_RESOLVED, this.onMarketResolved)
        eventBus.off(EVENT_KEY_POLYMARKET_PRICE, this.onMarketPriceUpdate)
        eventBus.off(EVENT_KEY_BN_PRICE, this.onBinancePriceUpdate)
    }

    protected onBinancePriceUpdate({ symbol, price, volume, time }: { symbol: string, price: number, volume: number, time: number }) {
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

    /**
     * 检查信号
     * @param market Polymarket市场对象
     * @returns 
     */
    protected async checkSignal(market: PolymarketMarket) {
        const timeLeft = secondsLeft(market.endDate);
        // console.log('timeLeft:', timeLeft)
        // 时间窗口内入场
        if (timeLeft > this.config.ENTRY_WINDOW_HIGH || timeLeft < this.config.ENTRY_WINDOW_LOW) return

        // compute PM YES/NO[UP/DOWN] price diff using bestSell/bestBuy as approximations
        const bestYesBid = market.tokens[0].bid.price
        const bestYesAsk = market.tokens[0].ask.price
        const bestNoBid = market.tokens[1].bid.price
        const bestNoAsk = market.tokens[1].ask.price

        const symbol = this.symbolMap.get(market.conditionId)!
        const nowPrice = this.priceMap.get(symbol)!
        const openPrice = this.openPriceMap.get(market.conditionId)!
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
            // 入场限价
            if (!bestYesAsk || bestYesAsk > this.config.MAX_ENTRY_PRICE) return
            // 盘口差
            if (bestYesBid - bestNoAsk > this.config.MAX_BOOK_DIFF) return

            console.warn("=== DECISION: BUY UP", JSON.stringify({ timeLeft, trendScore, p_now, p_open, vol, bestYesAsk, bestNoAsk, avg10, avg30, volatility_10s, volatility_30s }));
            // place order via Polymarket CLOB REST / relayer (not included here). This demo only logs decision.
        }

        // BUY DOWN condition
        if (trendScore <= -this.config.TREND_THRESHOLD && (p_now < p_open && p_now <= avg10 && avg10 <= avg30)) {
            // 入场限价
            if (!bestNoAsk || bestNoAsk > this.config.MAX_ENTRY_PRICE) return
            // 盘口差
            if (bestNoBid - bestYesAsk > this.config.MAX_BOOK_DIFF) return

            console.warn("=== DECISION: BUY DOWN", JSON.stringify({ timeLeft, trendScore, p_now, p_open, vol, bestYesAsk, bestNoAsk, avg10, avg30, volatility_10s, volatility_30s }));
            // place order...
        }
    }

    protected onMarketPriceUpdate(market: PolymarketMarket) {
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
            this.checkSignal(market)
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