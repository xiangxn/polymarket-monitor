/**
 * 计算对数收益
 * @param prices 价格列表
 * @returns 
 */
export function computeReturns(prices: number[]) {
    const returns = []
    for (let i = 1; i < prices.length; i++) {
        returns.push(Math.log(prices[i] / prices[i - 1]))
    }
    return returns
}

/**
 * 计算, 对数收益的波动率
 * @param arr 对数收益数组
 * @returns 
 */
export function std(arr: number[]) {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length
    return Math.sqrt(variance)
}

/**
 * 样本标准差
 */
export function stdSample(arr: number[]) {
    const n = arr.length
    if (n < 2) return 0
    const mean = arr.reduce((a, b) => a + b, 0) / n
    const variance = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
    return Math.sqrt(variance)
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

export function secondsLeft(endDate: string) {
    const endMs = new Date(endDate).getTime();
    const now = Date.now();
    return Math.max(0, Math.floor((endMs - now) / 1000));
}

export function erf(x: number): number {
    // Abramowitz-Stegun approximation
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

// 标准正态分布 CDF Φ(x)
export function normalCDF(x: number): number {
    return 0.5 * (1 + erf(x / Math.sqrt(2)))
}