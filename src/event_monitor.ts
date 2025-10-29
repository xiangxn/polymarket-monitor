import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import UpdateManager from 'stdout-update';
import Table from "cli-table3";
import { fetchUpcomingEvents } from './polymarket';
import { config } from './config';
import { PolymarketEvent } from './types';
import { calculateTimeToEnd, formatTimeFromMs, sleep } from './helper';

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
    private manager = UpdateManager.getInstance();
    private globalStopRequested = false;
    private checkEventProfits: (event: PolymarketEvent) => number;

    // 控制重试/退避
    private reconnectBaseMs = 1000;
    private reconnectMaxMs = 30_000;

    // 事件数据
    private events: PolymarketEvent[] = [];

    constructor(detectEventProfits?: (event: PolymarketEvent) => number) {
        this.manager.hook();
        if (detectEventProfits) {
            this.checkEventProfits = detectEventProfits
        } else {
            this.checkEventProfits = this.detectEventProfits
        }
        process.on('SIGINT', async () => {
            console.info('\nSIGINT received — shutting down gracefully...');
            await this.stop();
            process.exit(0);
        });
    }

    public checkWindow(price: number): boolean {
        if (Array.isArray(config.ENTER_WINDOW) === false || config.ENTER_WINDOW.length < 2) {
            console.warn("config.ENTER_WINDOW is not an array")
            return false
        }
        return price >= config.ENTER_WINDOW[0] && price <= config.ENTER_WINDOW[1]
    }

    detectEventProfits(event: PolymarketEvent): number {
        if (event.negRisk) {
            // 互斥事件
            const markets = event.markets.filter(m => m.negRisk)    // 只取互斥事件的市场
            // 从价格高到低排序市场
            markets.sort((a, b) => b.tokens[0].ask.price - a.tokens[0].ask.price)

            // 扫尾盘检查
            if (markets[0].tokens[0].ask.price - markets[1].tokens[0].ask.price > config.MIN_MARKET_SPREAD && this.checkWindow(markets[0].tokens[0].ask.price)) {
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
                    const index = spread > 0 ? 0 : 1
                    if (Math.abs(spread) > config.MIN_MARKET_SPREAD && this.checkWindow(m.tokens[index].ask.price)) {
                        // 可能存在扫尾盘机会
                        event.canSweep = { can: true, marketId: m.id }
                        totalProfit += 1 - m.tokens[index].ask.price
                    } else {
                        event.canSweep = { can: false, marketId: "0" }
                    }
                }
            })
            return totalProfit
        }

        return 0
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
        this.manager.unhook(false);
    }

    private async runLoop() {
        // 主循环：非递归，便于长期运行
        const minCycleDelayMs = config.MIN_CYCLE_DELAY_MS ?? 2; // 每轮最小间隔
        while (!this.globalStopRequested) {
            try {
                const startHours = config.SEARCH_START_HOURS;
                const endHours = config.SEARCH_END_HOURS;

                // 拉取一批 events（你已有的实现）
                this.events = await fetchUpcomingEvents(startHours, endHours);
                if (!this.events || this.events.length === 0) {
                    console.debug('No events found. Sleeping for 5 minutes...');
                    await sleep(60);
                    continue;
                }

                console.info(`Fetched ${this.events.length} events to monitor.`);
                // 启动定时刷新表格
                const renderInterval = setInterval(() => this.renderTable(this.events), 1000);

                // 监控这批事件直到它们全部结束（或监控被停止）
                await this.monitorBatch(this.events);

                // 监控结束后清除定时器
                clearInterval(renderInterval);

                // 这一轮结束后，给出短暂休息（避免速率问题）
                await sleep(minCycleDelayMs);
            } catch (err) {
                console.error('runLoop error:', err);
                // 如果出错，等待一段时间再继续（避免 tight-loop）
                await sleep(5);
            }
        }

        console.info('EventMonitor stopped main loop.');
    }

    // 监控一批 events；当它们全部结束或 stop 被请求时返回
    private async monitorBatch(events: PolymarketEvent[]) {
        // 如果全局停止，立即返回
        if (this.globalStopRequested) return;

        // WS url 与订阅列表（按你原来逻辑）
        const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
        const assetIds = events.flatMap((e: any) => e.markets.flatMap((m: any) => m.tokens.map((t: any) => t.tokenId))).filter(Boolean);
        if (assetIds.length === 0) {
            console.info('No tokens to subscribe for this batch.');
            return;
        }

        // 指示器：当所有 events 都结束时 resolve
        return new Promise<void>(async (resolve) => {
            let ws: WebSocket | null = null;
            let backoffMs = this.reconnectBaseMs;
            let ended = false;      // 表示该批次已完成（所有 events 结束）

            const createWS = () => {
                const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
                if (proxy) {
                    return new WebSocket(wsUrl, { agent: new HttpsProxyAgent(proxy) as any });
                } else {
                    return new WebSocket(wsUrl);
                }
            };

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
                };

                socket.onmessage = (raw) => {
                    try {
                        const update = JSON.parse(raw.data.toString());

                        // 只处理感兴趣的事件
                        const { event_type } = update;
                        if (!['price_change', 'last_trade_price', 'book'].includes(event_type)) return;

                        // 找对应 event & market
                        const event: any = events.find((e: any) => e.markets.some((m: any) => m.conditionId === update.market));
                        if (!event) return;
                        const market: any = event.markets.find((m: any) => m.conditionId === update.market);

                        // 处理 book
                        if (event_type === 'book') {
                            // update bids/asks -> 同你原逻辑
                            const token = market.tokens.find((t: any) => t.tokenId === update.asset_id);
                            const bidIndex = update.bids.length - 1;
                            const askIndex = update.asks.length - 1;
                            token.bid = update.bids.length > 0 ? { price: parseFloat(update.bids[bidIndex].price), size: parseFloat(update.bids[bidIndex].size) } : { price: 0, size: 0 };
                            token.ask = update.asks.length > 0 ? { price: parseFloat(update.asks[askIndex].price), size: parseFloat(update.asks[askIndex].size) } : { price: 0, size: 0 };
                            return;
                        }

                        // 处理 last_trade_price
                        if (event_type === 'last_trade_price') {
                            const trade = update as any;
                            const vol = parseFloat(trade.size) * parseFloat(trade.price);
                            event.volume = (event.volume || 0) + vol;
                            event.tradeCount = (event.tradeCount || 0) + 1;
                            // check结束
                            const finished = checkAllEnded()
                            if (finished && !ended) {
                                ended = true;
                                try { socket.close(1000, 'batch-finished'); } catch (e) { }
                                resolve();
                            }
                            return;
                        }

                        // 处理 price_change
                        if (event_type === 'price_change') {
                            update.price_changes.forEach((c: any) => {
                                const token = market.tokens.find((t: any) => t.tokenId === c.asset_id);
                                if (token) token.price = parseFloat(c.price);
                                const index = market.clobTokenIds.findIndex((t: string) => t === c.asset_id) ?? -1;
                                if (index > -1) {
                                    market.outcomePrices[index] = c.price;
                                    if (index === 0) {
                                        market.bestBid = parseFloat(c.best_bid);
                                        market.bestAsk = parseFloat(c.best_ask);
                                    }
                                }
                            });

                            const totalProfit = this.checkEventProfits(event);
                            if (event.totalProfit !== totalProfit) {
                                event.totalProfit = totalProfit
                            }
                            
                            const finished = checkAllEnded()
                            if (finished && !ended) {
                                ended = true;
                                try { socket.close(1000, 'batch-finished'); } catch (e) { }
                                resolve();
                            }
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
                    setTimeout(() => {
                        backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                        if (!this.globalStopRequested) {
                            ws = createWS();
                            attachHandlers(ws);
                        }
                    }, backoffMs);
                };

                socket.onerror = (err) => {
                    console.error('WS error', err);
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

    renderTable(events: PolymarketEvent[]) {
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
        });

        // p.printTable()
        const data = p.toString().split("\n");
        this.manager.update(data)
    }
}

