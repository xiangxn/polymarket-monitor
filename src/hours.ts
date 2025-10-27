import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
// import { Table } from "console-table-printer";
import Table from "cli-table3";
import UpdateManager from 'stdout-update';

import dotenv from "dotenv"
dotenv.config()

import { config } from './config';
import { calcTotalPrice, calculateTimeToEnd, convertTokens, fetchWithProxy, sleep, formatTimeFromMs } from './helper';

console.info("Current config:", config)

interface PolymarketEvent {
    id: string;
    ticker: string | null;
    title: string | null;
    startDate: string;
    endDate: string;
    active: boolean;
    closed: boolean;
    negRisk: boolean;
    volume: number;
    tradeCount: number;
    markets: PolymarketMarket[];

    canSweep: { can: boolean, marketId: string };
    possibleProfits: PossibleProfit[];
    totalProfit: number;
}

interface PolymarketMarket {
    id: string;
    conditionId: string;
    clobTokenIds: string[];
    outcomes: string[];  // e.g. [Yes, No],[Up, Down]
    outcomePrices: string[];
    question: string;
    endDate: string;
    negRisk: boolean;
    volume: number;
    active: boolean;
    closed: boolean;
    // 重要数据
    tokens: Token[];
    liquidityNum: number;
    bestBid: number;
    bestAsk: number;
    totalPrice: number;
    // 调用需要
    orderPriceMinTickSize: number;
    orderMinSize: number;
}

interface Token {
    tokenId: string;
    outcome: string;
    price: number;
    bid: Book;
    ask: Book;
}

interface Book {
    price: number;
    size: number;
}

// Possibleprofit
interface PossibleProfit {
    tokenId: string;
    profitPct: number;
}

async function fetchTokensBook(tokens: string[]) {
    if (!Array.isArray(tokens) || tokens.length === 0) return []

    const url = "https://clob.polymarket.com/books"
    const response = await fetchWithProxy(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(tokens.map(t => ({ token_id: t })))
    });
    if (!response.ok) throw new Error(`API failed: ${response.status}`);
    const data = await response.json() as any[];
    return data
}

async function fetchUpcomingEvents(startHours: number = 0, endHours: number = 24, maxCount: number = 10000): Promise<PolymarketEvent[]> {
    const now = new Date();
    const nowIso = (new Date(now.getTime() + startHours * 60 * 60 * 1000)).toISOString();
    const endDateMax = new Date(now.getTime() + endHours * 60 * 60 * 1000);
    const endDateMaxIso = endDateMax.toISOString();
    const limit: number = 500;
    let offset: number = 0;
    let allEvents: PolymarketEvent[] = [];
    const retryDelay = 20;

    while (true) {
        const url = `https://gamma-api.polymarket.com/events?end_date_min=${nowIso}&end_date_max=${endDateMaxIso}&closed=false&offset=${offset}&limit=${limit}&order=endDate&ascending=true`;

        try {
            const response = await fetchWithProxy(url);
            if (!response.ok) throw new Error(`API failed: ${response.status}`);
            const data = await response.json() as PolymarketEvent[];

            if (data.length === 0) break;

            // 解析tokens
            const parsedEvents = data.filter(e => (e.volume || 0) >= config.MIN_VOLUME);
            parsedEvents.forEach(e => {
                // 初始化数据
                e.tradeCount = 0
                e.possibleProfits = []
                e.totalProfit = 0
                e.canSweep = { can: false, marketId: '0' }

                e.markets = e.markets.filter(m => m.closed === false && m.active === true);
                e.markets.forEach(m => {
                    m.clobTokenIds = (typeof m.clobTokenIds === 'string') ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
                    m.outcomes = (typeof m.outcomes === 'string') ? JSON.parse(m.outcomes) : m.outcomes;
                    m.outcomePrices = (typeof m.outcomePrices === 'string') ? JSON.parse(m.outcomePrices) : m.outcomePrices;
                    m.tokens = convertTokens(m);
                    m.totalPrice = calcTotalPrice(m.outcomePrices);
                });
            });

            const validEvents = Object.values(parsedEvents).filter(e => e.negRisk === true || (e.negRisk === false && e.markets.length < 6));
            // 处理初始book
            const books = await fetchTokensBook(validEvents.flatMap(e => e.markets.flatMap(m => m.tokens.map(t => t.tokenId))))
            books.forEach(b => {
                validEvents.forEach(e => {
                    const market = e.markets.find(m => m.conditionId === b.market)
                    if (market) {
                        const token = market.tokens.find(t => t.tokenId === b.asset_id)
                        if (token) {
                            token.bid = { ...b.bids[b.bids.length - 1] }
                            token.ask = { ...b.asks[b.asks.length - 1] }
                        }
                    }
                })
            })
            allEvents = [...allEvents, ...validEvents];

            if (data.length < limit || allEvents.length >= maxCount) break;
            offset += limit;
            await sleep(0.5)
        } catch (error) {
            console.error('Fetch error:', error, "\n", url);
            console.info(`${retryDelay} 秒后重试...`)
            await sleep(retryDelay);
        }
    }

    console.debug(`Fetched ${allEvents.length} events (<=${endHours}h end)`);
    return allEvents;
}

