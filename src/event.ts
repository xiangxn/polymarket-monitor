import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import WebSocket from 'ws';
import { Table } from "console-table-printer";
import UpdateManager from 'stdout-update';

import dotenv from "dotenv"
dotenv.config()

import { config } from './config';

interface PolymarketEvent {
    id: string;
    ticker: string | null;
    title: string | null;
    startDate: string;
    endDate: string;
    active: boolean;
    closed: boolean;
    category: string | null;
    volume: number;
    arb?: Arbitrage;
    // price: number;
    tradeCount: number;
    bestAsks: { [tokenId: string]: number };
    markets: PolymarketMarket[]
}

interface PolymarketMarket {
    id: string;
    conditionId: string;
    clobTokenIds: string | string[];
    outcomes: string | string[];
    question: string;
    endDate: string;
    tokens: { tokenId: string; outcome: string; }[]; // [Yes, No]
    volume: number;
    active: boolean;
    closed: boolean;
}

interface Arbitrage {
    hasOpportunity: boolean;
    details: string;
    arbPct: number;
}

interface EventPrices {
    prices: { [tokenId: string]: number }; // 所有Yes token的价格
    lastUpdate: number;
}

interface MarketUpdate {
    event_type: string;
    market: string; // conditionId
    price_changes: any[];
    token_id: string;
    price: number; // 0-100
    // 其他...
}

export async function fetchWithProxy(url: string, options: any = {}) {
    const proxy = config.HTTPS_PROXY;
    if (proxy) {
        options.agent = new HttpsProxyAgent(proxy);
    }
    return fetch(url, options);
}

async function fetchUpcomingEvents(limit: number = 170): Promise<PolymarketEvent[]> {
    const now = new Date();
    const nowIso = now.toISOString();
    const endDateMax = new Date(now.getTime() + config.SEARCH_END_HOURS * 60 * 60 * 1000);
    const endDateMaxIso = endDateMax.toISOString();

    const url = `https://gamma-api.polymarket.com/events?end_date_min=${nowIso}&end_date_max=${endDateMaxIso}&closed=false&limit=${limit}&offset=0&order=endDate&ascending=true`;

    try {
        const response = await fetchWithProxy(url);
        if (!response.ok) throw new Error(`API failed: ${response.status}`);
        const data = await response.json() as PolymarketEvent[]; // 假设响应是数组；调整为实际

        // 解析tokens
        const parsedEvents = data.filter(e => (e.volume || 0) >= config.MIN_VOLUME)
        parsedEvents.forEach(e => {
            // 初始化数据
            e.bestAsks = {}
            e.markets = e.markets.filter(m => m.closed === false && m.active === true)
            e.markets.forEach(m => {
                m.tokens = convertTokens(m.clobTokenIds, m.outcomes)
                const yesToken = m.tokens.find(t => t.outcome.includes('Yes')) || m.tokens[0];
                e.bestAsks[yesToken.tokenId] = (m as any).bestAsk
            })

        })

        const validEvents = Object.values(parsedEvents).filter(e => e.markets.length >= 2 && e.markets.every(m => m.tokens.length === 2));
        console.log(`Fetched ${validEvents.length} multi-outcome groups (<=24h end)`);

        return validEvents;
    } catch (error) {
        console.error('Fetch error:', error);
        return [];
    }
}

function convertTokens(clobTokenIds: string | string[], outcomes: string | string[]) {
    const tokens: { tokenId: string; outcome: string }[] = []
    if (typeof clobTokenIds === 'string') {
        clobTokenIds = JSON.parse(clobTokenIds)
    }
    if (typeof outcomes === 'string') {
        outcomes = JSON.parse(outcomes)
    }
    for (let i = 0; i < clobTokenIds.length; i++) {
        tokens.push({
            tokenId: clobTokenIds[i],
            outcome: outcomes[i]
        })
    }
    return tokens
}

function calculateTimeToEnd(endDateIso: string): number {
    return new Date(endDateIso).getTime() - Date.now(); // ms
}

