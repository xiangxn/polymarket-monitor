/**
 * 
1. **趋势偏离成立**
   vol > 0.15% ~ 0.3%（具体参数可调）

2. **短周期无下跌**
   binance_now >= avg_10s

3. **短周期趋势明确**
   avg_10s >= avg_30s

4. **趋势加速**
   volatility_10s > volatility_30s

5. **Polymarket 方向确认**
   polymarket_last_trade 在 up 方向
*/

import { eventBus, EVENT_KEY_POLYMARKET_PRICE, EVENT_KEY_BN_PRICE, EVENT_KEY_MARKET_RESOLVED, EVENT_KEY_MARKET_START } from '../event-bus';
import { MarketMonitor } from '../market-monitor';
import { fetchCryptoPrice, getSearchTimeUnit, getStartTime, getSymbol, getTimeUnit } from '../polymarket';
import { CryptoPriceSymbol, PolymarketMarket, SlidingWindow } from '../types';

const ENTRY_WINDOW_LOW = 60; // seconds
const ENTRY_WINDOW_HIGH = 14 * 60; // seconds
const TREND_THRESHOLD = 0.0006; // 0.06% -> 0.0006
const MIN_PRICE_DELTA_THRESHOLD = 0.0015; // 0.15%
const MAX_PRICE_DELTA_THRESHOLD = 0.0035; // 0.35%
const MAX_ENTRY_PRICE = 0.68
const MAX_BOOK_DIFF = 0.25
const VOLATILITY_MARGIN = 1.0
const DATA_JITTER_DELAY = 30

/**
 * binance价格
 * symbol -> price
 */
const priceMap: Map<string, number> = new Map()
/**
 * 市场对应币种的开盘价
 * conditionId -> openPrice
 */
const openPriceMap: Map<string, number> = new Map()
/**
 * conditionId -> symbol
 * 市场对应的加密货币symbol
 */
const symbolMap: Map<string, CryptoPriceSymbol> = new Map()
/**
 * symbol -> SlidingWindow
 * 10s 滑动窗口
 */
const win10Map: Map<string, SlidingWindow> = new Map()
/**
 * symbol -> SlidingWindow
 * 30s 滑动窗口
 */
const win30Map: Map<string, SlidingWindow> = new Map()

eventBus.on(`${EVENT_KEY_MARKET_START}:crypto-prices`, onMarketStart)
eventBus.on(EVENT_KEY_MARKET_RESOLVED, onMarketResolved)
eventBus.on(EVENT_KEY_POLYMARKET_PRICE, onUpdateMarket)

// BN 价格更新, 更新对应的滑动窗口
eventBus.on(EVENT_KEY_BN_PRICE, ({ symbol, price, volume, time }: { symbol: string, price: number, volume: number, time: number }) => {
    let tokenW10 = win10Map.get(symbol)
    if (!tokenW10) {
        tokenW10 = new SlidingWindow(10_000)
        win10Map.set(symbol, tokenW10)
    }
    let tokenW30 = win30Map.get(symbol)
    if (!tokenW30) {
        tokenW30 = new SlidingWindow(30_000)
        win30Map.set(symbol, tokenW30)
    }
    priceMap.set(symbol, price)
    tokenW10.push({ ts: time, price: price });
    tokenW30.push({ ts: time, price: price });
})

/**
 * 检查信号
 * @param market Polymarket市场对象
 * @returns 
 */
