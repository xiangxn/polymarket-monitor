import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { Table } from "console-table-printer";

import dotenv from "dotenv"
dotenv.config()

import { config } from './config';

export async function fetchWithProxy(url: string, options: any = {}) {
    const proxy = config.HTTPS_PROXY;
    if (proxy) {
        options.agent = new HttpsProxyAgent(proxy);
    }
    return fetch(url, options);
}

interface PolymarketMarket {
    id: string;
    question: string;
    endDate: string;
    conditionId: string;
    clobTokenIds: string[]; // All outcome token IDs (length >=2 for binary/multi)
    volume: number; // 交易量，从API获取
    active: boolean;
    outcomes?: string[]; // e.g., ['Yes', 'No'] or ['Candidate A', 'B', 'C']
}

interface MarketPrices {
    prices: { [tokenId: string]: number }; // tokenId -> price (0-100)
    lastUpdate: number; // timestamp
}

interface MarketUpdate {
    event_type: string;
    market: string; // conditionId
    token_id: string; // clobTokenId
    price: number; // 新价格 (0-100)
    // 其他字段...
}

async function fetchUpcomingMarkets(): Promise<PolymarketMarket[]> {
    const now = new Date();
    const nowIso = now.toISOString();
    const eightHoursLater = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const eightHoursIso = eightHoursLater.toISOString();

    const url = `https://gamma-api.polymarket.com/markets?category=politics&end_date_min=${nowIso}&end_date_max=${eightHoursIso}&closed=false&active=true&limit=500&offset=0&order=endDate&ascending=true`;

    try {
        const response = await fetchWithProxy(url);
        if (!response.ok) {
            throw new Error(`API request failed: ${response.status}`);
        }
        const data = await response.json();
        const markets = (data as PolymarketMarket[]).filter(m => m.active && m.volume > config.MIN_VOLUME); // 高流动性

        // 可选：为每个市场fetch详细outcome labels (e.g., /markets/{id})
        // 为简单，这里假设clobTokenIds顺序对应outcomes；实际可并行fetch
        // 示例：markets.forEach(async m => { const detail = await fetch(`https://gamma-api.polymarket.com/markets/${m.id}`); m.outcomes = (await detail.json()).outcomes; });
        markets.forEach(m => {
            if (typeof m.clobTokenIds === 'string') {
                m.clobTokenIds = JSON.parse(m.clobTokenIds)
            }
            if (typeof m.outcomes === 'string') {
                m.outcomes = JSON.parse(m.outcomes)
            }
        })

        // 过滤仅二元或多结果市场 (length >=2)
        return markets.filter(m => m.clobTokenIds.length >= 2);
    } catch (error) {
        console.error('Error fetching markets:', error);
        return [];
    }
}

function calculateTimeToEnd(endDateIso: string): number {
    const endDate = new Date(endDateIso);
    const now = new Date();
    return endDate.getTime() - now.getTime(); // ms
}

// 检测套利函数，支持多结果
function detectArbitrage(market: PolymarketMarket, prices: MarketPrices): { hasOpportunity: boolean; details: string; isMultiOutcome: boolean } {
    const numOutcomes = market.clobTokenIds.length;
    const isMultiOutcome = numOutcomes > 2;
    const outcomeLabels = market.outcomes || market.clobTokenIds.map((_, i) => `Outcome ${i + 1}`); // Fallback labels

    // 检查是否有所有价格可用
    const availablePrices = Object.keys(prices.prices).length;
    if (availablePrices < numOutcomes) {
        return { hasOpportunity: false, details: `Incomplete prices (${availablePrices}/${numOutcomes})`, isMultiOutcome };
    }

    // 计算总概率
    let totalProb = 0;
    const probDetails: string[] = [];
    market.clobTokenIds.forEach((tokenId, i) => {
        const price = prices.prices[tokenId] || 0;
        const prob = price / 100;
        totalProb += prob;
        probDetails.push(`${outcomeLabels[i]}: ${prob.toFixed(2)} ($${price})`);
    });

    const deviation = Math.abs(totalProb - 1);
    const arbitragePct = deviation * 100; // % 偏差

    const threshold = isMultiOutcome ? config.MIN_PROFIT_MULTI : config.MIN_PROFIT_BINARY;
    if (deviation > threshold) { // 2% 阈值，适用于多结果
        const typeDesc = isMultiOutcome ? '多结果' : '二元';
        const strategy = totalProb > 1 ? '买入低估outcome(s)' : '卖出高估outcome(s)';
        const expectedYield = (deviation - config.MAX_COST) * 100; // 扣除~0.5% 手续费
        return {
            hasOpportunity: true,
            details: `${market.question} (${typeDesc}市场, ${numOutcomes} outcomes)\n  概率: ${probDetails.join(', ')}\n  总概率: ${totalProb.toFixed(2)} | 偏差: ${arbitragePct.toFixed(1)}% | 策略: ${strategy} | 预期收益: ${expectedYield.toFixed(1)}%`,
            isMultiOutcome
        };
    }
    return { hasOpportunity: false, details: `No opportunity (总概率: ${totalProb.toFixed(2)})`, isMultiOutcome };
}