function setupWebSocketListener(events: PolymarketEvent[], callback?: Function) {
    const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    let ws: WebSocket
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
        ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(proxy) });
    } else {
        ws = new WebSocket(wsUrl);
    }

    // 收集所有Yes token IDs订阅
    const assetIds = events.flatMap(e => e.markets.flatMap(m => m.tokens.map(t => t.tokenId))).filter(Boolean);

    ws.onopen = () => {
        console.debug('WS connected');
        if (assetIds.length > 0) {
            ws.send(JSON.stringify({ type: 'MARKET', assets_ids: assetIds }));
            console.debug(`Subscribed to ${assetIds.length} tokens for ${events.length} events`);
        }
    };

    const eventsMap: { [name: string]: boolean } = {
        'price_change': true,
        'last_trade_price': true,
        'book': true
    }

    ws.onmessage = (wsEvent) => {

        const update = JSON.parse(wsEvent.data.toString());

        if (!eventsMap[update.event_type]) return;

        // 找匹配组
        const event = events.find(e => {
            return e.markets.some(m => update.market === m.conditionId)
        });
        if (!event) return;

        const market = event.markets.find(m => m.conditionId === update.market)!

        if (update.event_type === 'book') {
            /**
            {
                market: '0x0bb71cc44f03792b447f0515871dba55a9331bf9b035be0321fac050a85222cb',
                asset_id: '45158219890981277236047911963078197293833284894759865197979294050560155010790',
                bids: [
                    { price: '0.6', size: '1044.36' },
                    { price: '0.61', size: '150.44' }
                ],
                asks: [
                    { price: '0.99', size: '55216' },
                    { price: '0.98', size: '7447' }
                ],
                hash: '21f9bd293328664552f5f05111a9ae8678b60e75',
                timestamp: '1761491848538',
                event_type: 'book'
                }
            */
            const token = market.tokens.find(t => t.tokenId === update.asset_id)!
            const bidIndex = update.bids.length - 1
            const askIndex = update.asks.length - 1
            token.bid = update.bids.length > 0 ? { price: parseFloat(update.bids[bidIndex].price), size: parseFloat(update.bids[bidIndex].size) } : { price: 0, size: 0 }
            token.ask = update.asks.length > 0 ? { price: parseFloat(update.asks[askIndex].price), size: parseFloat(update.asks[askIndex].size) } : { price: 0, size: 0 }
            return
        }

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
            const closed = renderTable(events)
            if (closed) {
                ws.close()
                if (callback) callback()
            }
            return
        }

        // 更新价格
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
        update.price_changes.forEach((c: any) => {
            const token = market.tokens.find(t => t.tokenId === c.asset_id)
            if (token) {
                token.price = c.price
            }
            const index = market.clobTokenIds.findIndex((t: string) => t === c.asset_id) ?? -1
            if (index > -1) {
                market.outcomePrices[index] = c.price
                if (index === 0) {
                    market.bestBid = parseFloat(c.best_bid)
                    market.bestAsk = parseFloat(c.best_ask)
                }
            }
        })
        const totalProfit = detectEventProfits(event);
        if (event.totalProfit !== totalProfit) {
            event.totalProfit = totalProfit
            const closed = renderTable(events)
            if (closed) {
                ws.close()
                if (callback) callback()
            }
        }
    };

    ws.onclose = () => {
        console.log('WS disconnected. Reconnect in 5s...');
        setTimeout(() => setupWebSocketListener(events), 5000);
    };

    ws.onerror = (error) => console.error('WS error:', error);
}

