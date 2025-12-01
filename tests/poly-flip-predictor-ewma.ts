import { SocksProxyAgent } from 'socks-proxy-agent'
import WebSocket from 'ws'

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, "../.env") });

import { initEncryptor } from "../src/config";
initEncryptor()

import { fetchWithProxy, sleep } from '../src/utils/helper'
import { fetchCryptoPrice } from '../src/polymarket'


/**
 * 动态扫尾盘策略（带 EWMA 短期波动率）
 */

/////////////////////
// 工具函数
/////////////////////

export function erf(x: number): number {
    const a1 = 0.254829592
    const a2 = -0.284496736
    const a3 = 1.421413741
    const a4 = -1.453152027
    const a5 = 1.061405429
    const p = 0.3275911

    const sign = x < 0 ? -1 : 1
    const absX = Math.abs(x)
    const t = 1.0 / (1.0 + p * absX)
    const y =
        1.0 -
        (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) *
        t *
        Math.exp(-absX * absX)

    return sign * y
}

export function normalCDF(x: number): number {
    return 0.5 * (1 + erf(x / Math.sqrt(2)))
}

/////////////////////
// 波动率计算
/////////////////////

/**
 * 对数收益
 */
export function computeReturns(prices: number[]): number[] {
    const returns: number[] = []
    for (let i = 1; i < prices.length; i++) {
        returns.push(Math.log(prices[i] / prices[i - 1]))
    }
    return returns
}

/**
 * EWMA波动率计算
 * @param prices 最近价格数组（按固定 Δt 秒采样）
 * @param lambda EWMA 衰减因子，0~1，越接近1记忆越长
 * @returns 每 Δt 的价格波动 σ_price
 */
export function computeVolatilityEWMA(prices: number[], lambda: number = 0.98): number {
    const logReturns = computeReturns(prices)
    if (logReturns.length === 0) return 0

    // 初始化 EWMA 方差为第一个 log return 平方
    let s2 = logReturns[0] ** 2

    for (let i = 1; i < logReturns.length; i++) {
        s2 = lambda * s2 + (1 - lambda) * logReturns[i] ** 2
    }

    const sigma_log = Math.sqrt(s2)          // 对数收益波动率
    const P_now = prices[prices.length - 1]
    const sigma_price = P_now * sigma_log     // 转换为价格单位
    return sigma_price
}

/////////////////////
// 动态扫尾盘概率计算
/////////////////////

/**
 * 剩余时间结束价格大于开盘价概率
 */
export function probEndAboveOpen(
    P_start: number,
    P_now: number,
    sigma: number,
    remainingT: number
): number {
    const sigma_T = sigma * Math.sqrt(remainingT)
    const delta = P_start - P_now
    const prob = 1 - normalCDF(delta / sigma_T)
    return prob
}

/**
 * 动态扫尾盘判断（使用 EWMA 波动率）
 */
export function checkSweepEWMA(
    P_start: number,
    P_now: number,
    prices: number[],
    remainingT: number,
    p_limit: number = 0.01,
    lambda: number = 0.98
): { shouldSweep: boolean; direction: 'UP' | 'DOWN' | null; probUp: number; sigma: number } {
    const sigma = computeVolatilityEWMA(prices, lambda)
    const probUp = probEndAboveOpen(P_start, P_now, sigma, remainingT)

    let shouldSweep = false
    let direction: 'UP' | 'DOWN' | null = null

    if (probUp > 1 - p_limit) {
        shouldSweep = true
        direction = 'UP'
    } else if (probUp < p_limit) {
        shouldSweep = true
        direction = 'DOWN'
    }

    return { shouldSweep, direction, probUp, sigma }
}

// -------------------- FlipPredictor 类 --------------------
type PricePoint = { ts: number /* seconds */, price: number }

/**
 * 预测市场优化器 - 针对 Polymarket 特点的优化
 */
export class PredictionMarketOptimizer {
    
