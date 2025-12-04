import { eventBus } from './event-bus';
import { PolymarketEvent, Token } from './types';
import { enqueueOrder } from './order-queue';
import { getConfig } from './config';
import { delPosition, getPositions, onPriceUpdate, getCash } from './position';
import { getExternalPrice } from './price-monitor';

const config = getConfig()

/**
 * market.conditionId -> scheduled
 */
const calcState = new Map<string, { scheduled: boolean }>();

// 监听价格更新主要用于止盈止损
eventBus.on('price_update', async (data: { marketId: string, tokenId: string, event: PolymarketEvent, }) => {
    const market = data.event.markets.find(m => m.id === data.marketId)!
    // 防抖处理
    let item = calcState.get(market.conditionId);
    if (!item) {
        item = { scheduled: false };
        calcState.set(market.conditionId, item);
    }
    if (item.scheduled) return;

    item.scheduled = true;
    setTimeout(async () => {
        await Promise.all(market.tokens.map(async (token) => {
            const position = onPriceUpdate(token.tokenId, token.bid.price)
            if (position) { // 检查是否有持仓
                if (position.entryPrice === 0) {    // 如果还没有收到订单数据，就暂时跳过
                    return
                }
                // 最高优先级止损
                const resolutionSource = (data.event as any).resolutionSource || (data.event as any).description
                const currentPrice = getExternalPrice(data.event.targetSymbol, resolutionSource)
                const relativePriceChange = Math.abs(currentPrice - data.event.openPrice) / data.event.openPrice
                if (relativePriceChange < config.STOP_LOSS_RELATIVE_PRICE_CHANGE) {
                    console.info(`[strategy] 止损: ${token.tokenId}, bid价格: ${token.bid.price}, trade价格: ${token.price}, 数量: ${position.size}, relativePriceChange: ${relativePriceChange}`)
                    enqueueOrder({
                        type: 'sell',
                        conditionId: market.conditionId,
                        eventId: data.event.id,
                        tokenId: token.tokenId,
                        amount: position.size,
                        price: token.bid.price,
                        marketId: data.marketId,
                        outcome: token.outcome
                    })
                    return
                }
                if (token.bid.price < position.stopLoss) {  // 判断止损
                    if (token.price >= config.STOP_LOSS_FLIP_LIMIT) return  // 价格未超过止损翻转限制，不止损

                    const vols = [...token.lastBuy.map(b => b.size), ...token.lastSell.map(s => s.size)]
                    if (vols.length === 0) return

                    const now = Date.now()
                    const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length    // 有效数据的平均成交量
                    const lastSells = token.lastSell.filter(s => s.price < position.stopLoss && now - s.time <= config.STOP_LOSS_DELAY) // STOP_LOSS_DELAY 秒内成交价低于止损价的卖单
                    const totalSellVol = lastSells.reduce((a, b) => a + b.size, 0)  // 止损前STOP_LOSS_DELAY秒卖单的总量
                    if (lastSells.length >= config.STOP_LOSS_TRADE_COUNT && totalSellVol > avgVol * config.STOP_LOSS_VOLUME_AVG_RATE && position.size >= 1) {
                        console.info(`[strategy] 止损: ${token.tokenId}, bid价格: ${token.bid.price}, trade价格: ${token.price}, 数量: ${position.size}`)
                        enqueueOrder({
                            type: 'sell',
                            conditionId: market.conditionId,
                            eventId: data.event.id,
                            tokenId: token.tokenId,
                            amount: position.size,
                            price: token.bid.price,
                            marketId: data.marketId,
                            outcome: token.outcome
                        })
                    }
                } else if (token.bid.price > position.entryPrice * (1 + config.TAKE_PROFIT_PERCENTAGE) || token.bid.price >= config.TAKE_PROFIT_PRICE) {  // 判断止盈
                    // 如果即将结束，则不止盈，减少滑点损失
                    if (new Date(market.endDate).getTime() - Date.now() <= config.TAKE_PROFIT_MIN_TIME) return

                    console.info(`[strategy] 止盈: ${token.tokenId}, 价格: ${token.bid.price}, 数量: ${position.size}`)
                    enqueueOrder({
                        type: 'sell',
                        conditionId: market.conditionId,
                        eventId: data.event.id,
                        tokenId: token.tokenId,
                        amount: position.size,
                        price: token.bid.price,
                        marketId: data.marketId,
                        outcome: token.outcome
                    })
                }
            } else {    // 检查是否有扫尾盘机会
                await checkSignal(data.event);
            }
        }))
        item.scheduled = false;
        calcState.delete(market.conditionId)
    }, config.DATA_JITTER_DELAY);
});

// 一轮完成，清仓
eventBus.on('batch_finished', async (events: PolymarketEvent[]) => {
    const positions = getPositions()
    const delPs: string[] = []
    for (const pos of positions) {
        if (pos.entryPrice === 0) {
            delPs.push(pos.tokenId)
            continue
        }
        const event = events.find(e => e.id === pos.eventId)
        if (!event) {
            delPs.push(pos.tokenId)
            continue
        }
        // console.info(`[strategy] 尝试止盈: ${pos.tokenId}, 数量: ${pos.size}, 入场价格: ${pos.entryPrice}, 当前价格: ${pos.currentPrice}, 如果失败, 则在后面claim`)
        // 结束的事件不手动卖出，因为可能滑点
        // const market = event.markets.find(m => m.id === pos.marketId)!
        // const token = market.tokens.find(t => t.tokenId === pos.tokenId)!
        // enqueueOrder({
        //     type: 'sell',
        //     eventId: event.id,
        //     conditionId: market.conditionId,
        //     tokenId: pos.tokenId,
        //     amount: pos.size,
        //     price: token.bid.price,
        //     marketId: pos.marketId,
        //     outcome: token.outcome
        // })
    }
    // 清理过期持仓
    delPs.forEach(tokenId => {
        delPosition(tokenId)
    })
})

