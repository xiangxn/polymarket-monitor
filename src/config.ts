export const config = {
    HTTPS_PROXY: (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) ?? undefined,
    MIN_PROFIT_BINARY: parseFloat(process.env.MIN_PROFIT_BINARY ?? "0.01"),
    MIN_PROFIT_MULTI: parseFloat(process.env.MIN_PROFIT_MULTI ?? "0.02"),
    MIN_VOLUME: parseFloat(process.env.MIN_VOLUME ?? "10000"),
    MAX_COST: parseFloat(process.env.MIN_VOLUME ?? "0.005"),
    MIN_MARKET_SPREAD: parseFloat(process.env.MIN_MARKET_SPREAD ?? "0.05"),
    SEARCH_START_HOURS: parseFloat(process.env.SEARCH_START_HOURS ?? "0"),
    SEARCH_END_HOURS: parseFloat(process.env.SEARCH_END_HOURS ?? "24"),
    ENTER_WINDOW: JSON.parse(process.env.ENTER_WINDOW ?? "[0.8,0.92]"),
    MIN_CYCLE_DELAY_MS: parseFloat(process.env.MIN_CYCLE_DELAY_MS ?? "2"),

    // 监控
    LISTEN_TAKE_PROFIT: parseFloat(process.env.LISTEN_TAKE_PROFIT ?? "0.4"),
    LISTEN_STOP_LOSS: parseFloat(process.env.LISTEN_STOP_LOSS ?? "0.1"),
    LISTEN_TOKENS: JSON.parse(process.env.LISTEN_TOKENS ?? "[]"),
    TG_API_KEY: process.env.TG_API_KEY ?? "",
    TG_CHAT_ID: process.env.TG_CHAT_ID ?? "",
}