    /**
     * 根据市场微观结构优化概率预测
     * @param rawProbability 原始概率预测
     * @param volatility 当前波动率
     * @param timeRemaining 剩余时间
     * @param marketImpliedProb Polymarket 市场隐含概率（可选）
     */
    public optimizeProbability(
        rawProbability: number,
        volatility: number,
        timeRemaining: number,
        marketImpliedProb?: number
    ): OptimizedResult {
        // 1. 时间衰减调整 - 越接近结束，越需要高确定性
        const timeAdjustment = this.calculateTimeAdjustment(timeRemaining)
        
        // 2. 波动率调整 - 高波动时降低信心
        const volatilityAdjustment = this.calculateVolatilityAdjustment(volatility)
        
        // 3. 市场共识调整（如果有市场隐含概率）
        const consensusAdjustment = marketImpliedProb ? 
            this.calculateConsensusAdjustment(rawProbability, marketImpliedProb) : 1
        
        // 4. 综合调整因子
        const totalAdjustment = timeAdjustment * volatilityAdjustment * consensusAdjustment
        
        // 5. 应用调整
        const adjustedProbability = this.applyProbabilityAdjustment(rawProbability, totalAdjustment)
        
        // 6. 计算信心度
        const confidence = this.calculateConfidence(
            adjustedProbability, volatility, timeRemaining, consensusAdjustment
        )
        
        return {
            adjustedProbability,
            confidence,
            timeAdjustment,
            volatilityAdjustment,
            consensusAdjustment,
            shouldTrade: confidence > 0.7 && this.isProbabilityInTradeZone(adjustedProbability)
        }
    }
    
    /**
     * 时间衰减调整 - 剩余时间越少，要求越高确定性
     */
    private calculateTimeAdjustment(timeRemaining: number): number {
        // 15分钟 = 900秒基准
        const timeRatio = Math.max(0.1, timeRemaining / 900)
        // 时间越少，调整越保守（趋向0.5）
        return 0.5 + 0.5 * timeRatio
    }
    
    /**
     * 波动率调整 - 高波动时降低预测信心
     */
    private calculateVolatilityAdjustment(volatility: number): number {
        // 波动率 > 2% 时开始降低信心
        if (volatility > 0.02) {
            return Math.max(0.3, 1 - (volatility - 0.02) * 20)
        }
        return 1
    }
    
    /**
     * 市场共识调整 - 考虑与市场隐含概率的差异
     */
    private calculateConsensusAdjustment(ourProb: number, marketProb: number): number {
        const diff = Math.abs(ourProb - marketProb)
        // 与市场差异越大，调整越保守
        if (diff > 0.2) {
            return Math.max(0.5, 1 - (diff - 0.2) * 2)
        }
        return 1
    }
    
    /**
     * 应用概率调整
     */
    private applyProbabilityAdjustment(probability: number, adjustment: number): number {
        // 向0.5（中性）调整
        const neutralPoint = 0.5
        const distance = probability - neutralPoint
        const adjustedDistance = distance * adjustment
        return neutralPoint + adjustedDistance
    }
    
    /**
     * 计算综合信心度
     */
    private calculateConfidence(
        probability: number,
        volatility: number,
        timeRemaining: number,
        consensusAdjustment: number
    ): number {
        // 基于概率偏离度
        const probabilityDeviation = Math.abs(probability - 0.5) * 2
        
        // 时间因子
        const timeFactor = Math.min(1, timeRemaining / 900)
        
        // 波动率惩罚
        const volatilityPenalty = Math.max(0.1, 1 - volatility * 30)
        
        // 共识因子
        const consensusFactor = consensusAdjustment
        
        return probabilityDeviation * timeFactor * volatilityPenalty * consensusFactor
    }
    
    /**
     * 判断是否在交易区域
     */
    private isProbabilityInTradeZone(probability: number): boolean {
        // 只有在极值区域才考虑交易
        return probability > 0.85 || probability < 0.15
    }
}

// 优化结果接口
interface OptimizedResult {
    adjustedProbability: number
    confidence: number
    timeAdjustment: number
    volatilityAdjustment: number
    consensusAdjustment: number
    shouldTrade: boolean
}

// 增强的结果类型
interface EnhancedSweepResult {
    shouldSweep: boolean
    direction: 'UP' | 'DOWN' | null
    probUp: number
    sigma: number
    adjustedProbability: number
    confidence: number
    shouldTrade: boolean
    timeAdjustment?: number
    volatilityAdjustment?: number
    consensusAdjustment?: number
}

export class FlipPredictor {
    private prices: PricePoint[] = [] // 最近1分钟价格窗口
    private windowSeconds = 60
    public openPrice: number
    public endTimeSec: number // epoch seconds
    private optimizer = new PredictionMarketOptimizer()