// 组级套利检测
function detectGroupArbitrage(event: PolymarketEvent, prices: EventPrices): Arbitrage {
    const numOutcomes = event.markets.reduce((sum, m) => sum + m.tokens.length, 0);
    const available = Object.keys(prices.prices).length;
    if (available < numOutcomes) {
        return { arbPct: 0, hasOpportunity: false, details: `Incomplete prices (${available}/${numOutcomes})` };
    }

    let totalProb = 0;
    const probDetails: string[] = [];
    event.markets.forEach(m => {
        const yesToken = m.tokens.find(t => t.outcome.includes('Yes')) || m.tokens[0]; // 没有Yes时tokens[0]=Yes
        const price = prices.prices[yesToken.tokenId] || 0;
        const prob = price / 100;
        totalProb += prob;
        probDetails.push(`${m.question.split('?')[0]}: ${prob.toFixed(2)} ($${price})`);
    });

    const deviation = Math.abs(totalProb - 1);
    const arbPct = deviation * 100;

    if (deviation > config.MIN_PROFIT_MULTI) {
        const strategy = totalProb > 1 ? '买入所有No (低估无结果)' : '卖出所有Yes (高估覆盖)';
        const expectedYield = (deviation - config.MAX_COST) * 100; // 扣费
        return {
            arbPct,
            hasOpportunity: true,
            details: `${event.title} (${numOutcomes} outcomes)\n  Yes概率: ${probDetails.join(', ')}\n  总: ${totalProb.toFixed(2)} | 偏差: ${arbPct.toFixed(1)}% | 策略: ${strategy} | 预期: ${expectedYield.toFixed(1)}%`
        };
    }
    return { arbPct, hasOpportunity: false, details: `No arb (总: ${totalProb.toFixed(2)})` };
}

function setupWebSocketListener(events: PolymarketEvent[]) {
    const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    let ws: WebSocket
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
        ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(proxy) });
    } else {
        ws = new WebSocket(wsUrl);
    }

    // 组价格缓冲：eventId -> {prices: {tokenId: price}}
    let priceBuffer: { [eventId: string]: EventPrices } = {};
    events.forEach(e => {
        priceBuffer[e.id] = { prices: {}, lastUpdate: 0 };
    });

    // 收集所有Yes token IDs订阅
    const assetIds = events.flatMap(e => e.markets.flatMap(m => m.tokens.filter(t => t.outcome.includes('Yes')).map(t => t.tokenId))).filter(Boolean);

    ws.onopen = () => {
        console.log('WS connected');
        if (assetIds.length > 0) {
            ws.send(JSON.stringify({ type: 'MARKET', assets_ids: assetIds }));
            console.log(`Subscribed to ${assetIds.length} tokens for ${events.length} events`);
        }
    };

    ws.onmessage = (wsEvent) => {
        /**
         {
            market: '0x3c020cb98ca54a17256e11386bf8f6607245a79c45d9b2661660742bee90f038',
            price_changes: [
                {
                asset_id: '51268057740718830643342904221269289143636590493147782106762497796343721259068',
                price: '0.046',
                size: '13.8',
                side: 'SELL',
                hash: '68bfd76eda56d6c74527cf3853046a93aae9fb5c',
                best_bid: '0.011',
                best_ask: '0.013'
                },
                {
                asset_id: '33733506378719618414824861842017766717087316269581918865195720790964961847410',
                price: '0.954',
                size: '13.8',
                side: 'BUY',
                hash: 'ee38de2383f98c046af36b57b0bc7106d5f40626',
                best_bid: '0.987',
                best_ask: '0.989'
                }
            ],
            timestamp: '1761314465590',
            event_type: 'price_change'
          }
         */
        const update: MarketUpdate = JSON.parse(wsEvent.data.toString());
        if (update.event_type !== 'price_change' && update.event_type !== 'last_trade_price') return;

        // 找匹配组
        const event = events.find(e => {
            return e.markets.some(m => update.market === m.conditionId)
        });
        if (!event) return;

        if (update.event_type === 'last_trade_price') {
            /**
            {
                "asset_id":"114122071509644379678018727908709560226618148003371446110114509806601493071694",
                "event_type":"last_trade_price",
                "fee_rate_bps":"0",
                "market":"0x6a67b9d828d53862160e470329ffea5246f338ecfffdf2cab45211ec578b0347",
                "price":"0.456",
                "side":"BUY",
                "size":"219.217767",
                "timestamp":"1750428146322"
            }
            */
            const trade = update as any;
            const vol = parseFloat(trade.size) * parseFloat(trade.price)
            event.volume += vol
            event.tradeCount = (event.tradeCount || 0) + 1
            // console.log("event.volume:",event.volume)
            // renderTable(events)
            return
        }

        // 更新Yes价格（假设update是Yes token；实际检查outcome）
        const prices = priceBuffer[event.id];
        const yesToken = event.markets.find(m => m.conditionId === update.market)?.tokens.find(t => t.outcome.includes('Yes'))
        const updateToken = update.price_changes.find(c => c.asset_id === yesToken?.tokenId)
        // console.log("updateToken:", updateToken)
        if (updateToken) {
            prices.prices[updateToken.asset_id] = updateToken.best_ask;
            prices.lastUpdate = Date.now();
            event.bestAsks[updateToken.asset_id] = updateToken.best_ask;


            // 检查套利
            const timeToEnd = calculateTimeToEnd(event.endDate);
            const hoursToEnd = timeToEnd / (1000 * 60 * 60);
            if (hoursToEnd <= 24) {
                const arb = detectGroupArbitrage(event, prices);
                if (!event.arb || event.arb.arbPct !== arb.arbPct) {
                    event.arb = arb
                    renderTable(events)
                }
                if (arb.hasOpportunity) {
                    console.log('🚨 跨市场套利机会:');
                    console.log(arb.details);
                    // 通知逻辑...
                }
            }
        }
    };

    ws.onclose = () => {
        console.log('WS disconnected. Reconnect in 5s...');
        setTimeout(() => setupWebSocketListener(events), 5000);
    };

    ws.onerror = (error) => console.error('WS error:', error);

    // 每小时刷新组
    setInterval(async () => {
        const freshEvents = await fetchUpcomingEvents();
        if (freshEvents.length !== events.length) {
            console.log('Groups changed. Updating...');
            priceBuffer = {};
            ws.close();
            setupWebSocketListener(freshEvents);
        }
    }, 60 * 60 * 1000);
}

