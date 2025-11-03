import { Encryptor } from "./utils/encryptor";
import * as readlineSync from 'readline-sync';

let encryptor: Encryptor

export function initEncryptor() {
    // Get password from CLI input (hidden)
    const password = readlineSync.question('Enter startup password: ', {
        hideEchoBack: true
    });
    if (!password) {
        console.error('Password is required');
        process.exit(1);
    }
    encryptor = new Encryptor(password)
}

export const getConfig = () => {
    return {
        HTTPS_PROXY: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) ?? undefined,
        SEARCH_START_HOURS: parseFloat(process.env.SEARCH_START_HOURS ?? "0"),  // 过滤事件结束时间end_date_min
        SEARCH_END_HOURS: parseFloat(process.env.SEARCH_END_HOURS ?? "24"),     // 过滤事件结束时间end_date_max
        MIN_CYCLE_DELAY_MS: parseFloat(process.env.MIN_CYCLE_DELAY_MS ?? "2"),  // 每轮最小间隔

        // 监控
        LISTEN_TAKE_PROFIT: parseFloat(process.env.LISTEN_TAKE_PROFIT ?? "0.4"),
        LISTEN_STOP_LOSS: parseFloat(process.env.LISTEN_STOP_LOSS ?? "0.1"),
        LISTEN_TOKENS: JSON.parse(process.env.LISTEN_TOKENS ?? "[]"),
        TG_API_KEY: process.env.TG_API_KEY ?? "",
        TG_CHAT_ID: process.env.TG_CHAT_ID ?? "",

        // 操作订单
        CHAIN_ID: parseInt(process.env.CHAIN_ID ?? "137"),
        ADDRESS_PRI: encryptor!.decrypt(process.env.ADDRESS_PRI || ''),
        CLOB_API_KEY: encryptor!.decrypt(process.env.CLOB_API_KEY || ''),
        CLOB_SECRET: encryptor!.decrypt(process.env.CLOB_SECRET || ''),
        CLOB_PASS_PHRASE: encryptor!.decrypt(process.env.CLOB_PASS_PHRASE || ''),

        // 策略配置
        MIN_VOLUME: parseFloat(process.env.MIN_VOLUME ?? "10000"),  // 过滤事件最小交易量
        MIN_MARKET_SPREAD: parseFloat(process.env.MIN_MARKET_SPREAD ?? "0.05"),     // 市场价格差,如果是互斥市场就是市场间，如果是二元市场就是市场内yes/no
        ENTER_WINDOW: JSON.parse(process.env.ENTER_WINDOW ?? "[0.8,0.9]"),         // 进入的价格窗口
        KEEP_LAST_TRADE_TIME: parseInt(process.env.KEEP_LAST_TRADE_TIME || '10'),       // 保留最近10s的交易数据
        STOP_LOSS_PERCENTAGE: parseFloat(process.env.STOP_LOSS_PERCENTAGE || '0.15'),   // 止损百分比
        STOP_LOSS_DELAY: parseInt(process.env.STOP_LOSS_DELAY || '5000'),               // 止损延迟时间，单位ms
        STOP_LOSS_MIN_VOLUME: parseFloat(process.env.STOP_LOSS_MIN_VOLUME || '500'),    // 止损最小成交量,会与STOP_LOSS_DELAY同时使用，即5秒内成交量大于200，则触发止损
        TAKE_PROFIT_PERCENTAGE: parseFloat(process.env.TAKE_PROFIT_PERCENTAGE || '0.22'),   // 止盈百分比
        TAKE_PROFIT_PRICE: parseFloat(process.env.TAKE_PROFIT_PRICE || '0.98'),             // 止盈价格
        MIN_ORDER_SIZE: parseFloat(process.env.MIN_ORDER_SIZE || '1'),      // 买入时最小金额
        MAX_ORDER_SIZE: parseFloat(process.env.MAX_ORDER_SIZE || '100'),    // 买入时最大金额
    }
}