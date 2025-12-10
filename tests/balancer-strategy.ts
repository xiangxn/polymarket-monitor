import { ethers } from "ethers";

import dotenv from "dotenv";
dotenv.config();

import '../src/utils/console'

import { fetchWithProxy, roundTo15Minutes } from "../src/utils/helper";
import { PriceManager } from "../src/price-manager";


/**
 * polymarket_balancer.ts
 *
 * 概述:
 *  - 计算上涨/下跌头寸的风险敞口
 *  - 如果风险敞口比率超出容忍范围，计算修正性买入
 *  - 以小额分块方式执行买入，并进行速率限制
 *  - 风险控制：风险敞口区间、最大USDC、每窗口最大添加次数、价格异常保护
 *
 * 重要说明:
 *  - 请实现 fetchMarketPositions() 和 fetchMarketPrice() 以连接 Polymarket API
 *  - 请实现 executeTrade() 以签名/发送交易（或使用可用的REST API）
 *
 * 使用方法:
 *  - tsc polymarket_balancer.ts
 *  - node polymarket_balancer.js
 */

type Outcome = 'Up' | 'Down' | null;

type Position = {
    tokenId: string | null;
    outcome: Outcome;
    size: number;       // 代币数量
    avgPrice: number;   // 平均买入价格
    curPrice: number;   // 当前市场价格（用于买入）
};

type MarketSnapshot = {
    up: Position;
    down: Position;
    timestamp: number;
};

/**
 * 初始仓位模式
 * - Average: 使用平均分配资金
 * - High: 使用最高价格占40%
 * - Low: 使用最低价格占40%
 * - Offset: 使用偏移量
 */
type InitialPositionMode = 'Average' | 'High' | 'Low' | 'Offset'

type Config = {
    marketSlug: string;
    pollingIntervalMs: number;
    funderAddress: string;

    // 每个窗口内额外买入操作的最大次数（避免失控）
    maxAddsPerWindow: number; // e.g., 10

    // 计算添加次数的窗口长度（毫秒）
    addsWindowMs: number;

    // 订单拆分
    splitIntoChunks: number; // 将计划买入拆分成多少个小订单

    // 价格异常保护
    priceJumpThresholdPct: number; // 例如: 0.15 => 如果建议买入价格与上次价格差异>15%则跳过

    // 最小可操作的额外代币数量（低于此值则跳过）
    minAdditionalTokens: number;

    // 模拟运行标志（如果为true，将不调用executeTrade）
    dryRun: boolean;

    // 日志记录
    verbose: boolean;

    // 初始仓位配置
    initialCapitalRatio: number;    // 初始资金比例 (0.5 = 50%)
    minInitialLiquidity: number;    // 最小初始流动性要求
    priceHistoryWindow: number;     // 价格历史窗口（用于分析波动性）
    volatilityThreshold: number;    // 波动性阈值

    // 初始仓位建立参数
    initialPositionMode: InitialPositionMode;
    maxInitialSpread: number;       // 最大初始价差百分比

    // 风险敞口区间: upExp/downExp
    exposureMin: number; // e.g., 0.8
    exposureMax: number; // e.g., 1.25
    exposureTarget: number;

    // 均价策略
    opportunisticDelta: number; // 只有当 curPrice <= avgPrice - delta 才认为“便宜”, 推荐范围：0.01 ~ 0.05
    buyPressure: number;        // 买入力度 (0.1~0.5) 越大越激进
    priceLowerBound: number;
    priceUpperBound: number;

    /** 资金与安全阈值 */
    maxCapital: number;     //愿意在此市场的修正性买入中投入的最大资金
    minBuySize: number;
    maxBuySize: number;
    maxStepPercent: number; // 每次买入的最大百分比

    /** 防止均价总和变坏 */
    sumTolerance: number;           // 0 = 坚决不允许 avgUp+avgDown 增加

    // WebSocket 配置
    wsReconnectInterval: number;    // WebSocket 重连间隔（毫秒）
    wsTimeout: number;              // WebSocket 连接超时（毫秒）
};

const defaultConfig: Config = {
    marketSlug: 'eth-updown-15m-',
    funderAddress: '0x0f71db1628919094a46a3adab93ad844f24534a2',
    pollingIntervalMs: 5000,
    maxAddsPerWindow: 12,
    addsWindowMs: 60 * 1000, // 1 minute
    splitIntoChunks: 5,
    priceJumpThresholdPct: 0.20, // 20%
    minAdditionalTokens: 1.0,
    dryRun: true,
    verbose: true,

    // 初始仓位配置
    initialCapitalRatio: 0.2,        // 使用50%的初始资金
    minInitialLiquidity: 3000,      // 最小流动性 $10,000
    priceHistoryWindow: 100,         // 100个价格点用于计算波动性
    volatilityThreshold: 0.02,      // 最小波动性 2%

    initialPositionMode: 'High',
    maxInitialSpread: 0.2,          // 最大初始价差

    exposureMin: 0.80,
    exposureMax: 1.25,
    exposureTarget: 1.0,
    opportunisticDelta: 0.02,
    buyPressure: 0.3,
    priceLowerBound: 0.2,
    priceUpperBound: 0.7,

    maxCapital: 2000,
    minBuySize: 1,
    maxBuySize: 500,
    maxStepPercent: 0.05,
    sumTolerance: 0,

    // WebSocket 配置
    wsReconnectInterval: 5000,       // 5秒重连间隔
    wsTimeout: 10000,               // 10秒连接超时
};

