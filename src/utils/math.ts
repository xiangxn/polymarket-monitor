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

export function secondsLeft(endDate: string) {
    const endMs = new Date(endDate).getTime();
    const now = Date.now();
    return Math.max(0, Math.floor((endMs - now) / 1000));
}