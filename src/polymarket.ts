import { fetchWithProxy, sleep } from "./helper";
import { PolymarketEvent, Token } from "./types";

import { getConfig } from './config';

const config = getConfig()

export function convertTokens(market: any) {
    const tokens: Token[] = []
    if (typeof market.clobTokenIds === 'string') {
        market.clobTokenIds = JSON.parse(market.clobTokenIds)
    }
    if (typeof market.outcomes === 'string') {
        market.outcomes = JSON.parse(market.outcomes)
    }
    if (typeof market.outcomePrices === 'string') {
        market.outcomePrices = JSON.parse(market.outcomePrices)
    }
    for (let i = 0; i < market.clobTokenIds.length; i++) {
        const price = parseFloat(market.outcomePrices[i]?.toString() ?? "0")
        tokens.push({
            tokenId: market.clobTokenIds[i],
            outcome: market.outcomes[i],
            price: price,
            bid: {
                price: 0,
                size: 0
            },
            ask: {
                price: 0,
                size: 0
            },
            lastBuy: [],
            lastSell: []
        })
    }
    return tokens
}

export function calcTotalPrice(outcomePrices: string | string[]): number {
    if (typeof outcomePrices === 'string') {
        outcomePrices = JSON.parse(outcomePrices)
    }
    return (outcomePrices as string[]).reduce((a: any, b: any) => parseFloat(a) + parseFloat(b), 0)
}

export async function fetchTokensBook(tokens: string[]) {
    if (!Array.isArray(tokens) || tokens.length === 0) return []

    try {
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
    } catch (e) {
        console.error("fetchTokensBook error:", e)
        return []
    }
}

export async function fetchUpcomingEvents(startHours: number = 0, endHours: number = 24, maxCount: number = 10000): Promise<PolymarketEvent[]> {
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
            // console.log(data.length)
            if (data.length === 0) break;

            // 过滤掉小于最小交易量的事件
            const parsedEvents = data.filter(e => (e.volume || 0) >= config.MIN_VOLUME);
            parsedEvents.forEach(e => {
                // 初始化数据
                e.tradeCount = 0

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