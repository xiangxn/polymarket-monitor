import WebSocket from 'ws';
import { fetchMarketBySlug, fetchTokensBook, PolymarketClient, searchPositions } from './polymarket';
import { getConfig } from './config';
import { chunkArray, sleep } from './utils/helper';
import { eventBus } from './event-bus';
import { getCash, setCash } from './position';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { MetadataType } from './types';
import { enqueueOrder } from './order-queue';

const config = getConfig();

export class UserMonitor {
    private running = false;
    private ws: WebSocket | null = null;
    private readonly wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

    // 控制重试/退避
    private reconnectBaseMs = 1000;
    private reconnectMaxMs = 30_000;
    private pinging = false;
    private client: PolymarketClient = new PolymarketClient()

    constructor() {
    }

    async start() {
        if (this.running) return;
        console.info('UserMonitor starting...');
        this.running = true;
        this.createWS()
        this.attachHandlers()
        this.checkRedeem()
        this.checkBalance()
    }

    private getAuth() {
        return { "apiKey": config.CLOB_API_KEY, "secret": config.CLOB_SECRET, "passphrase": config.CLOB_PASS_PHRASE }
    }

    private createWS() {
        if (config.SOCKS_PROXY) {
            this.ws = new WebSocket(this.wsUrl, { agent: new SocksProxyAgent(config.SOCKS_PROXY) as any });
        } else {
            this.ws = new WebSocket(this.wsUrl);
        }
    }

    async ping() {
        if (this.pinging) return;
        this.pinging = true;
        while (this.running) {
            if (this.ws?.readyState === WebSocket.OPEN) {
                this.ws?.send(JSON.stringify({
                    type: 'PING'
                }))
            }
            await sleep(10)
        }
    }

    async stop() {
        this.running = false
        this.pinging = false
        this.ws?.close()
        // 等几个 tick 让 pending things 收尾
        await new Promise(res => setTimeout(res, 500));
    }