function detectEventProfits(event: PolymarketEvent): number {
    if (event.negRisk) {
        // 互斥事件
        const markets = event.markets.filter(m => m.negRisk)    // 只取互斥事件的市场
        // 从价格高到低排序市场
        markets.sort((a, b) => b.tokens[0].ask.price - a.tokens[0].ask.price)

        // 扫尾盘检查
        if (markets[0].tokens[0].ask.price - markets[1].tokens[0].ask.price > config.MIN_MARKET_SPREAD) {
            // 可能存在扫尾盘机会
            event.canSweep = { can: true, marketId: markets[0].id }
            return 1 - markets[0].tokens[0].ask.price
        } else {
            event.canSweep = { can: false, marketId: "0" }
        }
    } else {
        // 非互斥事件
        let totalProfit = 0
        event.markets.forEach(m => {
            if (!m.negRisk) {
                const spread = m.tokens[0].ask.price - m.tokens[1].ask.price
                if (Math.abs(spread) > config.MIN_MARKET_SPREAD) {
                    // 可能存在扫尾盘机会
                    event.canSweep = { can: true, marketId: m.id }
                    totalProfit += spread > 0 ? 1 - m.tokens[0].ask.price : 1 - m.tokens[1].ask.price
                } else {
                    event.canSweep = { can: false, marketId: "0" }
                }
            }
        })
        return totalProfit
    }

    return 0
}


// 主启动
async function startEventMonitor() {
    const startHours = config.SEARCH_START_HOURS
    const endHours = config.SEARCH_END_HOURS;
    const events = await fetchUpcomingEvents(startHours, endHours);
    if (events.length > 0) {
        console.log(`Monitoring ${events.length} events.`);
        // console.clear();
        renderTable(events);
        setupWebSocketListener(events, () => { startEventMonitor() });
    } else {
        console.log('No groups. Retry in 5min...');
        setTimeout(startEventMonitor, 300000);
    }
}

function renderTable(events: PolymarketEvent[]): boolean {
    const p = new Table({
        wordWrap: true,
        head: [
            "title",
            "volume",
            "endsIn",
            "tradeCount",
            "negRisk",
            "canSweep",
            "estimate",
            "yesPrices"
        ],
    });

    let closeCount = 0;
    events.forEach(e => {
        const timeToEnd = calculateTimeToEnd(e.endDate);
        p.push([
            `${e.title}[${e.id}]`,
            e.volume.toLocaleString(),
            timeToEnd < 0 ? "00:00:00" : formatTimeFromMs(timeToEnd),
            e.tradeCount ?? 0,
            e.negRisk ? "Y" : "N",
            e.canSweep.can ? `Y [${e.canSweep.marketId}]` : "N",
            timeToEnd < 0 ? "0%" : `${+(e.totalProfit * 100).toFixed(2)}%`,
            e.markets.map((m, i) => ((i + 1) % 5 === 0 ? `${m.tokens[0].ask.price}\n` : `${m.tokens[0].ask.price ?? 0}`)).join(",")
        ]);
        if (closeCount <= 0) {
            closeCount += 1;
        }
    });
    // p.printTable()
    const data = p.toString().split("\n");
    manager.update(data)
    return closeCount === events.length
}

const manager = UpdateManager.getInstance();
manager.hook();

process.on('SIGINT', () => {
    manager.unhook(false);
    process.exit(0);
});

startEventMonitor();