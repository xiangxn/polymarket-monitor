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
    tradeCount: number;
    markets: PolymarketMarket[];

    canSweep: { can: boolean, marketId: string };
    possibleProfits: PossibleProfit[];
    totalProfit: number;
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