/* ---------------------------------------------------------
   工具数学函数
   --------------------------------------------------------- */
/**
 * 计算敞口
 * @param pos 当前方向头寸
 * @returns 
 */
function exposure(pos: Position) {
    return pos.size * pos.avgPrice;
}

/* 如果以价格p购买q个代币，计算新的平均价格 */
function newAverage(pos: Position, newBuy: number) {
    return (pos.size * pos.avgPrice + newBuy * pos.curPrice) / Math.max(1, pos.size + newBuy);
}

/* ---------------------------------------------------------
   核心数学：计算修正性买入
   我们选择基于风险敞口的修正：
   目标是将风险敞口移动到允许比率区间的中点。
   --------------------------------------------------------- */
function computeCorrectionV4(up: Position, down: Position, config: Config) {
    let buyUp = 0;
    let buyDown = 0;

    const oldSum = up.avgPrice + down.avgPrice;

    // exposure calculation
    const upExp = exposure(up)
    const downExp = exposure(down)
    const ratio = upExp / Math.max(1e-12, downExp);

    const upCheap = up.curPrice < up.avgPrice - config.opportunisticDelta;
    const downCheap = down.curPrice < down.avgPrice - config.opportunisticDelta;

    // -------- 1) Opportunistic Buy (优先级最高：只买便宜的) --------
    if (downCheap)
        buyDown += (down.avgPrice - down.curPrice) * down.size * config.buyPressure;

    if (upCheap)
        buyUp += (up.avgPrice - up.curPrice) * up.size * config.buyPressure;

    // -------- 2) Exposure-based correction (仅在价格便宜时允许介入) --------
    if (ratio > config.exposureMax && downCheap) {
        const pressure = (ratio - config.exposureTarget) / ratio;
        buyDown += pressure * down.size * config.buyPressure;
    }

    if (ratio < config.exposureMin && upCheap) {
        const pressure = (1 / ratio - 1 / config.exposureTarget);
        buyUp += pressure * up.size * config.buyPressure;
    }

    // -------- 3) 资金安全限制 --------
    buyUp = Math.min(Math.max(buyUp, 0), config.maxBuySize);
    buyDown = Math.min(Math.max(buyDown, 0), config.maxBuySize);

    if (buyUp < config.minBuySize && buyDown < config.minBuySize)
        return { buyUp: 0, buyDown: 0, reason: "below minimum buy threshold" };

    // -------- 4) EV Safety Check → 均价不能恶化 --------
    const newUpAvg = newAverage(up, buyUp)
    const newDownAvg = newAverage(down, buyDown)
    const newSum = newUpAvg + newDownAvg;

    if (newSum > oldSum + config.sumTolerance) {
        // SUM 变坏 → 禁止改变
        return { buyUp: 0, buyDown: 0, reason: "EV reject (sumAvg worse)" };
    }

    return { buyUp, buyDown, reason: "valid buy" };
}

function computeCorrectionV5(up: Position, down: Position, config: Config) {
    let buyUp = 0;
    let buyDown = 0;
    const usedCapital = up.size * up.avgPrice + down.size * down.avgPrice

    // ---------- 0) 价格合理性检验 ----------
    if (
        up.curPrice <= 0 || up.curPrice >= 1 ||
        down.curPrice <= 0 || down.curPrice >= 1
    ) {
        return { buyUp: 0, buyDown: 0, reason: "invalid price (illiquid/no price)" };
    }

    const oldSum = up.avgPrice + down.avgPrice;

    // ---------- 敞口逻辑 ----------
    const upExp = exposure(up);
    const downExp = exposure(down);
    const ratio = upExp / Math.max(1e-12, downExp);

    const upCheap = up.curPrice < up.avgPrice - config.opportunisticDelta;
    const downCheap = down.curPrice < down.avgPrice - config.opportunisticDelta;

    // --- 机会性买入（优先级 1） ---
    if (downCheap) buyDown += (down.avgPrice - down.curPrice) * down.size * config.buyPressure;
    if (upCheap) buyUp += (up.avgPrice - up.curPrice) * up.size * config.buyPressure;

    // --- 敞口校正（仅在价格低廉的情况下） --- 
    if (ratio > config.exposureMax && downCheap) {
        buyDown += ((ratio - config.exposureTarget) / ratio) * down.size * config.buyPressure;
    }

    if (ratio < config.exposureMin && upCheap) {
        buyUp += ((1 / ratio - 1 / config.exposureTarget) * up.size * config.buyPressure);
    }

    // ---------- 预算执行 ----------
    const budgetRemaining = Math.max(0, config.maxCapital - usedCapital);

    if (budgetRemaining <= 0) return { buyUp: 0, buyDown: 0, reason: "budget exhausted" };

    const maxStepBudget = budgetRemaining * config.maxStepPercent; // e.g. 5% step allocation

    const maxUpQty = maxStepBudget / up.curPrice;
    const maxDownQty = maxStepBudget / down.curPrice;

    buyUp = Math.min(buyUp, maxUpQty);
    buyDown = Math.min(buyDown, maxDownQty);

    if (buyUp < config.minBuySize && buyDown < config.minBuySize)
        return { buyUp: 0, buyDown: 0, reason: "too small after budget scaling" };

    // ---------- EV 保护：sumAvg 不能恶化 ----------
    const newUpAvg = newAverage(up, buyUp);
    const newDownAvg = newAverage(down, buyDown);

    if ((newUpAvg + newDownAvg) > oldSum + config.sumTolerance) {
        return { buyUp: 0, buyDown: 0, reason: "EV reject (sumAvg worse)" };
    }

    return { buyUp, buyDown, reason: "valid_buy" };
}

