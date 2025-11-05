import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';
import { PolymarketClient, searchPositions } from './polymarket';
import { getConfig } from './config';
import { chunkArray, sleep } from './helper';
import { eventBus } from './event-bus';

const config = getConfig();

export class UserMonitor {
    private running = false;
    private ws: WebSocket | null = null;
    private readonly wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/user';

    // 控制重试/退避
    private reconnectBaseMs = 1000;
    private reconnectMaxMs = 30_000;

    constructor() {

    }

    async start() {
        this.running = true;
        this.createWS()
        this.attachHandlers()
        this.checkRedeem()
    }

    createWS() {
        if (config.HTTPS_PROXY) {
            this.ws = new WebSocket(this.wsUrl, { agent: new HttpsProxyAgent(config.HTTPS_PROXY) as any });
        } else {
            this.ws = new WebSocket(this.wsUrl);
        }
    }

    async stop() {
        this.running = false
        this.ws?.close()
        // 等几个 tick 让 pending things 收尾
        await new Promise(res => setTimeout(res, 500));
    }

    private attachHandlers() {
        if (!this.ws) return
        this.ws.onopen = () => {
            console.debug('User Info WS connected');
        };
        this.ws.onclose = (ev) => {
            console.debug(`User WS closed (code=${ev.code})`);
            // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
            if (this.running === false) {
                return;
            }

            let backoffMs = this.reconnectBaseMs;
            // 否则我们需要重连（带退避）
            console.debug(`User WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
            setTimeout(() => {
                backoffMs = Math.min(backoffMs * 1.5, this.reconnectMaxMs);
                if (this.running) {
                    this.createWS();
                    this.attachHandlers();
                }
            }, backoffMs);
        };
        this.ws.onerror = (err) => {
            console.error('User WS error', err);
        };
        this.ws.onmessage = (raw) => {
            try {
                const data = JSON.parse(raw.data.toString());

                if (!['trade', 'order'].includes(data.event_type)) return;

                if (data.event_type === 'order') {
                    console.debug('order:', data)
                    eventBus.emit('order', data)
                }
            } catch (err) {
                console.error('User WS onmessage parse error', err);
            }
        }
    }

    async checkRedeem() {
        const client: PolymarketClient = new PolymarketClient()
        while (this.running) {
            try {
                const positions = await searchPositions(config.FUNDER_ADDRESS)
                const chunks = chunkArray(positions, 3)
                for (const chunk of chunks) {
                    await Promise.all(chunk.map(p => {
                        if (p.negativeRisk === false) {
                            return client.redeem(p.conditionId, p.negativeRisk)
                        } else {
                            const amounts = ["0", "0"]
                            amounts[parseInt(p.outcomeIndex)] = p.size
                            return client.redeem(p.conditionId, p.negativeRisk, amounts)
                        }
                    }))
                    await sleep(1000)
                }
                await sleep(5000)
            } catch (err) {
                console.error('checkRedeem error:', err)
                await sleep(5000)
            }
        }
    }
}