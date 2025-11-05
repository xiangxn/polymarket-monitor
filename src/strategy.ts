import { eventBus } from './event-bus';
import { PolymarketEvent } from './types';
import { enqueueOrder } from './order-queue';
import { getConfig } from './config';
import { getPositions, onPriceUpdate } from './position';

const config = getConfig()

// 监听价格更新主要用于止盈止损
eventBus.on('price_update', async (data: { marketId: string, tokenId: string, event: PolymarketEvent, }) => {
    const market = data.event.markets.find(m => m.id === data.marketId)!
    await Promise.all(market.tokens.map(async (token) => {
        const position = onPriceUpdate(token.tokenId, token.bid.price)
        if (position) { // 检查是否有持仓
            if (position.entryPrice === 0) {    // 如果还没有收到订单数据，就暂时跳过
                return
            }
            if (token.bid.price < position.stopLoss) {  // 判断止损
                const vols = [...token.lastBuy.map(b => b.size), ...token.lastSell.map(s => s.size)]
                if (vols.length === 0) return

                const now = Date.now()
                const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length    // 有效数据的平均成交量
                const lastSells = token.lastSell.filter(s => s.price < position.stopLoss && now - s.time <= config.STOP_LOSS_DELAY) // STOP_LOSS_DELAY 秒内成交价低于止损价的卖单
                const totalSellVol = lastSells.reduce((a, b) => a + b.size, 0)  // 止损前STOP_LOSS_DELAY秒卖单的总量
                if (lastSells.length >= 3 && totalSellVol > avgVol * config.STOP_LOSS_VOLUME_AVG_RATE) {
                    console.info(`[strategy] 止损: ${token.tokenId}, 价格: ${token.bid.price}, 数量: ${position.size}`)
                    enqueueOrder({
                        type: 'sell',
                        eventId: data.event.id,
                        tokenId: token.tokenId,
                        amount: position.size,
                        price: token.bid.price,
                        marketId: data.marketId,
                        outcome: token.outcome
                    })
                }
            } else if (token.bid.price > position.entryPrice * (1 + config.TAKE_PROFIT_PERCENTAGE) || token.bid.price >= config.TAKE_PROFIT_PRICE) {  // 判断止盈
                console.info(`[strategy] 止盈: ${token.tokenId}, 价格: ${token.bid.price}, 数量: ${position.size}`)
                enqueueOrder({
                    type: 'sell',
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
});

// 一轮完成，清仓
eventBus.on('batch_finished', async (events: PolymarketEvent[]) => {
    const positions = getPositions()
    for (const pos of positions) {
        console.info(`[strategy] 止盈: ${pos.tokenId}, 数量: ${pos.size}`)
        const event = events.find(e => e.id === pos.eventId)!
        const token = event.markets.find(m => m.id === pos.marketId)!.tokens.find(t => t.tokenId === pos.tokenId)!
        enqueueOrder({
            type: 'sell',
            eventId: event.id,
            tokenId: pos.tokenId,
            amount: pos.size,
            price: token.bid.price,
            marketId: pos.marketId,
            outcome: token.outcome
        })
    }
})

function checkWindow(price: number): boolean {
    if (Array.isArray(config.ENTER_WINDOW) === false || config.ENTER_WINDOW.length < 2) {
        console.warn("config.ENTER_WINDOW is not an array")
        return false
    }
    return price >= config.ENTER_WINDOW[0] && price <= config.ENTER_WINDOW[1]
}

async function checkSignal(event: PolymarketEvent) {
    if (new Date(event.endDate).getTime() - Date.now() > config.MIN_END_TIME) return
    if (event.negRisk) {
        // 互斥事件
        const markets = event.markets.filter(m => m.negRisk)    // 只取互斥事件的市场
        // 从价格高到低排序市场,互斥市场只是yes
        markets.sort((a, b) => b.tokens[0].ask.price - a.tokens[0].ask.price)

        // 扫尾盘检查
        if (markets[0].tokens[0].ask.price - markets[1].tokens[0].ask.price > config.MIN_MARKET_SPREAD && checkWindow(markets[0].tokens[0].ask.price)) {
            // 可能存在扫尾盘机会
            const size = Math.min(markets[0].tokens[0].ask.size * markets[0].tokens[0].ask.price, config.MAX_ORDER_SIZE)
            enqueueOrder({
                type: 'buy',
                eventId: event.id,
                marketId: markets[0].id,
                tokenId: markets[0].tokens[0].tokenId,
                amount: +size.toFixed(4),
                price: markets[0].tokens[0].ask.price,
                outcome: markets[0].tokens[0].outcome
            })
        }
    } else {
        // 非互斥事件
        event.markets.forEach(m => {
            if (!m.negRisk) {
                const spread = m.tokens[0].ask.price - m.tokens[1].ask.price
                const index = spread > 0 ? 0 : 1
                if (Math.abs(spread) > config.MIN_MARKET_SPREAD && checkWindow(m.tokens[index].ask.price)) {
                    // 可能存在扫尾盘机会
                    const size = Math.min(m.tokens[index].ask.size * m.tokens[index].ask.price, config.MAX_ORDER_SIZE)
                    enqueueOrder({
                        type: 'buy',
                        eventId: event.id,
                        marketId: m.id,
                        tokenId: m.tokens[index].tokenId,
                        amount: +size.toFixed(4),
                        price: m.tokens[index].ask.price,
                        outcome: m.tokens[index].outcome
                    })
                }
            }
        })
    }
}
