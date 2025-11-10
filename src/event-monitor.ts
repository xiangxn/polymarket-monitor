import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from 'ws';
import { fetchCryptoPrice, fetchUpcomingEvents, getSearchTimeUnit, getStartTime, getSymbol, getTimeUnit } from './polymarket';
import { getConfig } from './config';
import { PolymarketEvent } from './types';
import { chunkArray, sleep } from './helper';
import { eventBus } from './event-bus';
import { get } from "http";

const config = getConfig();
/**
 * 说明：
 *  - 这个文件实现了一个长期运行的 EventMonitor 类。
 *  - 它使用单一主循环（runLoop），不会递归调用 startEventMonitor。
 *  - monitorBatch 会启动 WebSocket 并在「这批 events 全部结束」或「外部 stop」时 resolve。
 *
 *  使用：在项目入口调用 `const m = new EventMonitor(); m.start()`。
 */

// --------------------------- EventMonitor ---------------------------
export class EventMonitor {
    private running = false;
    private globalStopRequested = false;

    // 控制重试/退避
    private reconnectBaseMs = 1000;
    private reconnectMaxMs = 30_000;

    // 事件数据
    private events: PolymarketEvent[] = [];

    constructor() {
        // process.on('SIGINT', async () => {
        //     console.info('\nSIGINT received — shutting down gracefully...');
        //     await this.stop();
        //     process.exit(0);
        // });
    }

    public getEvents() {
        return this.events
    }

    public checkWindow(price: number): boolean {
        if (Array.isArray(config.ENTER_WINDOW) === false || config.ENTER_WINDOW.length < 2) {
            console.warn("config.ENTER_WINDOW is not an array")
            return false
        }
        return price >= config.ENTER_WINDOW[0] && price <= config.ENTER_WINDOW[1]
    }

    async start() {
        if (this.running) return;
        this.running = true;
        this.globalStopRequested = false;
        console.info('EventMonitor starting...');
        await this.runLoop();
    }

    async stop() {
        // 发出停止信号，runLoop 会结束
        this.globalStopRequested = true;
        this.running = false;
        // 等几个 tick 让 pending things 收尾
        await new Promise(res => setTimeout(res, 500));
    }

    private async runLoop() {
        // 主循环：非递归，便于长期运行
        while (!this.globalStopRequested) {
            try {
                const startTime = config.SEARCH_START_TIME;
                const endTime = config.SEARCH_END_TIME;

                // 拉取一批 events（你已有的实现）
                this.events = await fetchUpcomingEvents(startTime, endTime);
                if (!this.events || this.events.length === 0) {
                    console.debug('No events found. Sleeping for 1 minutes...');
                    await sleep(60);
                    continue;
                }

                console.info(`Fetched ${this.events.length} events to monitor.`);

                // 监控这批事件直到它们全部结束（或监控被停止）
                await this.monitorBatch(this.events);

                eventBus.emit('batch_finished', structuredClone(this.events)) //一轮完成,清仓
                // 这一轮结束后，给出短暂休息（避免速率问题）
                await sleep(config.MIN_CYCLE_DELAY_MS);
            } catch (err) {
                console.error('runLoop error:', err);
                // 如果出错，等待一段时间再继续（避免 tight-loop）
                await sleep(5);
            }
        }

        console.info('EventMonitor stopped.');
    }