function computeCorrectionV6(up: Position, down: Position, config: Config) {
    let buyUp = 0;
    let buyDown = 0;
    const cost = up.size * up.avgPrice + down.size * down.avgPrice
    const upPnL = up.size - cost
    const downPnL = down.size - cost

    // ---------- 0) 价格合理性检验 ----------
    if (
        up.curPrice <= config.priceLowerBound || up.curPrice >= config.priceUpperBound ||
        down.curPrice <= config.priceLowerBound || down.curPrice >= config.priceUpperBound
    ) {
        return { buyUp: 0, buyDown: 0, cost, upPnL, downPnL, reason: "invalid price (illiquid/no price)" };
    }

    const oldAvgSum = up.avgPrice + down.avgPrice;

    // 利润锁定
    if (upPnL > 0 && downPnL > 0 && oldAvgSum < 0.95) {
        const ratio = upPnL / downPnL
        if (ratio > 0.9 && ratio < 1.1) {
            return { buyUp: 0, buyDown: 0, cost, upPnL, downPnL, reason: "Locking in profits" };
        }
    }

    // ---------- 敞口逻辑 ----------
    const upExp = exposure(up);
    const downExp = exposure(down);
    const ratio = upExp / Math.max(1e-12, downExp);

    // --- 检查价格是否低于均价 ---
    const upCheap = up.curPrice < up.avgPrice - config.opportunisticDelta;
    const downCheap = down.curPrice < down.avgPrice - config.opportunisticDelta;

    // --- 机会性买入（优先级 1） ---
    if (downCheap && down.size < cost * 1.5) {
        buyDown += (down.avgPrice - down.curPrice) * down.size * config.buyPressure;
    }
    if (upCheap && up.size < cost * 1.5) {
        buyUp += (up.avgPrice - up.curPrice) * up.size * config.buyPressure;
    }

    // --- 敞口校正（仅在价格低廉的情况下） --- 
    if (ratio > config.exposureMax) {
        buyDown += ((ratio - config.exposureTarget) / ratio) * down.size * config.buyPressure;
    }
    if (ratio < config.exposureMin) {
        buyUp += ((1 / ratio - 1 / config.exposureTarget) * up.size * config.buyPressure);
    }

    // ---------- 预算执行 ----------
    const budgetRemaining = Math.max(0, config.maxCapital - cost);
    if (budgetRemaining <= 0) return { buyUp: 0, buyDown: 0, cost, upPnL, downPnL, reason: "budget exhausted" };

    const maxStepBudget = budgetRemaining * config.maxStepPercent; // e.g. 5% step allocation
    const maxUpQty = maxStepBudget / up.curPrice;
    const maxDownQty = maxStepBudget / down.curPrice;

    buyUp = Math.min(buyUp, maxUpQty);
    buyDown = Math.min(buyDown, maxDownQty);

    if (buyUp < config.minBuySize && buyDown < config.minBuySize)
        return { buyUp: 0, buyDown: 0, cost, upPnL, downPnL, reason: `too small after budget scaling===${ratio},${buyUp}/${buyDown},${maxUpQty}/${maxDownQty}` };

    // ---------- EV 保护：sumAvg 不能恶化 ----------
    const newUpAvg = newAverage(up, buyUp);
    const newDownAvg = newAverage(down, buyDown);

    if ((newUpAvg + newDownAvg) > oldAvgSum + config.sumTolerance) {
        return { buyUp: 0, buyDown: 0, cost, upPnL, downPnL, reason: `EV reject (sumAvg worse) newUpAvg: ${newUpAvg}, newDownAvg: ${newDownAvg}, oldAvgSum: ${oldAvgSum}` };
    }

    // ---------- 利润平衡 ----------
    // if (buyUp > 0) {
    //     if (buyUp + up.size > down.size) {
    //         buyUp = down.size - up.size
    //         buyUp = buyUp < 0 ? 0 : buyUp
    //     }
    // }
    // if (buyDown > 0) {
    //     if (buyDown + down.size > up.size) {
    //         buyDown = up.size - down.size
    //         buyDown = buyDown < 0 ? 0 : buyDown
    //     }
    // }

    return { buyUp, buyDown, cost, upPnL, downPnL, reason: "valid_buy" };
}




/* ---------------------------------------------------------
   订单规划：将计划买入拆分成小块，
   检查所需资金，强制执行最大资金限制
   --------------------------------------------------------- */
type PlannedChunk = { outcome: Outcome; qty: number; price: number; usdc: number };

