import PQueue from 'p-queue';
import { OrderTask } from './types';

const ORDER_TIMEOUT_MS = 1000;
const MAX_PENDING = 10;

const orderQueue = new PQueue({ concurrency: 3 });
const activeKeys = new Set<string>(); // 去重 key: marketId+type

export function enqueueOrder(task: Omit<OrderTask, 'createdAt'>) {
    const key = `${task.marketId}:${task.type}`;
    if (activeKeys.has(key)) {
        console.log(`⏸️ 重复信号跳过: ${key}`);
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
        console.log(`⏱️ 丢弃过期任务 ${task.marketId} (${age}ms old)`);
        activeKeys.delete(key);
        return;
    }

    try {
        console.log(`🚀 下单执行: ${task.type.toUpperCase()} ${task.marketId}`);
        await fakeApiPlaceOrder(task);
    } catch (err) {
        console.error('❌ 下单失败:', err);
    } finally {
        activeKeys.delete(key);
    }
}

async function fakeApiPlaceOrder(task: OrderTask) {
    // 模拟 API 请求延迟
    await new Promise((r) => setTimeout(r, 300 + Math.random() * 300));
}
