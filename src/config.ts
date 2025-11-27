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
        SOCKS_PROXY: process.env.SOCKS_PROXY ?? undefined,
        SEARCH_START_TIME: parseInt(process.env.SEARCH_START_TIME ?? "7"),  // 过滤事件结束时间end_date_min,单位m
        SEARCH_END_TIME: parseInt(process.env.SEARCH_END_TIME ?? "10080"),     // 过滤事件结束时间end_date_max,单位m,默认7天
        DATA_JITTER_DELAY: parseInt(process.env.DATA_JITTER_DELAY ?? "30"),  // 数据防抖延迟,单位ms
        KEEP_LAST_TRADE_TIME: parseInt(process.env.KEEP_LAST_TRADE_TIME || '60'),       // 保留最近60s的交易数据

        // 操作订单
        CLOB_API_URL: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
        CHAIN_ID: parseInt(process.env.CHAIN_ID ?? "137"),
        FUNDER_ADDRESS: process.env.FUNDER_ADDRESS ?? "",
        OWNER_ADDRESS_PRI: encryptor!.decrypt(process.env.OWNER_ADDRESS_PRI || ''),
        CLOB_API_KEY: encryptor!.decrypt(process.env.CLOB_API_KEY || ''),
        CLOB_SECRET: encryptor!.decrypt(process.env.CLOB_SECRET || ''),
        CLOB_PASS_PHRASE: encryptor!.decrypt(process.env.CLOB_PASS_PHRASE || ''),
        MIN_ORDER_SIZE: parseFloat(process.env.MIN_ORDER_SIZE || '1'),      // 买入时最小金额, 平台不允许小于1usdc的单子
        MAX_ORDER_SIZE: parseFloat(process.env.MAX_ORDER_SIZE || '1'),    // 买入时最大金额

        // 策略配置
        MIN_BALANCE: parseFloat(process.env.MIN_BALANCE ?? "140"),  // 最小余额，小于此值不操作
        ENTRY_WINDOW_LOW: parseInt(process.env.ENTRY_WINDOW_LOW ?? "60"),  // seconds, 入场窗口最小值, 默认值1m
        ENTRY_WINDOW_HIGH: parseInt(process.env.ENTRY_WINDOW_HIGH ?? "600"),  // seconds, 入场窗口最大值, 默认值10m
        TREND_THRESHOLD: parseFloat(process.env.TREND_THRESHOLD ?? "0.0004"),   // 趋势阈值 0.04% -> 0.0004
        MIN_PRICE_DELTA_THRESHOLD: parseFloat(process.env.MIN_PRICE_DELTA_THRESHOLD ?? "0.0008"),   // 标的价格delta最小值 0.08% -> 0.0008
        MAX_PRICE_DELTA_THRESHOLD: parseFloat(process.env.MAX_PRICE_DELTA_THRESHOLD ?? "0.0035"),   // 标的价格delta最大值 0.35% -> 0.0035
        MAX_ENTRY_PRICE: parseFloat(process.env.MAX_ENTRY_PRICE ?? "0.7"),   // 最大入场价 0.7
        MAX_BOOK_DIFF: parseFloat(process.env.MAX_BOOK_DIFF ?? "0.36"),   // 盘口差最大值 0.36
        VOLATILITY_MARGIN: parseFloat(process.env.VOLATILITY_MARGIN ?? "1.0"),   // 基于波动率允许偏差
        TAKE_PROFIT_PERCENTAGE: parseFloat(process.env.TAKE_PROFIT_PERCENTAGE || '0.45'),   // 止盈百分比
        TAKE_PROFIT_PRICE: parseFloat(process.env.TAKE_PROFIT_PRICE || '0.93'),            // 止盈价格
        TAKE_PROFIT_MIN_TIME: parseInt(process.env.TAKE_PROFIT_MIN_TIME || '120'),        // 如果止盈时间离结束时间<=此值, 则不止盈, 单位s
        TAKE_PROFIT_DISTANCE_PCT: parseFloat(process.env.TAKE_PROFIT_DISTANCE_PCT || '0.005'), // 最后TAKE_PROFIT_MIN_TIME时间内如果价格差大于此值时不止盈
        STOP_LOSS_THRESHOLD: parseFloat(process.env.STOP_LOSS_THRESHOLD || '-0.45'),       // 硬止损比例, 默认值亏损45%
        STOP_LOSS_LOGIC_TIME_THRESHOLD: parseInt(process.env.STOP_LOSS_LOGIC_TIME_THRESHOLD || '20000'),  // 逻辑止损时间阈值, 默认值20s (价格翻转后20s内不止损), 单位ms
        STOP_LOSS_TIME_LAST: parseInt(process.env.STOP_LOSS_TIME_LAST || '180000'),  // 时间止损, 最后3分钟时价离开盘价较远, 且亏损时止损, 默认值3m, 单位ms
        STOP_LOSS_TIME_DISTANCE_PCT: parseFloat(process.env.STOP_LOSS_TIME_DISTANCE_PCT || '0.001'),  // 时间止损,时价格距离大于此值时止损,与STOP_LOSS_TIME_LAST并用 默认值0.01%

        // build relayer client
        CHAIN_RPC_URL: process.env.CHAIN_RPC_URL || 'https://polygon-rpc.com',
        USDC_ADDRESS: process.env.USDC_ADDRESS || '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
        CTF_ADDRESS: process.env.CTF_ADDRESS || '0x4d97dcd97ec945f40cf65f87097ace5ea0476045',
        NEG_RISK_CTF_ADDRESS: process.env.NEG_RISK_CTF_ADDRESS || '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
        POLYMARKET_RELAYER_URL: process.env.POLYMARKET_RELAYER_URL || 'https://relayer-v2.polymarket.com/',
        BUILDER_API_KEY: encryptor!.decrypt(process.env.BUILDER_API_KEY || ''),
        BUILDER_SECRET: encryptor!.decrypt(process.env.BUILDER_SECRET || ''),
        BUILDER_PASS_PHRASE: encryptor!.decrypt(process.env.BUILDER_PASS_PHRASE || ''),
    }
}

export type ConfigType = ReturnType<typeof getConfig>;