function planChunks(buyUp: number, buyDown: number, upPrice: number, downPrice: number, cfg: Config): PlannedChunk[] {
    const chunks: PlannedChunk[] = [];
    if (buyUp > 0) {
        const qtyPerChunk = buyUp / cfg.splitIntoChunks;
        for (let i = 0; i < cfg.splitIntoChunks; i++) {
            chunks.push({ outcome: 'Up', qty: qtyPerChunk, price: upPrice, usdc: qtyPerChunk * upPrice });
        }
    }
    if (buyDown > 0) {
        const qtyPerChunk = buyDown / cfg.splitIntoChunks;
        for (let i = 0; i < cfg.splitIntoChunks; i++) {
            chunks.push({ outcome: 'Down', qty: qtyPerChunk, price: downPrice, usdc: qtyPerChunk * downPrice });
        }
    }
    return chunks;
}

/* ---------------------------------------------------------
   初始仓位建立逻辑
   --------------------------------------------------------- */

// 市场状态评估接口
type MarketState = {
    currentPrices: { upPrice: number; downPrice: number };
    volatility: number;
    liquidity: number;
    spread: number;
    isSuitable: boolean;
};

// 初始仓位计算结果
type InitialPosition = {
    upQty: number;
    downQty: number;
    totalCost: number;
};

/**
 * 评估市场状态是否适合建立初始仓位
 */
async function assessMarketState(market: any, config: Config, priceManager: PriceManager): Promise<MarketState> {
    try {
        // 优先使用价格管理器获取当前价格
        let currentPrices: { upPrice: number; downPrice: number } | null = null;

        const upPrice = priceManager.getCurrentPrice(market.clobTokenIds[0])
        const downPrice = priceManager.getCurrentPrice(market.clobTokenIds[1])
        currentPrices = {
            upPrice: upPrice?.bestAsk.price ?? 0,
            downPrice: downPrice?.bestAsk.price ?? 0
        }

        // 计算价差
        const spread = Math.abs(currentPrices.upPrice - currentPrices.downPrice);

        // 获取历史价格计算波动性（TODO: 获取市场标的的过去15分钟的波动率）
        const volatility = 0.03; // 占位符，实际需要从历史数据计算

        // 评估流动性
        const liquidity = market.liquidityNum ?? 0;

        // console.log("spread: ", spread, "upPrice: ", currentPrices.upPrice, "downPrice: ", currentPrices.downPrice)
        return {
            currentPrices,
            volatility,
            liquidity,
            spread,
            isSuitable: spread <= config.maxInitialSpread &&
                liquidity >= config.minInitialLiquidity &&
                volatility >= config.volatilityThreshold &&
                (currentPrices.upPrice !== 0 && currentPrices.downPrice !== 0)
        };
    } catch (error) {
        console.error('评估市场状态失败:', error);
        throw error;
    }
}

/**
 * 计算初始仓位
 */
function calculateInitialPosition(
    marketState: MarketState,
    availableCapital: number,
    config: Config
): InitialPosition {

    const { upPrice, downPrice } = marketState.currentPrices;
    const initialCapital = availableCapital * config.initialCapitalRatio;

    // 策略1: 完全平衡初始仓位
    if (config.initialPositionMode === 'Average') {
        // 平均分配资金
        const capitalPerSide = initialCapital / 2;
        const upQty = capitalPerSide / upPrice;
        const downQty = capitalPerSide / downPrice;

        return {
            upQty,
            downQty,
            totalCost: initialCapital
        };
    }
    // 策略2: 高价格占40%
    else if (config.initialPositionMode === 'High') {
        const max = Math.max(upPrice, downPrice)
        let upWeight = 0.5, downWeight = 0.5;
        if (upPrice === max) {
            upWeight = 0.4
            downWeight = 0.6
        } else if (downPrice === max) {
            upWeight = 0.6
            downWeight = 0.4
        }
        return {
            upQty: upWeight * initialCapital / upPrice,
            downQty: downWeight * initialCapital / downPrice,
            totalCost: initialCapital
        };
    }
    // 策略3: 低价格占40%
    else if (config.initialPositionMode === 'Low') {
        const max = Math.max(upPrice, downPrice)
        let upWeight = 0.5, downWeight = 0.5;
        if (upPrice === max) {
            upWeight = 0.6
            downWeight = 0.4
        } else if (downPrice === max) {
            upWeight = 0.4
            downWeight = 0.6
        }
        return {
            upQty: upWeight * initialCapital / upPrice,
            downQty: downWeight * initialCapital / downPrice,
            totalCost: initialCapital
        };
    }
    // 策略4: 根据价格偏离程度调整权重
    else {
        // 根据价格偏离程度调整权重
        const totalImpliedProb = upPrice + downPrice;
        const upWeight = upPrice / totalImpliedProb;
        const downWeight = downPrice / totalImpliedProb;

        const upCapital = initialCapital * upWeight;
        const downCapital = initialCapital * downWeight;

        return {
            upQty: upCapital / upPrice,
            downQty: downCapital / downPrice,
            totalCost: initialCapital
        };
    }
}

/**
 * 将初始仓位拆分成交易块
 */