    // 可调整参数
    public enableOptimization = true // 是否启用预测市场优化

    constructor(openPrice: number, endTimeSec: number) {
        this.openPrice = openPrice
        this.endTimeSec = endTimeSec
    }

    // 插入新价格（price，timestamp可选默认 now）
    public pushPrice(price: number, tsSec?: number) {
        const ts = tsSec ?? Math.floor(Date.now() / 1000)
        this.prices.push({ ts, price })
        this.evictOld(ts)
    }



    // 清理超过窗口的价格点
    private evictOld(nowSec: number) {
        const cutoff = nowSec - this.windowSeconds
        // 保留 >= cutoff 的点（时间按秒）
        this.prices = this.prices.filter((p) => p.ts >= cutoff)
    }



    // 执行一次检查：打印并判断是否扫盘（prob < threshold）
    public checkAndReport(currentPrice?: number, marketImpliedProb?: number) {
        if (!currentPrice) return
        const now = Math.floor(Date.now() / 1000)
        if (this.prices.length === 0 || now - this.prices[0].ts < this.windowSeconds) return

        const secondsLeft = this.endTimeSec - now
        if (secondsLeft <= 0) return

        // 使用增强版检查（如果启用了优化）
        let result: EnhancedSweepResult
        if (this.enableOptimization) {
            result = this.checkSweepWithOptimization(currentPrice, secondsLeft, marketImpliedProb)
        } else {
            const basicResult = checkSweepEWMA(this.openPrice, currentPrice, this.prices.map(p => p.price), secondsLeft)
            result = {
                shouldSweep: basicResult.shouldSweep,
                direction: basicResult.direction,
                probUp: basicResult.probUp,
                sigma: basicResult.sigma,
                adjustedProbability: basicResult.probUp,
                confidence: this.calculateBasicConfidence(basicResult.probUp, basicResult.sigma),
                shouldTrade: false
            }
        }

        // currentPrice 若未传则取最新
        const cp = currentPrice ?? (this.prices.length ? this.prices[this.prices.length - 1].price : NaN)

        console.log('-------------------- FlipReport --------------------')
        console.log(`time (UTC secs)   : ${now}`)
        console.log(`openPrice         : ${this.openPrice}`)
        console.log(`currentPrice      : ${cp}`)
        if (marketImpliedProb !== undefined) {
            console.log(`marketImpliedProb  : ${(marketImpliedProb * 100).toFixed(1)}%`)
        }
        console.log(`secondsLeft       : ${secondsLeft}`)
        console.log(`sigma1m (1m std)  : ${result.sigma}`)
        console.log(`rawProbability    : ${(result.probUp * 100).toFixed(3)} %`)
        if (this.enableOptimization) {
            console.log(`adjustedProbability: ${(result.adjustedProbability * 100).toFixed(3)} %`)
            console.log(`confidence        : ${(result.confidence * 100).toFixed(1)} %`)
            console.log(`shouldTrade       : ${result.shouldTrade ? 'YES' : 'NO'}`)
        }
        console.log(`signal            : ${result.shouldSweep} ${result.direction}`)
        console.log('----------------------------------------------------\n')

        return result
    }
    /**
     * 基础信心度计算
     */
    private calculateBasicConfidence(probability: number, volatility: number): number {
        const probabilityDeviation = Math.abs(probability - 0.5) * 2
        const volatilityPenalty = Math.max(0.1, 1 - volatility * 5)
        return probabilityDeviation * volatilityPenalty
    }