    private attachHandlers() {
        if (!this.ws) return
        this.ws.onopen = () => {
            console.debug('User Info WS connected');
            this.ws?.send(JSON.stringify({
                markets: [],
                type: 'USER',
                auth: this.getAuth()
            }))
            setTimeout(() => this.ping(), 1000);
        };
        this.ws.onclose = (ev) => {
            console.debug(`User WS closed (code=${ev.code})`);
            // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
            if (this.running === false) {
                console.info('UserMonitor stopped.');
                return;
            }

            let backoffMs = this.reconnectBaseMs;
            // 否则我们需要重连（带退避）
            console.warn(`User WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
            this.pinging = false
            setTimeout(() => {
                backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                if (this.running) {
                    this.createWS();
                    this.attachHandlers();
                }
            }, backoffMs);
        };
        this.ws.onerror = (err) => {
            console.error(`User WS error: ${JSON.stringify(err)}`);
        };
        this.ws.onmessage = (raw) => {
            if (raw.data === 'PONG') return

            // console.debug('User WS onmessage:', raw.data)

            try {
                const data = JSON.parse(raw.data.toString());

                if (!['trade', 'order'].includes(data.event_type.toLowerCase())) return;

                if (data.event_type === 'order') {
                    console.debug(`WS order: ${JSON.stringify(data)}`)
                    eventBus.emit('order', data)
                    return
                }
                if (data.event_type === 'trade') {
                    console.debug(`WS trade: ${JSON.stringify(data)}`)
                    if (data.status === 'MINED') {  // MATCHED
                        eventBus.emit('order', {
                            asset_id: data.asset_id,
                            associate_trades: null,
                            event_type: 'order',
                            id: data.id,
                            market: data.market,     //	condition ID of market
                            order_owner: data.trade_owner,    //	owner of order
                            original_size: data.size,//	original order size
                            outcome: data.outcome,
                            owner: data.maker_address,  //	owner of orders
                            price: data.price,
                            side: data.side,   //	BUY/SELL
                            size_matched: data.size,    //	size of order that has been matched
                            timestamp: data.match_time,
                            type: "PLACEMENT"
                        })
                    }
                }
            } catch (err) {
                console.error('User WS onmessage parse error', err);
            }
        }
    }

    private async redeemPositions(redeemPositions: any[]) {
        const chunks = chunkArray(redeemPositions, 5)
        for (const chunk of chunks) {
            const conditionIds = chunk.map(p => p.conditionId as string)
            const negRisks = chunk.map(p => p.negativeRisk as boolean)
            const amounts = chunk.map(p => {
                if (p.negativeRisk) {
                    const ams = ["0", "0"]
                    ams[parseInt(p.outcomeIndex)] = p.size
                    return ams
                }
                return []
            })
            const metadatas = chunk.map(p => ({
                market: p.conditionId,
                token: p.asset,
                outcome: p.outcome,
                price: p.avgPrice,
                curPrice: p.curPrice,
                size: p.size
            } as MetadataType))

            const mds = await this.client.redeemBatch(conditionIds, negRisks, amounts, metadatas)
            if (mds && mds.length > 0) {
                // 处理mds,获取市场数据判断盈亏,补充order csv
                await Promise.all(mds.map(md => this.checkProfitLoss(md)))
            }
            await sleep(1)
        }
    }

    private async sellPositions(sellPositions: any[]) {
        for (const pos of sellPositions) {
            const cash = getCash()
            if (cash >= config.MIN_BALANCE + 30) {
                await sleep(1)
                continue
            }
            const market = await fetchMarketBySlug(pos.slug)
            if (!market) {
                await sleep(1)
                continue
            }
            if (Date.now() - new Date(market.endDate).getTime() < 60 * 1000) {
                await sleep(1)
                continue
            }

            let curPrice = pos.curPrice
            const bids = await fetchTokensBook([pos.asset])
            if (bids && bids.length > 0) {
                const price = parseFloat(bids[bids.length - 1].price)
                const size = parseFloat(bids[bids.length - 1].size)
                if (price < 0.999 || size < pos.size) {
                    await sleep(1)
                    continue
                }
                curPrice = Math.max(pos.curPrice, price)
            } else {
                await sleep(1)
                continue
            }

            enqueueOrder({
                type: 'sell',
                conditionId: pos.conditionId,
                eventId: (market.events && market.events.length > 0) ? market.events[0].id : "0",
                tokenId: pos.asset,
                amount: pos.size,
                price: curPrice,
                marketId: market.id,
                outcome: pos.outcome
            })
            await sleep(1)
        }
    }

    async checkRedeem() {
        while (this.running) {
            try {
                let positions = await searchPositions(config.FUNDER_ADDRESS, false)
                positions = positions.filter(p => p.size > 0)
                const redeemPositions = positions.filter(p => p.redeemable)
                const sellPositions = positions.filter(p => p.redeemable === false)
                await this.redeemPositions(redeemPositions) // redeem
                await this.sellPositions(sellPositions);    // sell

                await sleep(60)
            } catch (err) {
                console.error(`checkRedeem error: ${JSON.stringify(err)}`)
                await sleep(5)
            }
        }
        console.info('checkRedeem stopped')
    }

    async checkProfitLoss(md?: MetadataType) {
        if (!md) return
        const { market, token, outcome, size, curPrice } = md
        eventBus.emit('order', {
            asset_id: token,
            associate_trades: null,
            event_type: 'order',
            id: 0,
            market: market,     //	condition ID of market
            order_owner: '',    //	owner of order
            original_size: size,//	original order size
            outcome: outcome,
            owner: '',  //	owner of orders
            price: curPrice,
            side: 'SELL',   //	BUY/SELL
            size_matched: size,    //	size of order that has been matched
            timestamp: Math.floor(Date.now() / 1000),
            type: "UPDATE"
        })
    }

    async checkBalance() {
        while (this.running) {
            try {
                const balance = await this.client.getBalance()
                setCash(balance)
                await sleep(30)
            } catch (err) {
                console.error('checkBalance error:', err)
                await sleep(20)
            }
        }
        console.info('checkBalance stopped')
    }
}