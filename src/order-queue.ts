import PQueue from 'p-queue';
import { OrderMessage, OrderTask } from './types';
import { addCash, addPosition, getCash, getPositions, hasPosition, subCash, subPosition } from './position';
import fs from "fs/promises";
import path from "path";
import { eventBus } from './event-bus';
import { dirExists, fileExists } from './utils/helper';
import { PolymarketClient } from './polymarket';
import { Side } from '@polymarket/clob-client';

const ORDER_TIMEOUT_MS = 1000;
const MAX_PENDING = 10;

const orderFileSuffix = `${process.env.ENV_FILE?.replace('../', '') ?? ''}`
const orderQueue = new PQueue({ concurrency: 3 });
const activeKeys = new Set<string>(); // 去重 key: marketId+type

const dataDir = path.join(process.cwd(), 'data');
let client: PolymarketClient | null = null;
let balanceTime = 0

export async function initOrderQueue() {
    const positions = getPositions()
    positions.forEach(pos => {
        const key = `${pos.marketId}:${pos.tokenId}:buy`;
        activeKeys.add(key);
    })
    if (!(await dirExists(dataDir))) {
        await fs.mkdir(dataDir, { recursive: true });
    }
    const filePath = getOrderFilePath();
    await checkOrderFile(filePath)

    client = new PolymarketClient()
}
export function enqueueOrder(task: Omit<OrderTask, 'createdAt'>) {
    const key = `${task.marketId}:${task.tokenId}:${task.type}`;
    if (activeKeys.has(key)) {
        // console.log(`⏸️ 重复信号跳过: ${key}`);
        return;
    }

    if (orderQueue.size > MAX_PENDING) {
        console.warn('⚠️ 队列积压，丢弃新任务');
        return;
    }

    const wrapped: OrderTask = { ...task, createdAt: Date.now() };
    activeKeys.add(key);
    orderQueue.add(() => executeOrder(wrapped, key));
}

async function executeOrder(task: OrderTask, key: string) {
    const age = Date.now() - task.createdAt;
    if (age > ORDER_TIMEOUT_MS) {
        console.warn(`⏱️ 丢弃过期任务 ${task.marketId} (${age}ms old)`);
        activeKeys.delete(key);
        return;
    }

    try {
        // console.debug(`🚀 下单执行: ${task.type.toUpperCase()} ${task.marketId}`);
        await fakeApiPlaceOrder(task);
    } catch (err) {
        console.error('❌ 下单失败:', err);
    } finally {
        activeKeys.delete(key);
    }
}

const orderTasks: OrderTask[] = []

eventBus.on('order', async (order: OrderMessage) => {
    await saveOrder(order)
    const task = orderTasks.find(t => t.conditionId === order.market && t.tokenId === order.asset_id)
    let eventId = '0'
    if (task) {
        eventId = task.eventId
    }
    const orderType = order.type.toUpperCase()
    const price = parseFloat(order.price)
    const size = parseFloat(order.size_matched)
    const amount = +(size * price).toFixed(4)
    if (['PLACEMENT', 'UPDATE'].includes(orderType)) {
        const side = order.side.toUpperCase()
        if (side === 'BUY') {
            addPosition({
                eventId,
                conditionId: order.market,
                marketId: task?.marketId ?? "",
                tokenId: order.asset_id,
                outcome: order.outcome,
                entryPrice: price,
                currentPrice: price,
                stopLoss: 0,
                size,
                realizedPnL: 0,
                timestamp: Date.now()
            })
            subCash(amount)
        } else if (side === 'SELL') {
            addCash(amount)
            subPosition(order.asset_id, size)
        }

    }
})

async function fakeApiPlaceOrder(task: OrderTask) {
    orderTasks.push(task)
    if (task.type === 'buy') {
        const cash = getCash()
        if (cash < task.amount) {
            // TODO: 后续可以向TG发通知
            const now = Date.now()
            if (now - balanceTime > 60_000) {
                balanceTime = now
                console.warn(`❌ 现金不足，无法下单: ${task.amount}`);
            }
            return;
        } else {
            balanceTime = 0
        }

        const result = await client?.placeOrder(task.tokenId, task.amount, Side.BUY)
        if (!result) {
            const key = `${task.marketId}:${task.tokenId}:${task.type}`;
            activeKeys.delete(key);
        } else {
            // 添加空持仓，防止重复下单
            addPosition({
                eventId: task.eventId,
                conditionId: task.conditionId,
                marketId: task.marketId,
                tokenId: task.tokenId,
                outcome: task.outcome,
                entryPrice: 0,
                currentPrice: 0,
                stopLoss: 0,
                size: 0,
                realizedPnL: 0,
                timestamp: Date.now()
            })
        }
    } else if (task.type === 'sell') {
        if (task.amount > 0) {
            const result = await client?.placeOrder(task.tokenId, task.amount, Side.SELL)
            if (!result) {
                const key = `${task.marketId}:${task.tokenId}:${task.type}`;
                activeKeys.delete(key);
            }
        }
    }
}

async function saveOrder(order: OrderMessage) {
    if (!order) return

    const filePath = getOrderFilePath();
    await checkOrderFile(filePath)
    // ['Market', 'Token', 'Outcome', 'OrderId', "Price", 'Size', 'Side', 'Timestamp']
    const data = [order.market, order.asset_id, order.outcome, order.id, order.price, order.size_matched, order.side, order.timestamp]
    await fs.writeFile(filePath, data.join(",") + "\n", { flag: 'a', encoding: 'utf-8' });
}

function getOrderFilePath() {
    return path.join(dataDir, `orders-${new Date().toISOString().split('T')[0]}-${orderFileSuffix}.csv`);
}

async function checkOrderFile(filePath: string) {
    if (!(await fileExists(filePath))) {
        const headers = ['Market', 'Token', 'Outcome', 'OrderId', "Price", 'Size', 'Side', 'Timestamp']
        await fs.writeFile(filePath, headers.join(",") + "\n", 'utf-8');
    }
}