    /**
     * 增强的扫尾盘判断（针对预测市场优化）
     */
    private checkSweepWithOptimization(
        currentPrice: number,
        remainingT: number,
        marketImpliedProb?: number
    ): EnhancedSweepResult {
        // 1. 计算原始概率
        const sigma = computeVolatilityEWMA(this.prices.map(p => p.price))
        const rawProbUp = probEndAboveOpen(this.openPrice, currentPrice, sigma, remainingT)
        
        // 2. 使用预测市场优化器
        const optimization = this.optimizer.optimizeProbability(
            rawProbUp, sigma, remainingT, marketImpliedProb
        )
        
        // 3. 生成交易信号（使用优化后的概率）
        let shouldSweep = false
        let direction: 'UP' | 'DOWN' | null = null
        
        // 使用更严格的阈值（考虑优化后的概率）
        if (optimization.adjustedProbability > 0.95) {
            shouldSweep = true
            direction = 'UP'
        } else if (optimization.adjustedProbability < 0.05) {
            shouldSweep = true
            direction = 'DOWN'
        }
        
        return {
            shouldSweep,
            direction,
            probUp: rawProbUp,
            sigma,
            adjustedProbability: optimization.adjustedProbability,
            confidence: optimization.confidence,
            shouldTrade: optimization.shouldTrade,
            timeAdjustment: optimization.timeAdjustment,
            volatilityAdjustment: optimization.volatilityAdjustment,
            consensusAdjustment: optimization.consensusAdjustment
        }
    }


}

function roundTo15Minutes(date = new Date()) {
    const d = new Date(date);
    const minutes = d.getMinutes();
    const floored = Math.floor(minutes / 15) * 15;
    d.setMinutes(floored, 0, 0);
    return d.getTime() / 1000;
}

async function getMarket() {
    const time = roundTo15Minutes()
    const url = `https://gamma-api.polymarket.com/markets?include_tag=true&slug=btc-updown-15m-${time}`
    // console.log("getMarket url:", url)

    try {
        const response = await fetchWithProxy(url, {}, "socks5h://127.0.0.1:1080");
        if (!response.ok) throw new Error(`Data API failed: ${response.status}`);
        const data = await response.json() as any[];
        if (data && data.length > 0) {
            return data[0]
        }
    } catch (e) {
        console.error("getMarket error:", e)
    }
    return null
}

// -------------------- 示例主程序 --------------------
async function main() {
    // ========== 配置 ==========
    // 这里你需要把 openPrice 与 endTime 设置为对应 Polymarket 市场的开盘价与决议时间（秒）
    // 示例：以当前价格为 openPrice，决议时间 15 分钟后（仅示例）
    let openPriceExample = 0 // 例如 30000
    let endTimeSec = 0 // 15 分钟后

    while (openPriceExample === 0) {
        const market = await getMarket()
        if (market) {
            console.log("market:", market.eventStartTime, market.endDate)
            const startTime = new Date(market.eventStartTime)
            const endTime = new Date(market.endDate)
            endTimeSec = endTime.getTime() / 1000

            // 获取开盘价
            const openPrice = await fetchCryptoPrice('BTC', startTime, endTime, 'fifteen')
            console.log("openPrice:",openPrice)
            if (openPrice) {
                openPriceExample = openPrice
            }
        }
        console.log("openPriceExample:", openPriceExample)
        await sleep(5)
    }

    const predictor = new FlipPredictor(openPriceExample, endTimeSec)
    let lastPrice: number | null = null

    // chainlink 价格
    const wsUrl = `wss://ws-live-data.polymarket.com`
    console.log(`connecting to ${wsUrl} ...`)
    const ws = new WebSocket(wsUrl, { agent: new SocksProxyAgent('socks5h://127.0.0.1:1080') as any })

    ws.on('open', () => {
        console.debug(`PolyLive WS connected: ${wsUrl}`);
        ws?.send(JSON.stringify({
            "action": "subscribe",
            "subscriptions": [
                {
                    topic: "crypto_prices_chainlink",
                    type: "update",
                    filters: `[{"symbol":"btc/usd"}]`
                }
            ]
        }))
    })

    ws.on('message', (data) => {
        try {
            const { payload } = JSON.parse(data.toString())
            lastPrice = Number(payload.value) // 保留最新成交价
        } catch (e) {
            // ignore parse errors
        }
    })

    ws.on('error', (err) => {
        console.error('ws error', err)
    })

    ws.on('close', () => {
        console.log('ws closed')
    })

    // 每秒重采样一次价格
    setInterval(() => {
        if (lastPrice !== null) {
            const nowSec = Math.floor(Date.now() / 1000)
            predictor.pushPrice(lastPrice, nowSec)
            
            // 使用优化版检查（可传入市场隐含概率）
            predictor.checkAndReport(lastPrice)
        }
    }, 1000)


    // 为防止程序立即退出（若使用 ws 则不需要）
    process.stdin.resume()
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e)
        process.exit(1)
    })
}

