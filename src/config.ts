import fs from 'fs'
import { Encryptor } from "./utils/encryptor";
import * as readlineSync from 'readline-sync';

let encryptor: Encryptor
var currentIndex: number = 0
var users: AddressData[] = []
var config: any = {}

interface AddressData {
    funder_address: string;
    owner_address_pri: string;
    clob_api_key: string;
    clob_secret: string;
    clob_passphrase: string;
    builder_api_key: string;
    builder_secret: string;
    builder_passphrase: string;
}

function initAddress(addrFile: string) {
    try {
        // 检查文件是否存在
        if (!fs.existsSync(addrFile)) {
            throw new Error(`❌ Address file not found: ${addrFile}`);
        }

        // 读取文件内容
        const fileContent = fs.readFileSync(addrFile, 'utf-8');

        // 解析 JSON
        const parsedData = JSON.parse(fileContent);

        // 验证数据结构
        if (!Array.isArray(parsedData)) {
            throw new Error(`❌ Invalid data format: Expected array, got ${typeof parsedData}`);
        }

        // 验证每个对象的字段
        for (let i = 0; i < parsedData.length; i++) {
            const item = parsedData[i];
            const requiredFields: (keyof AddressData)[] = [
                'funder_address',
                'owner_address_pri',
                'clob_api_key',
                'clob_secret',
                'clob_passphrase',
                'builder_api_key',
                'builder_secret',
                'builder_passphrase'
            ];

            for (const field of requiredFields) {
                if (!item.hasOwnProperty(field) || typeof item[field] !== 'string') {
                    throw new Error(`❌ Missing or invalid field '${field}' in item ${i}`);
                }
            }
        }

        // 赋值给全局 users 数组
        users = parsedData;

        console.log(`✅ Successfully loaded ${users.length} addresses from ${addrFile}`);

    } catch (error) {
        console.error(`❌ Error reading address file: ${error}`);
        process.exit(1);
    }
}

export function initConfig(addrFile: string) {
    // Get password from CLI input (hidden)
    const password = readlineSync.question('Enter startup password: ', {
        hideEchoBack: true
    });
    if (!password) {
        console.error('Password is required');
        process.exit(1);
    }
    encryptor = new Encryptor(password)
    initAddress(addrFile)
    config = createConfig()
}

const createConfig = () => {
    let currentUser = users[currentIndex]
    return {
        HTTPS_PROXY: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) ?? undefined,
        SOCKS_PROXY: process.env.SOCKS_PROXY ?? undefined,
        SEARCH_START_TIME: parseFloat(process.env.SEARCH_START_TIME ?? "0"),  // 过滤事件结束时间end_date_min,单位m
        SEARCH_END_TIME: parseFloat(process.env.SEARCH_END_TIME ?? "5"),     // 过滤事件结束时间end_date_max,单位m
        MIN_CYCLE_DELAY_MS: parseFloat(process.env.MIN_CYCLE_DELAY_MS ?? "2"),  // 每轮最小间隔,单位s
        DATA_JITTER_DELAY: parseInt(process.env.DATA_JITTER_DELAY ?? "30"),  // 数据防抖延迟,单位ms

        // 监控
        LISTEN_TAKE_PROFIT: parseFloat(process.env.LISTEN_TAKE_PROFIT ?? "0.4"),
        LISTEN_STOP_LOSS: parseFloat(process.env.LISTEN_STOP_LOSS ?? "0.1"),
        LISTEN_TOKENS: JSON.parse(process.env.LISTEN_TOKENS ?? "[]"),
        TG_API_KEY: process.env.TG_API_KEY ?? "",
        TG_CHAT_ID: process.env.TG_CHAT_ID ?? "",

        // 操作订单
        CLOB_API_URL: process.env.CLOB_API_URL ?? "https://clob.polymarket.com",
        CHAIN_ID: parseInt(process.env.CHAIN_ID ?? "137"),
        FUNDER_ADDRESS: currentUser.funder_address ?? "",
        OWNER_ADDRESS_PRI: encryptor!.decrypt(currentUser.owner_address_pri || ''),
        CLOB_API_KEY: encryptor!.decrypt(currentUser.clob_api_key || ''),
        CLOB_SECRET: encryptor!.decrypt(currentUser.clob_secret || ''),
        CLOB_PASS_PHRASE: encryptor!.decrypt(currentUser.clob_passphrase || ''),

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
        ENTER_DELTA_THRESHOLD: parseFloat(process.env.ENTER_DELTA_THRESHOLD ?? "-0.02"),  // 如果下单时，价格是下跌状态，跌幅大于此值，不下单
        KEEP_LAST_TRADE_TIME: parseInt(process.env.KEEP_LAST_TRADE_TIME || '60'),       // 保留最近60s的交易数据
        STOP_LOSS_FLIP_LIMIT: parseFloat(process.env.STOP_LOSS_FLIP_LIMIT || '0.53'),   // 价格接近翻转时, 止损触发。不使用时可以设置为0
        STOP_LOSS_PERCENTAGE: parseFloat(process.env.STOP_LOSS_PERCENTAGE || '0.2'),   // 止损百分比
        STOP_LOSS_DELAY: parseInt(process.env.STOP_LOSS_DELAY || '5000'),               // 止损延迟时间, 单位ms, 比如5秒内有成交价低于止损价
        STOP_LOSS_VOLUME_AVG_RATE: parseFloat(process.env.STOP_LOSS_VOLUME_AVG_RATE || '0.3'),    // STOP_LOSS_DELAY的交易量大于平均交易量的百分比，则触发止损
        STOP_LOSS_TRADE_COUNT: parseInt(process.env.STOP_LOSS_TRADE_COUNT || '3'),                // STOP_LOSS_DELAY的卖单数量>=STOP_LOSS_TRADE_COUNT，则触发止损
        STOP_LOSS_RELATIVE_PRICE_CHANGE: parseFloat(process.env.STOP_LOSS_RELATIVE_PRICE_CHANGE || '0.00005'),  // 当前价格与开盘价格之差太小, 止损
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
        BUILDER_API_KEY: encryptor!.decrypt(currentUser.builder_api_key || ''),
        BUILDER_SECRET: encryptor!.decrypt(currentUser.builder_secret || ''),
        BUILDER_PASS_PHRASE: encryptor!.decrypt(currentUser.builder_passphrase || ''),
    }
}

export function nextAddress() {
    currentIndex += 1
    if (currentIndex >= users.length) {
        currentIndex = 0
    }
    let c = createConfig()
    config.FUNDER_ADDRESS = c.FUNDER_ADDRESS
    config.OWNER_ADDRESS_PRI = c.OWNER_ADDRESS_PRI
    config.CLOB_API_KEY = c.CLOB_API_KEY
    config.CLOB_SECRET = c.CLOB_SECRET
    config.CLOB_PASS_PHRASE = c.CLOB_PASS_PHRASE
    config.BUILDER_API_KEY = c.BUILDER_API_KEY
    config.BUILDER_SECRET = c.BUILDER_SECRET
    config.BUILDER_PASS_PHRASE = c.BUILDER_PASS_PHRASE
}

export const getConfig = () => {
    return config
}