function splitInitialPositionToChunks(
    position: InitialPosition,
    currentPrices: { upPrice: number; downPrice: number },
    config: Config
): PlannedChunk[] {
    const chunks: PlannedChunk[] = [];

    // 将上涨仓位分成小块
    if (position.upQty > 0) {
        const upChunks = Math.max(3, Math.floor(config.splitIntoChunks / 2));
        const upQtyPerChunk = position.upQty / upChunks;

        for (let i = 0; i < upChunks; i++) {
            chunks.push({
                outcome: 'Up',
                qty: upQtyPerChunk,
                price: currentPrices.upPrice,
                usdc: upQtyPerChunk * currentPrices.upPrice
            });
        }
    }

    // 将下跌仓位分成小块
    if (position.downQty > 0) {
        const downChunks = Math.max(3, Math.ceil(config.splitIntoChunks / 2));
        const downQtyPerChunk = position.downQty / downChunks;

        for (let i = 0; i < downChunks; i++) {
            chunks.push({
                outcome: 'Down',
                qty: downQtyPerChunk,
                price: currentPrices.downPrice,
                usdc: downQtyPerChunk * currentPrices.downPrice
            });
        }
    }

    return chunks;
}

/**
 * 建立初始仓位
 */
async function establishInitialPosition(
    market: any,
    config: Config,
    availableCapital: number,
    priceManager: PriceManager
): Promise<{ initialPosition: InitialPosition, marketState: MarketState } | null> {

    try {
        console.log('🔍 评估市场状态...');
        const marketState = await assessMarketState(market, config, priceManager);

        if (!marketState.isSuitable) {
            console.log('❌ 市场状态不适合建立初始仓位');
            console.log(`价差: ${marketState.currentPrices.upPrice.toFixed(2)}/${marketState.currentPrices.downPrice.toFixed(2)}=${(marketState.spread * 100).toFixed(2)}% / ${(config.maxInitialSpread * 100).toFixed(2)}%, 流动性: $${marketState.liquidity} / $${config.minInitialLiquidity}, 波动性: ${(marketState.volatility * 100).toFixed(2)}% / ${(config.volatilityThreshold * 100).toFixed(2)}%`);
            return null;
        }

        console.log('✅ 市场状态良好，计算初始仓位...');
        const initialPosition = calculateInitialPosition(marketState, availableCapital, config);

        console.log(`📊 初始仓位计划: Up=${initialPosition.upQty.toFixed(4)} ($${(initialPosition.upQty * marketState.currentPrices.upPrice).toFixed(2)}), Down=${initialPosition.downQty.toFixed(4)} ($${(initialPosition.downQty * marketState.currentPrices.downPrice).toFixed(2)})`);

        // 分批建立仓位
        console.log('🚀 开始建立初始仓位...');
        const chunks = splitInitialPositionToChunks(initialPosition, marketState.currentPrices, config);

        let successCount = 0;
        for (const chunk of chunks) {
            try {
                await executeTrade(
                    market,
                    chunk.outcome,
                    chunk.qty,
                    chunk.price,
                    config.dryRun
                );
                successCount++;

                // 小延迟避免市场冲击
                await new Promise(res => setTimeout(res, 500 + Math.random() * 500));
            } catch (error) {
                console.error(`执行初始仓位块失败:`, chunk, error);
            }
        }

        if (successCount > 0) {
            console.log(`✅ 初始仓位建立完成 (${successCount}/${chunks.length} 成功)`);
            return { initialPosition, marketState };
        } else {
            console.log('❌ 初始仓位建立失败');
            return null;
        }

    } catch (error) {
        console.error('❌ 建立初始仓位失败:', error);
        return null;
    }
}

/* ---------------------------------------------------------
   执行辅助函数和Polymarket集成的占位符
   --------------------------------------------------------- */
export async function fetchMarketBySlug(slug: string) {
    const url = `https://gamma-api.polymarket.com/markets/slug/${slug}?include_tag=true`
    try {
        console.debug(`fetchMarketBySlug url: ${url}`)
        const response = await fetchWithProxy(url, {}, process.env.SOCKS_PROXY);
        if (!response.ok) throw new Error(`Data API failed: ${response.status}`);
        const data = await response.json() as any;
        if (data) {
            data.clobTokenIds = (typeof data.clobTokenIds === 'string') ? JSON.parse(data.clobTokenIds) : data.clobTokenIds;
            data.outcomes = (typeof data.outcomes === 'string') ? JSON.parse(data.outcomes) : data.outcomes;
        }
        return data
    } catch (e) {
        console.error("fetchMarketBySlug error:", e)
    }
    return null
}
/**
 * 占位符：获取市场ID的市场头寸。
 * 请替换为对Polymarket数据API/positions端点的API调用。
 */
