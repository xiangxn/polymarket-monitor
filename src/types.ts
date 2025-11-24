import { computeReturns, std } from "./utils/math";

export interface PolymarketEvent {
    id: string;
    ticker: string | null;
    title: string | null;
    endDate: string;
    active: boolean;
    closed: boolean;
    negRisk: boolean;
    volume: number;
    seriesSlug: string;
    markets: PolymarketMarket[];
    tags: any[];

    // 自定义字段
    tradeCount: number;
    // 事件的开盘价，用于计算
    openPrice: number;
    // 预测标的symbol
    targetSymbol: CryptoPriceSymbol;
}

export interface PolymarketMarket {
    id: string;
    conditionId: string;
    clobTokenIds: string[];
    outcomes: string[];  // e.g. [Yes, No],[Up, Down]
    slug: string;
    endDate: string;
    negRisk: boolean;
    volume: number;
    active: boolean;
    closed: boolean;
    eventStartTime: string;
    tags: any[];
    // index=0 为Yes[UP], index=1 为No[DOWN]
    tokens: Token[];
    liquidityNum: number;
}

export interface Token {
    tokenId: string;
    outcome: string;
    price: number;
    bid: Book;
    ask: Book;
    lastBuy: { time: number, price: number, size: number }[];   // 只维护最近10s的数据,成交买价历史
    lastSell: { time: number, price: number, size: number }[];  // 只维护最近10s的数据，成交卖价历史
}

export interface Book {
    price: number;
    size: number;
}

// Possibleprofit
export interface PossibleProfit {
    tokenId: string;
    profitPct: number;
}

export interface OrderTask {
    type: 'buy' | 'sell';
    eventId: string;
    marketId: string;
    conditionId: string;
    tokenId: string;
    outcome: string;
    amount: number; // buy时为usdc数量，sell时为token数量
    price: number;
    createdAt: number;
}

// 暂时不考虑多订单维护，后期再升级
export interface Position {
    eventId: string;
    marketId: string;
    conditionId: string;
    tokenId: string;
    outcome: string;
    entryPrice: number;
    size: number;
    currentPrice: number;
    // 止损价
    stopLoss: number;
    // 止损确认时间
    stopLossTime?: number;
    timestamp: number;
    realizedPnL?: number;

    // 服务返回的数据
    orderID?: string;
    txHashes?: string[];
}

export interface PostOrderResult {
    errorMsg: string;
    orderID: string;
    txHashes: string[];
    takingAmount: number;
    makingAmount: number;
    status: string;
    transactionsHashes: string[];
    success: boolean;
}

export interface OrderMessage {
    asset_id: string;
    associate_trades: string[] | null;
    event_type: string;
    id: string;
    market: string;     //	condition ID of market
    order_owner: string;//	owner of order
    original_size: string;//	original order size
    outcome: string;
    owner: string;  //	owner of orders
    price: string;
    side: string;   //	BUY/SELL
    size_matched: string;//	size of order that has been matched
    timestamp: string;
    type: string;
}

export type CryptoPriceSymbol = 'SOL' | 'BTC' | 'ETH' | 'XRP'
export type CryptoPriceUint = 'fifteen' | 'hourly' | 'fourhour' | 'daily' | 'weekly' | 'monthly'


export interface MetadataType {
    slug: string;
    market: string;
    token: string;
    outcome: string;
    price: number;
    size: number;
}

export interface BestPrice { bestBuy: number, bestSell: number }

export type PPoint = { ts: number; price: number; };
export class SlidingWindow {
    private arr: PPoint[] = [];
    private lastPPoint: PPoint = { ts: 0, price: 0 }
    private ms = 10_000;

    constructor(ms?: number) {
        if (ms) {
            this.ms = ms
        }
    }

    push(p: PPoint) {
        if (p.ts - this.lastPPoint.ts > 1000 || p.price !== this.lastPPoint.price) {
            this.arr.push(p)
            this.lastPPoint = p
            this.pruneOlderThan(this.ms)
        }
    }
    private pruneOlderThan(ms: number) {
        const now = Date.now();
        while (this.arr.length && now - this.arr[0].ts > ms) this.arr.shift();
    }
    avg(): number | null {
        if (this.arr.length === 0) return null;
        return this.arr.reduce((s, x) => s + x.price, 0) / this.arr.length;
    }
    last(): number | null {
        if (!this.arr.length) return null;
        return this.arr[this.arr.length - 1].price;
    }
    std(): number | null {
        if (this.arr.length === 0) return null;
        return std(computeReturns(this.arr.map(p => p.price)))
    }
}