// 主启动
async function startGroupMonitor() {
    const events = await fetchUpcomingEvents();
    if (events.length > 0) {
        console.log(`Monitoring ${events.length} multi-outcome groups (<=24h).`);
        console.clear();
        renderTable(events);
        setupWebSocketListener(events);
    } else {
        console.log('No groups. Retry in 5min...');
        setTimeout(startGroupMonitor, 300000);
    }
}

function renderTable(events: PolymarketEvent[]) {
    const p = new Table({
        title: "Market List",
        columns: [
            { name: "title",title:"title[eventId]", alignment: "left" },
            // { name: "category", alignment: "center" },
            { name: "outcomes", alignment: "right", color: "green" },
            { name: "volume", alignment: "right", color: "white" },
            { name: "endsIn", alignment: "right", color: "white" },
            // { name: "arbitrage", alignment: "right", color: "yellow" },
            { name: "tradeCount", alignment: "center", color: "white" },
            { name: "bestAsks", alignment: "center" }
        ],
    });

    events.forEach(e => {
        const timeToEnd = calculateTimeToEnd(e.endDate);
        p.addRows([{
            title: `${e.title}[${e.id}]`,
            // category: e.category,
            outcomes: e.markets.length ?? 0,
            volume: e.volume.toLocaleString(),
            endsIn: (timeToEnd / 3600000).toFixed(1),
            // arbitrage: e.arb ? e.arb.arbPct : 0,
            tradeCount: e.tradeCount ?? 0,
            bestAsks: e.bestAsks ? Object.values(e.bestAsks).join(',') : ""
        }]);
    });
    // p.printTable()
    const data = p.render().split("\n");
    manager.update(data)
}

const manager = UpdateManager.getInstance();
manager.hook();

process.on('SIGINT', () => {
    manager.unhook(false);
    process.exit(0);
});

startGroupMonitor();