async function checkSignal(market: PolymarketMarket) {
    const timeLeft = secondsLeft(market.endDate);
    console.log('timeLeft:', timeLeft)
    // 时间窗口内入场
    if (timeLeft > ENTRY_WINDOW_HIGH || timeLeft < ENTRY_WINDOW_LOW) return

    // compute PM YES/NO[UP/DOWN] price diff using bestSell/bestBuy as approximations
    const yesPrice = market.tokens[0].ask.price
    const noPrice = market.tokens[1].ask.price

    const symbol = symbolMap.get(market.conditionId)!
    const nowPrice = priceMap.get(symbol)!
    const openPrice = openPriceMap.get(market.conditionId)!
    const win10 = win10Map.get(symbol)!
    const win30 = win30Map.get(symbol)!

    // 10秒算术平均价格
    const avg10 = win10.avg();
    // 30秒算术平均价格
    const avg30 = win30.avg();
    console.log('symbol:', symbol, 'avg10:', avg10, 'avg30:', avg30, 'openPrice:', openPrice, 'nowPrice:', nowPrice, 'yesPrice:', yesPrice, 'noPrice:', noPrice)
    if (!avg10 || !avg30) return;

    // 方向信号
    const trendScore = (avg10 - avg30) / avg30;

    // 相对开盘偏离
    const p_open = openPrice
    const p_now = nowPrice
    const vol = Math.abs((p_now - p_open) / p_open);

    // 对数收益标准差
    const volatility_10s = win10.std()
    const volatility_30s = win30.std()
    console.log('volatility_10s:', volatility_10s, 'volatility_30s:', volatility_30s, 'trendScore:', trendScore, 'vol:', vol)
    if (!volatility_10s || !volatility_30s) return;

    // 盘口差
    const bookDiff = Math.abs(yesPrice - noPrice)
    console.log('bookDiff:', bookDiff)
    if (bookDiff > MAX_BOOK_DIFF) return

    console.log('trendScore >= TREND_THRESHOLD:', trendScore >= TREND_THRESHOLD,
        '\n(vol >= MIN_PRICE_DELTA_THRESHOLD && vol <= MAX_PRICE_DELTA_THRESHOLD):', (vol >= MIN_PRICE_DELTA_THRESHOLD && vol <= MAX_PRICE_DELTA_THRESHOLD),
        '\n(p_now > p_open && p_now > avg10 && avg10 >= avg30):', (p_now > p_open && p_now > avg10 && avg10 >= avg30),
        '\nvolatility_10s > VOLATILITY_MARGIN * volatility_30s:', volatility_10s > VOLATILITY_MARGIN * volatility_30s
    )
    // BUY UP condition
    if (trendScore >= TREND_THRESHOLD && (vol >= MIN_PRICE_DELTA_THRESHOLD && vol <= MAX_PRICE_DELTA_THRESHOLD) && (p_now > p_open && p_now > avg10 && avg10 >= avg30) && volatility_10s > VOLATILITY_MARGIN * volatility_30s) {
        if (!yesPrice || yesPrice > MAX_ENTRY_PRICE) return

        console.warn("=== DECISION: BUY UP", JSON.stringify({ timeLeft, trendScore, p_now, p_open, vol, yesPrice, noPrice, avg10, avg30, volatility_10s, volatility_30s }));
        // place order via Polymarket CLOB REST / relayer (not included here). This demo only logs decision.
    }

    // BUY DOWN condition
    if (trendScore <= -TREND_THRESHOLD && (vol >= MIN_PRICE_DELTA_THRESHOLD && vol <= MAX_PRICE_DELTA_THRESHOLD) && (p_now < p_open && p_now < avg10 && avg10 <= avg30) && volatility_10s > VOLATILITY_MARGIN * volatility_30s) {
        if (!noPrice || noPrice > MAX_ENTRY_PRICE) return

        console.warn("=== DECISION: BUY DOWN", JSON.stringify({ timeLeft, trendScore, p_now, p_open, vol, yesPrice, noPrice, avg10, avg30, volatility_10s, volatility_30s }));
        // place order...
    }
}

async function onMarketStart({ market, monitor }: { market: PolymarketMarket, monitor: MarketMonitor }) {
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
        symbolMap.set(market.conditionId, symbol)
        let openPrice: number | undefined | null = openPriceMap.get(market.conditionId)
        if (!openPrice) {
            openPrice = await fetchCryptoPrice(symbol, startTime, endTime, unit)
            if (openPrice)
                openPriceMap.set(market.conditionId, openPrice)
        }
        monitor.subscribeMarket(market)
    }

}

async function onMarketResolved({ market, monitor }: { market: PolymarketMarket, monitor: MarketMonitor }) {
    console.debug('onMarketResolved:', market.conditionId)
    openPriceMap.delete(market.conditionId)
    symbolMap.delete(market.conditionId)
    // TODO: 可以在这里触发redeem
}

const calcState = new Map<string, { scheduled: boolean }>();
function onUpdateMarket(market: PolymarketMarket) {
    const symbol = symbolMap.get(market.conditionId)
    if (!symbol) return

    const nowPrice = priceMap.get(symbol)
    if (!nowPrice) return

    const openPrice = openPriceMap.get(market.conditionId)
    if (!openPrice) return

    const win10 = win10Map.get(symbol)
    if (!win10) return

    const win30 = win30Map.get(symbol)
    if (!win30) return

    // 防抖处理
    let item = calcState.get(market.conditionId);
    if (!item) {
        item = { scheduled: false };
        calcState.set(market.conditionId, item);
    }
    if (item.scheduled) return;
    console.debug(`onUpdateMarket: ${market.conditionId} ${symbol} ${openPrice} -> ${nowPrice}`)
    item.scheduled = true;
    setTimeout(() => {
        item.scheduled = false;
        checkSignal(market)
    }, DATA_JITTER_DELAY);
}





function secondsLeft(endDateIso: string) {
    const endMs = new Date(endDateIso).getTime();
    const now = Date.now();
    return Math.max(0, Math.floor((endMs - now) / 1000));
}