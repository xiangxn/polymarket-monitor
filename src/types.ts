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
    tags: any[],

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
    stopLoss: number;
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