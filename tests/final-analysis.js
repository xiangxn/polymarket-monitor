const fs = require('fs');

// 读取日志文件
const logContent = fs.readFileSync('/Users/necklace/work/Outsourcing/ploymartket/monitor/logs/log-2025-12-10-.log', 'utf8');

// 按行分割
const lines = logContent.trim().split('\n');

// 初始化统计变量
let totalRecords = 0;
let bothPositiveCount = 0;
let upDecisionTotal = 0;  // upPrice是0的记录的upPnL总和
let downDecisionTotal = 0; // downPrice是0的记录的downPnL总和
let upDecisionCount = 0;   // upPrice是0的记录数
let downDecisionCount = 0; // downPrice是0的记录数
let totalVolume = 0;       // 总交易量

// 解析每行数据
lines.forEach((line, index) => {
    // 使用正则表达式提取数值
    const upPnLMatch = line.match(/upPnL:\s*([-]?\d+\.?\d*)/);
    const downPnLMatch = line.match(/downPnL:\s*([-]?\d+\.?\d*)/);
    const upPriceMatch = line.match(/upPrice:\s*([-]?\d+\.?\d*)/);
    const downPriceMatch = line.match(/downPrice:\s*([-]?\d+\.?\d*)/);
    const upCost = line.match(/upCost:\s*([-]?\d+\.?\d*)/)
    const downCost = line.match(/downCost:\s*([-]?\d+\.?\d*)/)

    if (upPnLMatch && downPnLMatch && upPriceMatch && downPriceMatch) {
        totalRecords++;

        const upPnL = parseFloat(upPnLMatch[1]);
        const downPnL = parseFloat(downPnLMatch[1]);
        const upPrice = parseFloat(upPriceMatch[1]);
        const downPrice = parseFloat(downPriceMatch[1]);

        // 统计upPnL与downPnL同时大于0的记录
        if (upPnL > 0 && downPnL > 0) {
            bothPositiveCount++;
        }

        // 根据正确的统计规则
        // 如果upPrice是0，则加上upPnL
        let win = (upPrice === 0 || downPrice === 0) ? Math.min(upPrice, downPrice) : Math.max(upPrice, downPrice)
        if (upPrice === win) {
            upDecisionCount++;
            upDecisionTotal += upPnL;
        }

        // 如果downPrice是0，则加上downPnL
        if (downPrice === win) {
            downDecisionCount++;
            downDecisionTotal += downPnL;
        }
    }

    if (upCost) {
        totalVolume += parseFloat(upCost[1])
    }
    if (downCost) {
        totalVolume += parseFloat(downCost[1])
    }
});

// 计算结果
const bothPositivePercentage = totalRecords > 0 ? (bothPositiveCount / totalRecords * 100).toFixed(2) : 0;
const totalProfitLoss = upDecisionTotal + downDecisionTotal;

// 输出结果
console.log('=== 日志分析结果 ===');
console.log(`总记录数: ${totalRecords}`);
console.log(`upPnL与downPnL同时大于0的记录数: ${bothPositiveCount}`);
console.log(`占比: ${bothPositivePercentage}%`);
console.log('');
console.log('=== 按决议规则统计 ===');
console.log(`upPrice: 0的记录数: ${upDecisionCount}`);
console.log(`downPrice: 0的记录数: ${downDecisionCount}`);
console.log(`up决议总盈亏: ${upDecisionTotal.toFixed(2)}`);
console.log(`down决议总盈亏: ${downDecisionTotal.toFixed(2)}`);
console.log(`总盈亏: ${totalProfitLoss.toFixed(2)}`);
console.log('总交易量', totalVolume.toFixed(2))
console.log('');