async function fetchMarketPositions(conditionId: string, funderAddress: string): Promise<MarketSnapshot> {
    if (ethers.utils.isAddress(funderAddress)) {
        try {
            const params = new URLSearchParams({
                sizeThreshold: '0',
                limit: '10',
                sortBy: 'TOKENS',
                sortDirection: 'DESC',
                market: conditionId,
                user: funderAddress
            })
            const url = `https://data-api.polymarket.com/positions?${params.toString()}`
            console.debug(`searchPositions url: ${url}`)
            const response = await fetchWithProxy(url, {}, process.env.SOCKS_PROXY);
            if (!response.ok) throw new Error(`Data API failed: ${response.status}`);
            const data = await response.json() as any[];
            if (data) {
                const upPos = data.find((item) => item.outcome === "Up" && item.conditionId === conditionId)
                const downPos = data.find((item) => item.outcome === "Down" && item.conditionId === conditionId)
                const pos = {
                    conditionId,
                    up: {
                        tokenId: null,
                        outcome: null,
                        size: 0,
                        avgPrice: 0,
                        curPrice: 0,
                    },
                    down: {
                        tokenId: null,
                        outcome: null,
                        size: 0,
                        avgPrice: 0,
                        curPrice: 0,
                    },
                    timestamp: Date.now()
                }
                if (upPos) {
                    pos.up.tokenId = upPos.asset;
                    pos.up.outcome = upPos.outcome;
                    pos.up.size = upPos.size;
                    pos.up.avgPrice = upPos.avgPrice;
                    pos.up.curPrice = upPos.curPrice;
                }
                if (downPos) {
                    pos.down.tokenId = downPos.asset;
                    pos.down.outcome = downPos.outcome;
                    pos.down.size = downPos.size;
                    pos.down.avgPrice = downPos.avgPrice;
                    pos.down.curPrice = downPos.curPrice;
                }
                return pos;
            }
        } catch (e) {
            console.error("searchPositions error:", e)
        }
    }
    return {
        up: {
            tokenId: null,
            outcome: null,
            size: 0,
            avgPrice: 0,
            curPrice: 0,
        },
        down: {
            tokenId: null,
            outcome: null,
            size: 0,
            avgPrice: 0,
            curPrice: 0,
        },
        timestamp: Date.now()
    }
}

/**
 * 占位符：在Polymarket上执行买入订单（或下REST订单）。
 * 在此处实现钱包签名和链上发送。
 */
async function executeTrade(market: any, outcome: Outcome, qty: number, maxPrice: number, dryRun: boolean) {
    if (dryRun) {
        console.log(`[dry-run] would execute buy ${qty.toFixed(4)} ${outcome} @ <= ${maxPrice.toFixed(4)}`);
        return { success: true, tx: null };
    }
    // 使用您的钱包/签名者实现实际的交易逻辑
    // 例如使用polymarket data-api或通过ethers.js进行链上合约交互。
    throw new Error('executeTrade not implemented — please implement using your wallet/signer');
}

/* ---------------------------------------------------------
   主控制循环
   --------------------------------------------------------- */
class Balancer {
    private cfg: Config;
    private addTimestamps: number[] = []; // 窗口内执行的添加操作的时间戳
    private usedCapital = 0;
    private totalCapital: number;
    private isInitialized: boolean = false;
    private priceManager: PriceManager;
    private priceUpdateUnsubscribe: (() => void) | null = null;
    private market: any;
    private currentPriceData: { upPrice: number, downPrice: number };
    private positions: MarketSnapshot;

    constructor(cfg: Config, initPosMode?: InitialPositionMode) {
        this.cfg = cfg;
        if (initPosMode) {
            this.cfg.initialPositionMode = initPosMode
        }
        this.totalCapital = this.cfg.maxCapital;
        this.priceManager = new PriceManager();
        this.currentPriceData = { upPrice: 0, downPrice: 0 }
        this.positions = this.defaultPositions()
    }

    private defaultPositions() {
        this.positions = {
            up: {
                tokenId: null,
                outcome: null,
                size: 0,
                avgPrice: 0,
                curPrice: 0
            },
            down: {
                tokenId: null,
                outcome: null,
                size: 0,
                avgPrice: 0,
                curPrice: 0
            },
            timestamp: Date.now()
        }
        return this.positions
    }


    private pruneWindow(now: number) {
        const cutoff = now - this.cfg.addsWindowMs;
        this.addTimestamps = this.addTimestamps.filter((t) => t >= cutoff);
    }

    private canAddMore(): boolean {
        this.pruneWindow(Date.now());
        return this.addTimestamps.length < this.cfg.maxAddsPerWindow;
    }

    private recordAdd() {
        this.addTimestamps.push(Date.now());
    }

    private checkPriceAnomaly(chunk: PlannedChunk, marketUpPrice: number, marketDownPrice: number) {
        const marketPrice = chunk.outcome === 'Up' ? marketUpPrice : marketDownPrice;
        const diff = Math.abs(chunk.price - marketPrice) / (marketPrice + 1e-12);
        return diff <= this.cfg.priceJumpThresholdPct;
    }

    /**
     * 检查是否已有仓位
     */
    private async hasExistingPositions(): Promise<boolean> {
        if (this.cfg.dryRun) {
            return this.positions.down.size > 0 || this.positions.up.size > 0
        } else {
            try {
                const slug = `${this.cfg.marketSlug}-${roundTo15Minutes()}`
                const existingPositions = await fetchMarketPositions(slug, this.cfg.funderAddress);
                return existingPositions.up.size > 0 || existingPositions.down.size > 0;
            } catch (error) {
                console.log('📝 无法获取现有仓位信息，假设需要建立初始仓位');
                return false;
            }
        }
    }

