/**
 *
 * Usage:
 *  - 编辑 main() 中的 openPrice 与 endTime（或修改为从 Polymarket 获取）
 *  - 选择 useBinance = true 来连接 Binance 实时 trade 流 (btcusdt@trade)
 *  - 或者 useBinance = false 用模拟器产生价格用于测试
 *
 * Run:
 *  ts-node flip-predictor.ts
 */

import { SocksProxyAgent } from 'socks-proxy-agent'
import WebSocket from 'ws'

/**
 * 动态扫尾盘策略
 * 核心：根据当前价格、开盘价格、剩余时间和波动率
 * 计算结束价格大于开盘价的概率，并判断是否扫尾盘
 */

/////////////////////
// 工具函数
/////////////////////

// 样本标准差 (无偏估计)
export function stdSample(arr: number[]): number {
    const n = arr.length
    if (n < 2) return 0
    const mean = arr.reduce((a, b) => a + b, 0) / n
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
    return Math.sqrt(variance)
}

// Abramowitz-Stegun 误差函数近似
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

// 标准正态分布CDF
export function normalCDF(x: number): number {
    return 0.5 * (1 + erf(x / Math.sqrt(2)))
}

/////////////////////
// 波动率计算
/////////////////////

/**
 * 对数收益计算
 * @param prices 价格列表
 * @returns 对数收益数组
 */
export function computeReturns(prices: number[]): number[] {
    const returns: number[] = []
    for (let i = 1; i < prices.length; i++) {
        returns.push(Math.log(prices[i] / prices[i - 1]))
    }
    return returns
}

/**
 * 根据历史价格序列计算短期波动率（单位：价格）
 * @param prices 最近 n 个价格（按 Δt 间隔）
 * @returns σ_price（单位与价格一致）
 */
export function computeVolatility(prices: number[]): number {
    const logReturns = computeReturns(prices)
    const sigma_log = stdSample(logReturns)  // 每 Δt 秒的对数收益波动
    const P_now = prices[prices.length - 1]
    const sigma_price = P_now * sigma_log      // 转换为价格单位
    return sigma_price
}

/////////////////////
// 动态扫尾盘概率计算
/////////////////////

/**
 * 计算结束时价格大于开盘价的概率
 * @param P_start 开盘价
 * @param P_now 当前价格
 * @param sigma 每秒价格波动
 * @param remainingT 剩余时间（秒）
 * @returns 结束价格大于开盘价的概率
 */
export function probEndAboveOpen(
    P_start: number,
    P_now: number,
    sigma: number,
    remainingT: number
): number {
    const sigma_T = sigma * Math.sqrt(remainingT)  // 剩余时间价格标准差
    const delta = P_start - P_now
    const prob = 1 - normalCDF(delta / sigma_T)
    return prob
}

/**
 * 动态扫尾盘判断
 * @param P_start 开盘价
 * @param P_now 当前价格
 * @param prices 最近价格数组（计算波动率）
 * @param remainingT 剩余时间（秒）
 * @param p_limit 容忍概率，例如 0.01
 * @returns shouldSweep 是否扫尾盘, direction 扫尾盘方向
 */
export function checkSweep(
    P_start: number,
    P_now: number,
    prices: number[],
    remainingT: number,
    p_limit: number = 0.01
): { shouldSweep: boolean; direction: 'UP' | 'DOWN' | null; probUp: number; sigma: number } {
    const sigma = computeVolatility(prices)
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

export class FlipPredictor {
    private prices: PricePoint[] = [] // 最近1分钟价格窗口
    private windowSeconds = 60
    public openPrice: number
    public endTimeSec: number // epoch seconds

    // 可调整参数
    public minSamples = 3 // 最少价格点数
    public dynamicThresholdClamp: [number, number] = [0.2, 0.8] // 阈值范围

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
    public checkAndReport(currentPrice?: number) {
        if (!currentPrice) return
        const now = Math.floor(Date.now() / 1000)
        const secondsLeft = this.endTimeSec - now
        const {shouldSweep, direction, probUp, sigma } = checkSweep(this.openPrice, currentPrice, this.prices.map(p => p.price), secondsLeft)

        // currentPrice 若未传则取最新
        const cp = currentPrice ?? (this.prices.length ? this.prices[this.prices.length - 1].price : NaN)

        console.log('-------------------- FlipReport --------------------')
        console.log(`time (UTC secs)   : ${now}`)
        console.log(`openPrice         : ${this.openPrice}`)
        console.log(`currentPrice      : ${cp}`)
        console.log(`secondsLeft       : ${secondsLeft}`)
        console.log(`sigma1m (1m std)  : ${sigma}`)
        console.log(`flipProbability   : ${(probUp * 100).toFixed(3)} %`)
        console.log(`signal            : ${shouldSweep} ${direction}`)
        console.log('----------------------------------------------------\n')

    }
}

// -------------------- 示例主程序 --------------------
async function main() {
    // ========== 配置 ==========
    const useBinance = true // 切换为 false 则启用本地模拟价格（便于测试）
    const symbol = 'btcusdt' // Binance stream 使用

    // 这里你需要把 openPrice 与 endTime 设置为对应 Polymarket 市场的开盘价与决议时间（秒）
    // 示例：以当前价格为 openPrice，决议时间 15 分钟后（仅示例）
    const openPriceExample = 86163.96 // 例如 30000
    const endTimeSec = Math.floor(Date.now() / 1000) + 6 * 60 // 15 分钟后

    const predictor = new FlipPredictor(openPriceExample, endTimeSec)

    if (useBinance) {
        // Binance 公共 trade stream: wss://stream.binance.com:9443/ws/btcusdt@trade
        const wsUrl = `wss://stream.binance.com:9443/ws/${symbol}@trade`
        console.log(`connecting to ${wsUrl} ...`)
        const ws = new WebSocket(wsUrl, { agent: new SocksProxyAgent('socks5h://127.0.0.1:1080') as any })

        ws.on('open', () => {
            console.log('binance ws open')
        })

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString())
                // trade stream 中 price 字段是 "p"
                const price = parseFloat(msg.p)
                const tsSec = Math.floor(msg.T / 1000) // Binance trade has T in ms
                predictor.pushPrice(price, tsSec)
                // 每收到一次价格就做一次检查（你也可以节流，比如每 500ms 检查一次）
                predictor.checkAndReport(price)
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
    } else {
        // 模拟价格（供测试）
        console.log('使用本地价格模拟器(useBinance=false)')
        let price = openPriceExample
        setInterval(() => {
            // 简单随机游走模拟
            price = price * (1 + (Math.random() - 0.5) * 0.001) // ±0.05% 每次
            predictor.pushPrice(price)
            predictor.checkAndReport(price)
        }, 1000)
    }

    // 为防止程序立即退出（若使用 ws 则不需要）
    process.stdin.resume()
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e)
        process.exit(1)
    })
}
