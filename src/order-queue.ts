import PQueue from 'p-queue';
import { OrderTask } from './types';
import { addCash, addPosition, getPositions, hasPosition, subCash, subPosition } from './position';
import { getConfig } from './config';
import fs from "fs/promises";
import path from "path";

const config = getConfig()
const ORDER_TIMEOUT_MS = 1000;
const MAX_PENDING = 10;

const orderQueue = new PQueue({ concurrency: 3 });
const activeKeys = new Set<string>(); // 去重 key: marketId+type

export function initActiveKeys() {
    const positions = getPositions()
    positions.forEach(pos => {
        const key = `${pos.marketId}:${pos.tokenId}:buy`;
        activeKeys.add(key);
    })
}
export function enqueueOrder(task: Omit<OrderTask, 'createdAt'>) {
    const key = `${task.marketId}:${task.tokenId}:${task.type}`;
    if (activeKeys.has(key)) {
        // console.log(`⏸️ 重复信号跳过: ${key}`);
        return;
    }

    if (orderQueue.size > MAX_PENDING) {
        console.log('⚠️ 队列积压，丢弃新任务');
        return;
    }

    const wrapped: OrderTask = { ...task, createdAt: Date.now() };
    activeKeys.add(key);
    orderQueue.add(() => executeOrder(wrapped, key));
}

async function executeOrder(task: OrderTask, key: string) {
    const age = Date.now() - task.createdAt;
    if (age > ORDER_TIMEOUT_MS) {
        console.debug(`⏱️ 丢弃过期任务 ${task.marketId} (${age}ms old)`);
        activeKeys.delete(key);
        return;
    }

    try {
        // console.debug(`🚀 下单执行: ${task.type.toUpperCase()} ${task.marketId}`);
        await fakeApiPlaceOrder(task);
    } catch (err) {
        console.error('❌ 下单失败:', err);
    } finally {
        if (hasPosition(task.tokenId) === false) {
            activeKeys.delete(key);
        }
    }
}

const orderList: OrderTask[] = []

// TODO: 模拟代码，实际使用时替换为实际的下单函数
async function fakeApiPlaceOrder(task: OrderTask) {
    orderList.push(task)
    // 模拟 API 请求延迟
    if (task.type === 'buy') {
        // 实际操作时需要检查是否有足够的资金,或者风控停止下单
        subCash(task.amount)
        addPosition({
            eventId: task.eventId,
            marketId: task.marketId,
            tokenId: task.tokenId,
            outcome: task.outcome,
            entryPrice: task.price,
            currentPrice: task.price,
            stopLoss: +(task.price * (1 - config.STOP_LOSS_PERCENTAGE)).toFixed(4),
            size: +(task.amount / task.price).toFixed(4),
            realizedPnL: 0,
            timestamp: Date.now()
        })
    } else if (task.type === 'sell') {
        addCash(+(task.amount * task.price).toFixed(4))
        subPosition(task.tokenId, task.amount)
    }
    // 保存下单数据到csv
    const headers = Object.keys(orderList[0]);
    const rows = orderList.map(obj => headers.map(h => obj[h as keyof typeof obj]).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const dataDir = path.join(process.cwd(), 'data');
    await fs.writeFile(path.join(dataDir, 'orders.csv'), csv, 'utf-8');
}
