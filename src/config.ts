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
        SEARCH_START_TIME: parseFloat(process.env.SEARCH_START_TIME ?? "0"),  // 过滤事件结束时间end_date_min,单位m
        SEARCH_END_TIME: parseFloat(process.env.SEARCH_END_TIME ?? "5"),     // 过滤事件结束时间end_date_max,单位m
        MIN_CYCLE_DELAY_MS: parseFloat(process.env.MIN_CYCLE_DELAY_MS ?? "2"),  // 每轮最小间隔,单位s

        // 监控
        LISTEN_TAKE_PROFIT: parseFloat(process.env.LISTEN_TAKE_PROFIT ?? "0.4"),
        LISTEN_STOP_LOSS: parseFloat(process.env.LISTEN_STOP_LOSS ?? "0.1"),
        LISTEN_TOKENS: JSON.parse(process.env.LISTEN_TOKENS ?? "[]"),
        TG_API_KEY: process.env.TG_API_KEY ?? "",
        TG_CHAT_ID: process.env.TG_CHAT_ID ?? "",

        // 操作订单
        CLOB_API_URL: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
        CHAIN_ID: parseInt(process.env.CHAIN_ID ?? "137"),
        FUNDER_ADDRESS: process.env.FUNDER_ADDRESS ?? "",
        OWNER_ADDRESS_PRI: encryptor!.decrypt(process.env.OWNER_ADDRESS_PRI || ''),
        CLOB_API_KEY: encryptor!.decrypt(process.env.CLOB_API_KEY || ''),
        CLOB_SECRET: encryptor!.decrypt(process.env.CLOB_SECRET || ''),
        CLOB_PASS_PHRASE: encryptor!.decrypt(process.env.CLOB_PASS_PHRASE || ''),

        // 策略配置
        RELATIVE_PRICE_CHANGE: parseFloat(process.env.RELATIVE_PRICE_CHANGE ?? "0.0005"),  // 价格相对变动幅度, 0.0005即幅度小于0.05%时不操作(幅度越小，不可预测性越强，风险越大)
        MIN_BALANCE: parseFloat(process.env.MIN_BALANCE ?? "140"),  // 最小余额，小于此值不操作
        MIN_END_TIME: parseFloat(process.env.MIN_END_TIME ?? "50") * 1000, // 只扫最后50秒钟的事件,单位s
        MIN_VOLUME: parseFloat(process.env.MIN_VOLUME ?? "1000"),  // 过滤事件最小交易量
        MIN_MARKET_SPREAD: parseFloat(process.env.MIN_MARKET_SPREAD ?? "0.2"),     // 市场价格差,如果是互斥市场就是市场间, 如果是二元市场就是市场内yes/no
        ENTER_WINDOW: JSON.parse(process.env.ENTER_WINDOW ?? "[0.72,0.95]"),         // 进入的价格窗口
        ENTER_DELAY: parseInt(process.env.ENTER_DELAY ?? "10") * 1000,                    // 进入延迟, ask价格达到后开始检查, 如果成交价满足进入窗口, 则进入, 单位秒
        ENTER_VOLUME_AVG_RATE: parseFloat(process.env.ENTER_VOLUME_AVG_RATE ?? "0.2"),    // 进入时ENTER_DELAY时间内的买单量大于平均成交量的百分比，则进入
        ENTER_TRADE_COUNT: parseInt(process.env.ENTER_TRADE_COUNT ?? "3"),
        ENTER_DELTA_THRESHOLD: parseFloat(process.env.ENTER_DELTA_THRESHOLD ?? "-0.005"),  // 如果下单时，价格是下跌状态，跌幅大于此值，不下单
        KEEP_LAST_TRADE_TIME: parseInt(process.env.KEEP_LAST_TRADE_TIME || '60'),       // 保留最近60s的交易数据
        STOP_LOSS_FLIP_LIMIT: parseFloat(process.env.STOP_LOSS_FLIP_LIMIT || '0.53'),   // 价格接近翻转时, 止损触发。不使用时可以设置为0
        STOP_LOSS_PERCENTAGE: parseFloat(process.env.STOP_LOSS_PERCENTAGE || '0.2'),   // 止损百分比
        STOP_LOSS_DELAY: parseInt(process.env.STOP_LOSS_DELAY || '5000'),               // 止损延迟时间, 单位ms, 比如5秒内有成交价低于止损价
        STOP_LOSS_VOLUME_AVG_RATE: parseFloat(process.env.STOP_LOSS_VOLUME_AVG_RATE || '0.3'),    // STOP_LOSS_DELAY的交易量大于平均交易量的百分比，则触发止损
        STOP_LOSS_TRADE_COUNT: parseInt(process.env.STOP_LOSS_TRADE_COUNT || '3'),                // STOP_LOSS_DELAY的卖单数量>=STOP_LOSS_TRADE_COUNT，则触发止损
        TAKE_PROFIT_PERCENTAGE: parseFloat(process.env.TAKE_PROFIT_PERCENTAGE || '0.3'),   // 止盈百分比
        TAKE_PROFIT_PRICE: parseFloat(process.env.TAKE_PROFIT_PRICE || '0.99'),             // 止盈价格
        TAKE_PROFIT_MIN_TIME: parseInt(process.env.TAKE_PROFIT_MIN_TIME || '1') * 60 * 1000,        // 如果止盈时间离结束时间<=此值，则不止盈
        MIN_ORDER_SIZE: parseFloat(process.env.MIN_ORDER_SIZE || '1'),      // 买入时最小金额, 平台不允许小于1usdc的单子
        MAX_ORDER_SIZE: parseFloat(process.env.MAX_ORDER_SIZE || '1'),    // 买入时最大金额

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