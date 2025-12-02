import WebSocket from 'ws';
import { getConfig } from './config';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { sleep } from './utils/helper';

const config = getConfig();

const binanceMap = new Map<string, number>()
const chainlinkMap = new Map<string, number>()

/**
 *  根据symbol获取外部价格
 * @param symbol 
 * @returns 
 */
export const getExternalPrice = (symbol: string, resolutionSource: string) => {
    if (resolutionSource.includes('data.chain.link')) {
        return chainlinkMap.get(symbol.toUpperCase()) ?? 0
    } else if (resolutionSource.includes('www.binance.com')) {
        return binanceMap.get(symbol.toUpperCase()) ?? 0
    }
    return 0
}

export class PriceMonitor {
    private running = false;
    private ws: WebSocket | null = null;
    private readonly wsUrl = 'wss://ws-live-data.polymarket.com';
    // 控制重试/退避
    private reconnectBaseMs = 1000;
    private reconnectMaxMs = 30_000;

    private pinging = false;
    private readonly subscriptions = [
        {
            "topic": "crypto_prices",
            "type": "update",
            "filters": ""   // `[{"symbol":"solusdt"},{"symbol":"btcusdt"},{"symbol":"ethusdt"},{"symbol":"xrpusdt"}]`
        },
        {
            "topic": "crypto_prices_chainlink",
            "type": "update",
            "filters": ""
        }
    ]

    async start() {
        if (this.running) return;
        console.info('PriceMonitor starting...');
        this.running = true;
        this.createWS()
        this.attachHandlers()
    }

    async stop() {
        this.running = false
        this.ws?.close()
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
            await sleep(5)
        }
    }

    private createWS() {
        if (config.SOCKS_PROXY) {
            this.ws = new WebSocket(this.wsUrl, { agent: new SocksProxyAgent(config.SOCKS_PROXY) as any });
        } else {
            this.ws = new WebSocket(this.wsUrl);
        }
    }

    private attachHandlers() {
        if (!this.ws) return

        this.ws.onopen = () => {
            console.debug('Price Info WS connected');
            this.ws?.send(JSON.stringify({
                "action": "subscribe",
                "subscriptions": this.subscriptions
            }))
            setTimeout(() => this.ping(), 1000);
        };

        this.ws.onclose = (ev) => {
            console.debug(`Price WS closed (code=${ev.code})`);
            // 如果批次已经结束或外部停止，则直接 resolve（如果尚未 resolve）
            if (this.running === false) {
                console.info('PriceMonitor stopped.');
                return;
            }

            let backoffMs = this.reconnectBaseMs;
            // 否则我们需要重连（带退避）
            console.debug(`Price WS closed unexpectedly. Reconnecting in ${backoffMs}ms...`);
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
            console.error(`Price WS error: ${JSON.stringify(err)}`);
        };

        this.ws.onmessage = (raw) => {
            // console.log(`onmessage: ${JSON.stringify(raw.data)}`)
            if (raw.data === 'PONG' || raw.data === '') return

            try {
                const data = JSON.parse(raw.data.toString())
                if (data.payload && data.topic && data.topic === 'crypto_prices') {
                    const { symbol, price } = data.payload
                    binanceMap.set(symbol.replace('usdt', '').toUpperCase(), price)
                } else if (data.payload && data.topic && data.topic === 'crypto_prices_chainlink') {
                    const { symbol, value } = data.payload
                    chainlinkMap.set(symbol.replace('/usd', '').toUpperCase(), value)
                }
            } catch (err) {
                console.error('Price WS onmessage parse error', err);
            }
        }
    }
}