    /**
     * 初始化 WebSocket 连接
     */
    private async initializeWebSocket(): Promise<void> {
        try {
            this.priceManager.subscribeToMarket(this.market.clobTokenIds)
            await this.priceManager.connect();

            // 订阅价格更新
            this.priceUpdateUnsubscribe = this.priceManager.subscribe((priceData) => {
                if (!priceData || !this.market) return

                if (priceData.market === this.market.conditionId) {
                    const tokenIndex = this.market.clobTokenIds.findIndex((item: any) => item === priceData.tokenId)
                    if (tokenIndex === 0) {
                        this.currentPriceData.upPrice = priceData.bestAsk.price
                    } else if (tokenIndex === 1) {
                        this.currentPriceData.downPrice = priceData.bestAsk.price
                    }
                }
            });

            // 等待初始价格数据
            let attempts = 0;
            while ((this.currentPriceData.upPrice === 0 || this.currentPriceData.downPrice === 0) && attempts < 10) {
                console.log('⏳ 等待价格数据...');
                await new Promise(resolve => setTimeout(resolve, 1000));
                attempts++;
            }
        } catch (error) {
            console.error('❌ WebSocket 初始化失败:', error);
            throw error;
        }
    }

    /**
     * 初始化策略
     */
    async initialize(): Promise<boolean> {
        if (this.isInitialized) {
            console.info('⚠️ 策略已经初始化');
            return true;
        }

        console.info('🎯 开始初始化策略...');

        if (!this.market) {
            this.market = await fetchMarketBySlug(`${this.cfg.marketSlug}${roundTo15Minutes()}`)
        }

        // 初始化 WebSocket 连接
        try {
            await this.initializeWebSocket();
        } catch (error) {
            console.error('❌ WebSocket 初始化失败:', error);
            return false
        }

        // 检查是否已有仓位
        const hasPositions = await this.hasExistingPositions();

        if (hasPositions) {
            console.log('📈 发现现有仓位，跳过初始建立');
            this.isInitialized = true;
            return true;
        }

        console.log('📝 没有现有仓位，开始建立初始仓位');

        // 建立初始仓位
        const initial = await establishInitialPosition(
            this.market,
            this.cfg,
            this.totalCapital,
            this.priceManager
        );

        if (initial) {
            this.isInitialized = true;
            this.positions = {
                up: {
                    tokenId: this.market.clobTokenIds[0],
                    outcome: this.market.outcomes[0],
                    size: initial.initialPosition.upQty,
                    avgPrice: initial.marketState.currentPrices.upPrice,
                    curPrice: initial.marketState.currentPrices.upPrice
                },
                down: {
                    tokenId: this.market.clobTokenIds[1],
                    outcome: this.market.outcomes[1],
                    size: initial.initialPosition.downQty,
                    avgPrice: initial.marketState.currentPrices.downPrice,
                    curPrice: initial.marketState.currentPrices.downPrice
                },
                timestamp: Date.now()
            }
            console.log('🎉 策略初始化完成');
        } else {
            console.log('❌ 策略初始化失败，将在下次尝试');
            this.cleanup()
            return false
        }

        return true;
    }

