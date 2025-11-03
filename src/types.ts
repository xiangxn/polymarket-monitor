export interface PolymarketEvent {
    id: string;
    ticker: string | null;
    title: string | null;
    startDate: string;
    endDate: string;
    active: boolean;
    closed: boolean;
    negRisk: boolean;
    volume: number;
    markets: PolymarketMarket[];

    // 自定义字段
    tradeCount: number;
}

export interface PolymarketMarket {
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

export interface Token {
    tokenId: string;
    outcome: string;
    price: number;
    bid: Book;
    ask: Book;
    lastBuy: { time: number, price: number, size: number }[];   // 只维护最近10s的数据
    lastSell: { time: number, price: number, size: number }[];  // 只维护最近10s的数据
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
    tokenId: string;
    outcome: string;
    entryPrice: number;
    size: number;
    currentPrice: number;
    stopLoss: number;
    timestamp: number;
    realizedPnL?: number;
}