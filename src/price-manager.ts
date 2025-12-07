import { SocksProxyAgent } from "socks-proxy-agent";
import WebSocket from 'ws';

export type Book = {
    price: number;
    size: number;
}
export type PriceData = {
    tokenId: string;
    bestAsk: Book;
    bestBid: Book;
    market: string;
    timestamp: number;
};
// 价格更新回调类型
export type PriceUpdateCallback = (priceData: PriceData | null) => void;
export class PriceManager {
    private ws: WebSocket | null = null;
    private callbacks: Set<PriceUpdateCallback> = new Set();
    /**
     * tokenId -> PriceData
     */
    private tokensPrice: Map<string, PriceData> = new Map();
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isConnecting: boolean = false;
    private subsTokens: string[] = [];
    private wsReconnectInterval = 5000; // 5秒重连间隔
    private wsTimeout = 10000;

    constructor(wsReconnectInterval: number = 5000, wsTimeout: number = 10000) {
        this.wsReconnectInterval = wsReconnectInterval;
        this.wsTimeout = wsTimeout;
    }

    /**
     * 订阅价格更新
     */
    subscribe(callback: PriceUpdateCallback): () => void {
        this.callbacks.add(callback);

        // 返回取消订阅函数
        return () => {
            this.callbacks.delete(callback);
        };
    }

    /**
     * 连接到 WebSocket
     */
    async connect(): Promise<void> {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
            return;
        }

        this.isConnecting = true;

        try {
            console.info(`🔌 连接到 WebSocket: wss://ws-subscriptions-clob.polymarket.com/ws/market`);

            this.ws = new WebSocket('wss://ws-subscriptions-clob.polymarket.com/ws/market', {
                agent: new SocksProxyAgent(process.env.SOCKS_PROXY ?? "socks5h://127.0.0.1:1080") as any,
                timeout: this.wsTimeout
            });

            // 设置连接超时
            const connectionTimeout = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.terminate();
                    console.warn('⏰ WebSocket 连接超时');
                }
            }, this.wsTimeout);

            this.ws.on('open', () => {
                clearTimeout(connectionTimeout);
                this.isConnecting = false;
                console.info('✅ WebSocket 连接已建立');

                // 订阅市场数据
                this.subscribeToMarket();
            });

            this.ws.on('message', (data: WebSocket.Data) => {
                if (data.toString() === "PONG") return
                try {
                    const message = JSON.parse(data.toString());
                    this.handleMessage(message);
                } catch (error) {
                    console.error('解析 WebSocket 消息失败:', error);
                }
            });

            this.ws.on('close', (code: number, reason: Buffer) => {
                clearTimeout(connectionTimeout);
                this.isConnecting = false;
                console.info(`🔌 WebSocket 连接已关闭: ${code} ${reason.toString()}`);

                // 自动重连
                if (code !== 1000) { // 非正常关闭才重连
                    this.scheduleReconnect();
                }
            });

            this.ws.on('error', (error: Error) => {
                clearTimeout(connectionTimeout);
                console.error('WebSocket 错误:', error);
                this.isConnecting = false;
            });

        } catch (error) {
            this.isConnecting = false;
            console.error('WebSocket 连接失败:', error);
            this.scheduleReconnect();
        }
    }

    /**
     * 订阅特定市场
     */
    public subscribeToMarket(tokens?: string[]): void {
        if (tokens) {
            this.subsTokens = this.subsTokens.concat(tokens)
            this.subsTokens = Array.from(new Set(this.subsTokens))
        }
        if (this.subsTokens.length === 0) return

        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }
        try {
            // 根据文档订阅市场数据
            const subscribeMessage = { type: 'MARKET', assets_ids: Array.from(this.subsTokens) };

            this.ws.send(JSON.stringify(subscribeMessage));
            console.debug(`📡 已订阅市场: ${JSON.stringify(this.subsTokens)}`);
        } catch (error) {
            console.error('订阅市场失败:', error);
        }
    }

    public unsubscribeToMarket(tokens?: string[]): void {
        if (tokens) {
            this.subsTokens = this.subsTokens.filter(token => !tokens.includes(token))
            tokens.forEach(token => this.tokensPrice.delete(token))
        }
    }

    /**
     * 处理 WebSocket 消息
     */
    private handleMessage(message: any): void {
        try {
            const { event_type } = message;
            if (event_type === 'book') {
                const { market, asset_id, bids, asks } = message;
                const bestBid = bids.length > 0 ? { price: parseFloat(bids[bids.length - 1].price), size: parseFloat(bids[bids.length - 1].size) } : { price: 0, size: 0 }
                const bestAsk = asks.length > 0 ? { price: parseFloat(asks[asks.length - 1].price), size: parseFloat(asks[asks.length - 1].size) } : { price: 0, size: 0 }
                // 更新价格数据
                const newPrice: PriceData = {
                    tokenId: asset_id,
                    bestBid,
                    bestAsk,
                    market,
                    timestamp: Date.now()
                };
                this.updatePrice(newPrice);
            } else if (event_type === 'last_trade_price') {
                // 暂时什么也不做
            }
        } catch (error) {
            console.error('处理 WebSocket 消息失败:', error, message);
        }
    }

    /**
     * 更新价格并通知订阅者
     */
    private updatePrice(priceData: PriceData): void {
        let currentPrice = this.tokensPrice.get(priceData.tokenId)
        if (!currentPrice) {
            currentPrice = priceData
            this.tokensPrice.set(priceData.tokenId, currentPrice)
        } else {
            currentPrice = priceData;
        }

        // 通知所有订阅者
        this.callbacks.forEach(callback => {
            try {
                callback(currentPrice);
            } catch (error) {
                console.error('价格更新回调失败:', error);
            }
        });
    }

    /**
     * 安排重连
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }

        this.reconnectTimer = setTimeout(() => {
            console.debug('🔄 尝试重新连接 WebSocket...');
            this.connect();
        }, this.wsReconnectInterval);
    }

    /**
     * 获取当前价格
     */
    getCurrentPrice(tokenId: string): PriceData | undefined {
        return this.tokensPrice.get(tokenId);
    }

    /**
     * 断开连接
     */
    disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.ws) {
            this.ws.close(1000, 'Normal closure');
            this.ws = null;
        }

        this.subsTokens = [];
        this.callbacks.clear();
        this.tokensPrice.clear();
    }
}