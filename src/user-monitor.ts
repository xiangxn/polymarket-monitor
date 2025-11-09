import WebSocket from 'ws';
import { PolymarketClient, searchPositions } from './polymarket';
import { getConfig } from './config';
import { chunkArray, sleep } from './helper';
import { eventBus } from './event-bus';
import { setCash } from './position';
import { SocksProxyAgent } from 'socks-proxy-agent';

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
            console.debug(`User WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
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

                if (!['trade', 'order'].includes(data.event_type)) return;

                if (data.event_type === 'order') {
                    console.debug(`WS order: ${JSON.stringify(data)}`)
                    eventBus.emit('order', data)
                    return
                }
                if (data.event_type === 'trade') {
                    console.debug(`WS trade: ${JSON.stringify(data)}`)
                    if (data.status === 'MATCHED') {
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

    async checkRedeem() {
        while (this.running) {
            try {
                let positions = await searchPositions(config.FUNDER_ADDRESS)
                positions = positions.filter(p => p.size > 0)
                const chunks = chunkArray(positions, 3)
                for (const chunk of chunks) {
                    await Promise.all(chunk.map(p => {
                        if (p.negativeRisk === false) {
                            return this.client.redeem(p.conditionId, p.negativeRisk)
                        } else {
                            const amounts = ["0", "0"]
                            amounts[parseInt(p.outcomeIndex)] = p.size
                            return this.client.redeem(p.conditionId, p.negativeRisk, amounts)
                        }
                    }))
                    await sleep(1)
                }
                await sleep(20)
            } catch (err) {
                console.error(`checkRedeem error: ${JSON.stringify(err)}`)
                await sleep(5)
            }
        }
        console.info('checkRedeem stopped')
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