function setupWebSocketListener(upcomingMarkets: PolymarketMarket[]) {
    const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    let ws: WebSocket
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
        ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(proxy) });
    } else {
        ws = new WebSocket(wsUrl);
    }

    // 价格缓冲：市场ID -> 价格对象
    let priceBuffer: { [conditionId: string]: MarketPrices } = {};
    upcomingMarkets.forEach(m => {
        priceBuffer[m.conditionId] = { prices: {}, lastUpdate: 0 };
    });

    const assetIds = upcomingMarkets.flatMap(m => m.clobTokenIds).filter(Boolean);

    ws.onopen = () => {
        console.log('WebSocket connected');
        if (assetIds.length > 0) {
            const subscribeMsg = {
                type: 'MARKET',
                assets_ids: assetIds
            };
            ws.send(JSON.stringify(subscribeMsg));
            console.log(`Subscribed to ${assetIds.length} assets for ${upcomingMarkets.length} markets (${upcomingMarkets.filter(m => m.clobTokenIds.length > 2).length} multi-outcome)`);
        } else {
            console.log('No assets to subscribe');
        }
    };

    ws.onmessage = (event) => {
        const update: MarketUpdate = JSON.parse(event.data.toString());
        if (update.event_type !== 'price_change') return; // 只处理价格更新

        const market = upcomingMarkets.find(m => m.conditionId === update.market);
        if (!market) return;

        // 更新缓冲
        const prices = priceBuffer[update.market] || { prices: {}, lastUpdate: 0 };
        prices.prices[update.token_id] = update.price;
        prices.lastUpdate = Date.now();
        priceBuffer[update.market] = prices;

        // 检查套利（每更新后）
        const timeToEnd = calculateTimeToEnd(market.endDate);
        const hoursToEnd = timeToEnd / (1000 * 60 * 60);
        if (hoursToEnd <= 8) {
            const arb = detectArbitrage(market, prices);
            if (arb.hasOpportunity) {
                console.log('🚨 套利机会检测:');
                console.log(arb.details);
                // 这里：发送通知 (e.g., email/Discord webhook)
            }
        }
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected. Reconnecting in 5s...');
        setTimeout(() => setupWebSocketListener(upcomingMarkets), 5000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
    };

    // 每小时刷新市场列表
    setInterval(async () => {
        const freshMarkets = await fetchUpcomingMarkets();
        if (freshMarkets.length !== upcomingMarkets.length || JSON.stringify(freshMarkets.map(m => m.id).sort()) !== JSON.stringify(upcomingMarkets.map(m => m.id).sort())) {
            console.log('Market list changed. Updating...');
            priceBuffer = {}; // 重置缓冲
            ws.close();
            setupWebSocketListener(freshMarkets);
        }
    }, 60 * 60 * 1000);
}

// 主函数
async function startEventDrivenMonitor() {
    const upcomingMarkets = await fetchUpcomingMarkets();
    if (upcomingMarkets.length > 0) {
        const p = new Table({
            title: "Market List",
            columns: [
                { name: "question", alignment: "left" },
                { name: "isMulti", alignment: "center", color: "cyan" },
                { name: "outcomes", alignment: "right", color: "green" },
                { name: "volume", alignment: "right", color: "white" },
                { name: "endsIn", alignment: "right", color: "white" },
            ],
        });
        console.log(`Monitoring ${upcomingMarkets.length} high-volume markets ending in <=8 hours (${upcomingMarkets.filter(m => m.clobTokenIds.length > 2).length} multi-outcome).`);
        upcomingMarkets.forEach(m => {
            const timeToEnd = calculateTimeToEnd(m.endDate);
            const isMulti = m.clobTokenIds.length > 2;
            p.addRows([{ question: m.question, isMulti: isMulti, outcomes: m.clobTokenIds.length, volume: m.volume.toLocaleString(), endsIn: (timeToEnd / 3600000).toFixed(1) }])
            // console.log(`- ${m.question} (${isMulti ? '多结果' : '二元'}, ${m.clobTokenIds.length} outcomes; volume: $${m.volume.toLocaleString()}; ends in ${(timeToEnd / 3600000).toFixed(1)} hours)`);
        });
        p.printTable();
        setupWebSocketListener(upcomingMarkets);
    } else {
        console.log('No markets ending soon. Retrying in 5 min...');
        setTimeout(startEventDrivenMonitor, 300000);
    }
}

// 启动
startEventDrivenMonitor();