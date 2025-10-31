import { eventBus } from './event-bus';
import { PolymarketEvent } from './types';
import { enqueueOrder } from './order-queue';
import { getConfig } from './config';

const config = getConfig()

eventBus.on('event_update', async (event: PolymarketEvent) => {
    await checkSignal(event);
});

function checkWindow(price: number): boolean {
    if (Array.isArray(config.ENTER_WINDOW) === false || config.ENTER_WINDOW.length < 2) {
        console.warn("config.ENTER_WINDOW is not an array")
        return false
    }
    return price >= config.ENTER_WINDOW[0] && price <= config.ENTER_WINDOW[1]
}

async function checkSignal(event: PolymarketEvent) {
    if (event.negRisk) {
        // 互斥事件
        const markets = event.markets.filter(m => m.negRisk)    // 只取互斥事件的市场
        // 从价格高到低排序市场
        markets.sort((a, b) => b.tokens[0].ask.price - a.tokens[0].ask.price)

        // 扫尾盘检查
        if (markets[0].tokens[0].ask.price - markets[1].tokens[0].ask.price > config.MIN_MARKET_SPREAD && checkWindow(markets[0].tokens[0].ask.price)) {
            // 可能存在扫尾盘机会
            return 1 - markets[0].tokens[0].ask.price
        }
    } else {
        // 非互斥事件
        event.markets.forEach(m => {
            if (!m.negRisk) {
                const spread = m.tokens[0].ask.price - m.tokens[1].ask.price
                const index = spread > 0 ? 0 : 1
                if (Math.abs(spread) > config.MIN_MARKET_SPREAD && checkWindow(m.tokens[index].ask.price)) {
                    // 可能存在扫尾盘机会
                }
            }
        })
    }
}