function checkWindow(price: number): boolean {
    if (Array.isArray(config.ENTER_WINDOW) === false || config.ENTER_WINDOW.length < 2) {
        console.warn("config.ENTER_WINDOW is not an array")
        return false
    }
    return price >= config.ENTER_WINDOW[0] && price <= config.ENTER_WINDOW[1]
}

async function checkSignal(event: PolymarketEvent) {
    // 时间窗口过滤
    if (new Date(event.endDate).getTime() - Date.now() > config.MIN_END_TIME) return

    // 价格相对变动幅度过滤
    if (event.openPrice > 0) {
        const resolutionSource = (event as any).resolutionSource || (event as any).description
        const currentPrice = getExternalPrice(event.targetSymbol, resolutionSource)
        const relativePriceChange = Math.abs(currentPrice - event.openPrice) / event.openPrice
        if (relativePriceChange < config.RELATIVE_PRICE_CHANGE) {
            console.info(`[strategy] 价格相对变动幅度过小, 不进行扫尾盘检查: ${event.targetSymbol}, 当前价格: ${currentPrice}, 开盘价格: ${event.openPrice}, 相对变动幅度: ${relativePriceChange}`)
            return
        }
    }

    if (event.negRisk) {
        // 互斥事件
        const markets = event.markets.filter(m => m.negRisk)    // 只取互斥事件的市场
        // 从价格高到低排序市场,互斥市场只是yes
        markets.sort((a, b) => b.tokens[0].ask.price - a.tokens[0].ask.price)

        // 扫尾盘检查
        if (markets[0].tokens[0].ask.price - markets[1].tokens[0].ask.price > config.MIN_MARKET_SPREAD && checkWindow(markets[0].tokens[0].ask.price)) {
            // 可能存在扫尾盘机会
            const token = markets[0].tokens[0]
            let size = Math.min(token.ask.size * token.ask.price, config.MAX_ORDER_SIZE)
            size = Math.max(size, config.MIN_ORDER_SIZE)
            if (size < config.MIN_ORDER_SIZE) return    // size太小，不操作

            // 风控过滤
            const cash = getCash()
            if (cash - size < config.MIN_BALANCE) {
                return
            }

            if (checkBuy(token)) {
                enqueueOrder({
                    type: 'buy',
                    eventId: event.id,
                    conditionId: markets[0].conditionId,
                    marketId: markets[0].id,
                    tokenId: token.tokenId,
                    amount: +size.toFixed(4),
                    price: token.ask.price,
                    outcome: token.outcome
                })
            }
        }
    } else {
        // 非互斥事件
        event.markets.forEach(m => {
            if (!m.negRisk) {
                const spread = m.tokens[0].ask.price - m.tokens[1].ask.price
                const index = spread > 0 ? 0 : 1
                if (Math.abs(spread) > config.MIN_MARKET_SPREAD && checkWindow(m.tokens[index].ask.price)) {
                    // 可能存在扫尾盘机会
                    const token = m.tokens[index]
                    let size = Math.min(token.ask.size * token.ask.price, config.MAX_ORDER_SIZE)
                    size = Math.max(size, config.MIN_ORDER_SIZE)
                    if (size < config.MIN_ORDER_SIZE) return    // size太小不操作

                    // 风控过滤
                    const cash = getCash()
                    if (cash - size < config.MIN_BALANCE) {
                        return
                    }

                    if (checkBuy(token)) {
                        enqueueOrder({
                            type: 'buy',
                            eventId: event.id,
                            conditionId: m.conditionId,
                            marketId: m.id,
                            tokenId: m.tokens[index].tokenId,
                            amount: +size.toFixed(4),
                            price: m.tokens[index].ask.price,
                            outcome: m.tokens[index].outcome
                        })
                    }
                }
            }
        })
    }
}

function checkBuy(token: Token) {
    const vols = [...token.lastBuy, ...token.lastSell]
    if (vols.length === 0) return false   // 没有交易，不操作

    const avgVol = vols.reduce((a, b) => a + b.size, 0) / vols.length    // 有效数据的平均成交量
    const lastBuys = token.lastBuy.filter(s => Date.now() - s.time <= config.ENTER_DELAY)
    const totalBuyVol = lastBuys.reduce((a, b) => a + b.size, 0)  // 下单前ENTER_DELAY秒买单的总量

    const prices = vols.filter(t => Date.now() - t.time <= 5_000)
    const avgPrice = prices.reduce((a, b) => a + b.price, 0) / prices.length    // 有效数据最新5秒的平均成交价

    if ((token.price - avgPrice) / avgPrice < config.ENTER_DELTA_THRESHOLD) return false // 下跌跌幅大于ENTER_DELTA_THRESHOLD, 不下单. 因为此值为负, 所以是<. 默认值-0.005

    if (totalBuyVol < avgVol * config.ENTER_VOLUME_AVG_RATE) return false // 交易量太小，不操作
    if (lastBuys.length < config.ENTER_TRADE_COUNT) return false  // 成交单太少，不操作

    console.debug(`[strategy] 扫尾盘检查: ${token.tokenId},
                              最新成交价: ${token.price}, 最新Ask价${token.ask.price}, 最近5秒平均价: ${avgPrice}, 
                              最近平均成交量: ${avgVol}, 最近5秒买单总量: ${totalBuyVol}`
    )

    return true
}
