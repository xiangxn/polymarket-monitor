import path from "path";
import fs from "fs/promises";
import { Position } from "./types";
import { getConfig } from './config';

const config = getConfig()
// tokenId -> position
const positions: Map<string, Position> = new Map();

const dataDir = path.join(process.cwd(), 'data');

const posFileName = `positions-${process.env.ENV_FILE?.replace('../', '') ?? ''}.json`

let cash = 0



export function addCash(amount: number) {
    cash += Math.abs(amount)
    cash = +cash.toFixed(4)
}

export function setCash(amount: number) {
    cash = amount
}

export function subCash(amount: number) {
    cash -= Math.abs(amount)
    cash = +cash.toFixed(4)
}

export function getCash() {
    return cash
}

export function getPositions() {
    return Array.from(positions.values());
}

export function hasPosition(tokenId: string) {
    return positions.has(tokenId);
}

export async function initPositions() {
    try {
        await fs.mkdir(dataDir, { recursive: true });
    } catch (err) {
    }
    try {
        const content = await fs.readFile(path.join(dataDir, posFileName), 'utf-8');
        // 尝试解析 JSON,并加载到 positions 中
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
            data.forEach(pos => {
                positions.set(pos.tokenId, { ...pos });
            });
        }
    } catch (err: any) {
        // 如果文件不存在或 JSON 无效，则重置为空对象
        if (err.code === 'ENOENT') {
            console.warn(`[init] ${posFileName} 不存在，已自动创建空文件。`);
        } else {
            console.warn(`[warn] ${posFileName} 解析失败，已重置为空对象。`);
        }
    }
    // 获取余额
    try {

    } catch (err: any) {
        console.error(`[error] 获取余额失败: ${err.message}`)
    }
}

export function onPriceUpdate(tokenId: string, price: number): Position | undefined {
    const pos = positions.get(tokenId);
    if (pos) {
        pos.currentPrice = price;
        pos.realizedPnL = (pos.currentPrice - pos.entryPrice) * pos.size;
    }
    return pos
}

export function addPosition(position: Position): Position {
    let pos = positions.get(position.tokenId);
    if (pos) {
        pos.entryPrice = (pos.entryPrice * pos.size + position.entryPrice * position.size) / (pos.size + position.size);
        pos.currentPrice = position.currentPrice;
        pos.size += position.size;
        pos.realizedPnL = (pos.currentPrice - pos.entryPrice) * pos.size;
        pos.stopLoss = pos.entryPrice * (1 - config.STOP_LOSS_PERCENTAGE);
    } else {
        positions.set(position.tokenId, { ...position });
        pos = positions.get(position.tokenId)!;
        pos.stopLoss = pos.entryPrice * (1 - config.STOP_LOSS_PERCENTAGE);
    }
    return pos!
}

export function delPosition(tokenId: string) {
    const pos = positions.get(tokenId);
    if (pos) {
        positions.delete(tokenId);
    } else {
        console.log(`[delPosition] 没有找到tokenId: ${tokenId}, ${JSON.stringify(positions)}`)
    }
}

export function subPosition(tokenId: string, size: number) {
    const pos = positions.get(tokenId);
    if (pos) {
        pos.size -= size;
        if (pos.size < 1) {
            positions.delete(tokenId);
        }
    }
}

export async function savePositions() {
    const poss = Array.from(positions.values());
    await fs.writeFile(path.join(dataDir, posFileName), JSON.stringify(poss, null, 2));
}