    // 监控一批 events；当它们全部结束或 stop 被请求时返回
    private async monitorBatch(events: PolymarketEvent[]) {
        // 如果全局停止，立即返回
        if (this.globalStopRequested) return;

        // WS url 与订阅列表
        const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
        const assetIds = events.flatMap((e: any) => e.markets.flatMap((m: any) => m.tokens.map((t: any) => t.tokenId))).filter(Boolean);
        if (assetIds.length === 0) {
            console.info('No tokens to subscribe for this batch.');
            return;
        }

        // 根据slug获取对应event的开盘价(只会处理Crypto-price类型的event)
        const chunks = chunkArray(events, 5)
        for (const chunk of chunks) {
            const results = await Promise.all(chunk.map(e => {
                const symbol = getSymbol(e.tags)
                if (!symbol) return new Promise(res => res(null))
                const u = getTimeUnit(e.tags)
                if (!u) return new Promise(res => res(null))
                const unit = getSearchTimeUnit(u)
                const startTime = getStartTime(u, e.endDate)
                if (!startTime) return new Promise(res => res(null))
                return fetchCryptoPrice(symbol, startTime, new Date(e.endDate), unit)
            }))
            chunk.forEach((e, i) => {
                if (results[i] === null) {
                    e.openPrice = 0
                } else {
                    e.openPrice = results[i] as number
                }
            })
        }

        // 指示器：当所有 events 都结束时 resolve
        return new Promise<void>(async (resolve) => {
            let ws: WebSocket | null = null;
            let backoffMs = this.reconnectBaseMs;
            let ended = false;      // 表示该批次已完成（所有 events 结束）
            let pinging = false;

            const createWS = () => {
                const proxy = config.SOCKS_PROXY;
                if (proxy) {
                    return new WebSocket(wsUrl, { agent: new SocksProxyAgent(proxy) as any });
                } else {
                    return new WebSocket(wsUrl);
                }
            };

            async function ping() {
                if (pinging) return;
                pinging = true;
                while (ended) {
                    if (ws?.readyState === WebSocket.OPEN) {
                        ws?.send(JSON.stringify({
                            type: 'PING'
                        }))
                    }
                    await sleep(10)
                }
            }

            // 供 onmessage 使用：检查是否所有 events 都结束
            const checkAllEnded = () => {
                const stillOpen = events.some((e: any) => {
                    const timeToEnd = (new Date(e.endDate)).getTime() - Date.now();
                    return timeToEnd > 0; // 只要存在未结束
                });
                return !stillOpen;
            };

            const attachHandlers = (socket: WebSocket) => {
                socket.onopen = () => {
                    console.debug('WS connected');
                    backoffMs = this.reconnectBaseMs; // 成功连接后重置退避
                    if (assetIds.length > 0) {
                        socket.send(JSON.stringify({ type: 'MARKET', assets_ids: assetIds }));
                        console.debug(`Subscribed to ${assetIds.length} tokens for ${events.length} events`);
                    }
                    setTimeout(() => ping(), 1000);
                };

                socket.onmessage = (raw) => {
                    if (raw.data === 'PONG') return

                    try {
                        const update = JSON.parse(raw.data.toString());

                        // 只处理感兴趣的事件
                        const { event_type } = update;
                        if (!['last_trade_price', 'book'].includes(event_type)) return; // ['price_change', 'last_trade_price', 'book']

                        // 找对应 event & market
                        const event = events.find((e: any) => e.markets.some((m: any) => m.conditionId === update.market));
                        if (!event) return;

                        const market = event.markets.find((m: any) => m.conditionId === update.market);
                        if (!market) return;

                        // 处理 book
                        if (event_type === 'book') {
                            // update bids/asks
                            const token = market.tokens.find((t: any) => t.tokenId === update.asset_id);
                            if (!token) return;
                            const bidIndex = update.bids.length - 1;
                            const askIndex = update.asks.length - 1;
                            token.bid = update.bids.length > 0 ? { price: parseFloat(update.bids[bidIndex].price), size: parseFloat(update.bids[bidIndex].size) } : { price: 0, size: 0 };
                            token.ask = update.asks.length > 0 ? { price: parseFloat(update.asks[askIndex].price), size: parseFloat(update.asks[askIndex].size) } : { price: 0, size: 0 };
                            eventBus.emit('price_update', { marketId: market.id, tokenId: token.tokenId, event });
                            return;
                        }

                        // 处理 last_trade_price
                        if (event_type === 'last_trade_price') {
                            const trade = update as any;
                            const vol = parseFloat(trade.size) * parseFloat(trade.price);
                            event.volume = (event.volume || 0) + vol;
                            event.tradeCount = (event.tradeCount || 0) + 1;
                            // 维护 lastBuy/lastSell
                            const token = market.tokens.find((t) => t.tokenId === update.asset_id);
                            if (!token) return;
                            token.price = parseFloat(trade.price);
                            if (trade.side.toUpperCase() === 'BUY') {
                                token.lastBuy.push({ time: Date.now(), price: parseFloat(trade.price), size: parseFloat(trade.size) });
                                token.lastBuy = token.lastBuy.filter(t => t.time > Date.now() - config.KEEP_LAST_TRADE_TIME * 1000)
                            } else {
                                token.lastSell.push({ time: Date.now(), price: parseFloat(trade.price), size: parseFloat(trade.size) });
                                token.lastSell = token.lastSell.filter(t => t.time > Date.now() - config.KEEP_LAST_TRADE_TIME * 1000)
                            }
                            eventBus.emit('price_update', { marketId: market.id, tokenId: token.tokenId, event });
                            // check结束
                            const finished = checkAllEnded()
                            if (finished && !ended) {
                                ended = true;
                                try { socket.close(1000, 'batch-finished'); } catch (e) { }
                                resolve();
                            }
                            return;
                        }
                    } catch (err) {
                        console.error('WS onmessage parse error', err);
                    }
                };

                socket.onclose = (ev) => {
                    console.debug(`WS closed (code=${ev.code})`);
                    // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
                    if (ended || this.globalStopRequested) {
                        if (!ended) ended = true;
                        resolve();
                        return;
                    }

                    // 否则我们需要重连（带退避）
                    console.debug(`WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
                    pinging = false
                    setTimeout(() => {
                        backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                        if (!this.globalStopRequested) {
                            ws = createWS();
                            attachHandlers(ws);
                        }
                    }, backoffMs);
                };

                socket.onerror = (err) => {
                    console.error(`WS error: ${JSON.stringify(err)}`);
                    // onerror 后可能马上 onclose，会触发重连逻辑
                };
            };

            // 启动第一个 ws
            ws = createWS();
            attachHandlers(ws);

            // 额外的安全守护：如果到达所有 events 的 endDate 且没有收到ws消息导致结束，轮询检查一次
            const guardIntervalMs = 1000;
            const guard = setInterval(() => {
                if (this.globalStopRequested) {
                    clearInterval(guard);
                    try { if (ws && ws.readyState === WebSocket.OPEN) { ws.close(1000, 'global-stop'); } } catch { }
                    resolve();
                    return;
                }

                // 如果所有 events 到期，则主动结束（防止 ws 消息丢失）
                const allEndedNow = checkAllEnded();
                if (allEndedNow && !ended) {
                    ended = true;
                    clearInterval(guard);
                    try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'guard-finish'); } catch { }
                    resolve();
                }
            }, guardIntervalMs);
        });
    }
}