    async stepOnce() {
        // 1) 获取头寸和价格
        let snapshot = this.positions
        try {
            if (!this.cfg.dryRun) {
                const slug = `${this.cfg.marketSlug}${roundTo15Minutes()}`
                snapshot = await fetchMarketPositions(slug, this.cfg.funderAddress);
            }
        } catch (err) {
            console.error('Failed to fetch positions:', err);
            return { upPnL: 0, downPnL: 0 };
        }

        // 优先使用 WebSocket 价格数据
        const prices = this.currentPriceData
        const up = snapshot.up;
        const down = snapshot.down;
        up.curPrice = prices.upPrice
        down.curPrice = prices.downPrice
        if (this.cfg.verbose) {
            const totalCost = up.size * up.avgPrice + down.size * down.avgPrice
            console.info(`snapshot: newPrice=${up.curPrice}/${down.curPrice}, AVG:${up.avgPrice.toFixed(2)}+${down.avgPrice.toFixed(2)}=${(up.avgPrice + down.avgPrice).toFixed(2)}, Size=${up.size.toFixed(2)}/${down.size.toFixed(2)}, Exp=${exposure(up).toFixed(2)}/${exposure(down).toFixed(2)}, Cost=${totalCost.toFixed(2)}, PnL=${(up.size - totalCost).toFixed(2)}/${(down.size - totalCost).toFixed(2)}`);
        }

        // 2) 计算修正
        const { buyUp, buyDown, reason, cost, upPnL, downPnL } = computeCorrectionV6(up, down, this.cfg);
        if (this.cfg.verbose) {
            console.log(`computeCorrection => buyUp=${buyUp.toFixed(4)} buyDown=${buyDown.toFixed(4)} reason=${reason}`);
        }
        if (buyUp <= 0 && buyDown <= 0) return { upPnL, downPnL };

        // 这里直接添加position,实盘时才需要真实下单
        if (this.cfg.dryRun) {
            this.positions.up.avgPrice = (this.positions.up.avgPrice * this.positions.up.size + buyUp * prices.upPrice) / (this.positions.up.size + buyUp)
            this.positions.up.size += buyUp
            this.positions.down.avgPrice = (this.positions.down.avgPrice * this.positions.down.size + buyDown * prices.downPrice) / (this.positions.down.size + buyDown)
            this.positions.down.size += buyDown
            console.info(`[dryRun] position==== UPSize:${(this.positions.up.size).toFixed(2)}, UPAVG:${(this.positions.up.avgPrice).toFixed(2)} DOWNSize:${this.positions.down.size.toFixed(2)}, DOWNAVG:${this.positions.down.avgPrice.toFixed(2)}, AVG:${(this.positions.down.avgPrice + this.positions.up.avgPrice).toFixed(2)}, COST:${cost.toFixed(2)}`)
        } else {
            // 3) 规划分块
            const chunks = planChunks(buyUp, buyDown, prices.upPrice, prices.downPrice, this.cfg);

            // 4) 强制执行资金限制
            const totalUsdcPlanned = chunks.reduce((s, c) => s + c.usdc, 0);
            if (this.usedCapital + totalUsdcPlanned > this.cfg.maxCapital) {
                console.warn('Would exceed max capital per market. Skipping or scaling down.');
                // 简单策略：按比例缩小
                const scale = Math.max(0, (this.cfg.maxCapital - this.usedCapital) / totalUsdcPlanned);
                if (scale <= 0) {
                    console.warn('No capital left for this market in this run.');
                    return { upPnL, downPnL };
                }
                for (const c of chunks) {
                    c.qty *= scale;
                    c.usdc *= scale;
                }
            }

            // 5) 执行分块并进行检查：价格异常、添加窗口
            for (const chunk of chunks) {
                if (!this.canAddMore()) {
                    console.warn('Max adds per window reached; aborting remaining chunks.');
                    break;
                }
                // 价格异常检查
                if (!this.checkPriceAnomaly(chunk, prices.upPrice, prices.downPrice)) {
                    console.warn('Price anomaly detected for chunk, skipping:', chunk);
                    continue;
                }
                // 执行交易
                try {
                    await executeTrade(this.market, chunk.outcome, chunk.qty, chunk.price, this.cfg.dryRun);
                    this.usedCapital += chunk.usdc;
                    this.recordAdd();
                    if (this.cfg.verbose) {
                        console.log(`Executed chunk: ${chunk.outcome} qty=${chunk.qty.toFixed(4)} usdc=${chunk.usdc.toFixed(4)}`);
                    }
                } catch (err) {
                    console.error('executeTrade failed for chunk', chunk, err);
                }
                // 分块之间可选的小延迟以避免突发
                await new Promise((res) => setTimeout(res, 200 + Math.random() * 200));
            }
        }
        return { upPnL, downPnL }
    }

    async runLoop() {
        // 先初始化
        console.log('🚀 启动策略循环...');
        let PnL: { upPnL: number, downPnL: number } = { upPnL: 0, downPnL: 0 }
        while (true) {
            try {
                // 如果未初始化，尝试初始化
                if (!this.isInitialized) {
                    await this.initialize();
                    await new Promise((res) => setTimeout(res, this.cfg.pollingIntervalMs));
                }

                // 如果已初始化，执行正常的平衡逻辑
                if (this.isInitialized) {
                    PnL = await this.stepOnce();
                    await new Promise((res) => setTimeout(res, 1_000));
                }
                if (this.market) {
                    const endDate = new Date(this.market.endDate)
                    if (endDate.getTime() < Date.now()) {
                        const { upPrice, downPrice } = this.currentPriceData
                        this.market = null
                        this.isInitialized = false
                        this.currentPriceData = { upPrice: 0, downPrice: 0 }
                        this.defaultPositions()
                        this.cleanup()
                        console.warn('🚨 策略已停止，因为市场已结束', "upPnL:", PnL.upPnL, "downPnL:", PnL.downPnL, "upPrice:", upPrice, "downPrice:", downPrice)
                    }
                }
            } catch (err) {
                console.error('Unhandled error in runLoop:', err);
            }

        }
    }

    /**
     * 清理资源
     */
    cleanup(): void {
        if (this.priceUpdateUnsubscribe) {
            this.priceUpdateUnsubscribe();
            this.priceUpdateUnsubscribe = null;
        }
        this.priceManager.disconnect();
        this.currentPriceData = { upPrice: 0, downPrice: 0 }
        this.market = null
        console.log('🧹 资源清理完成');
    }
}

/* ---------------------------------------------------------
   导出 / CLI 启动
   --------------------------------------------------------- */

if (require.main === module) {
    const cfg = { ...defaultConfig };
    // 允许使用环境变量覆盖（示例）
    if (process.env.MARKET_SLUG) cfg.marketSlug = process.env.MARKET_SLUG;
    if (process.env.DRY_RUN === 'false') cfg.dryRun = false;

    if (process.env.INIT_POS_MODE) {
        const balancer = new Balancer(cfg, process.env.INIT_POS_MODE as InitialPositionMode);
        balancer.runLoop().catch((e) => console.error('Fatal error', e));
    } else {
        const balancer = new Balancer(cfg);
        balancer.runLoop().catch((e) => console.error('Fatal error', e));
    }

}

export {
    Balancer,
    PriceManager,
    planChunks,
    exposure,
    newAverage,
    defaultConfig,
    assessMarketState,
    calculateInitialPosition,
    establishInitialPosition,
};
