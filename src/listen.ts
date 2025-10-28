import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from 'ws';

import dotenv from "dotenv"
dotenv.config()

import { config } from './config';
import { initTelegramBot, sendAlert } from "./notifiers/telegram-notifier";

initTelegramBot(
    config.TG_API_KEY,
    config.TG_CHAT_ID,
    config.HTTPS_PROXY
);

function setupWebSocketListener(tokens: { price: number, tokenId: string }[]) {
    if (tokens.length < 1) return

    const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
    let ws: WebSocket
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxy) {
        ws = new WebSocket(wsUrl, { agent: new HttpsProxyAgent(proxy) });
    } else {
        ws = new WebSocket(wsUrl);
    }

    ws.onopen = () => {
        console.debug('WS connected');
        ws.send(JSON.stringify({ type: 'MARKET', assets_ids: tokens.map(t => t.tokenId) }));
        console.debug(`Subscribed to ${tokens.length} tokens`);
    };

    const eventsMap: { [name: string]: boolean } = {
        'price_change': true,
        'last_trade_price': true,
        'book': true
    }

    ws.onmessage = async (wsEvent) => {

        const update = JSON.parse(wsEvent.data.toString());

        if (!eventsMap[update.event_type]) return;

        if (update.event_type === 'book') {
            /**
            {
                market: '0x0bb71cc44f03792b447f0515871dba55a9331bf9b035be0321fac050a85222cb',
                asset_id: '45158219890981277236047911963078197293833284894759865197979294050560155010790',
                bids: [
                    { price: '0.6', size: '1044.36' },
                    { price: '0.61', size: '150.44' }
                ],
                asks: [
                    { price: '0.99', size: '55216' },
                    { price: '0.98', size: '7447' }
                ],
                hash: '21f9bd293328664552f5f05111a9ae8678b60e75',
                timestamp: '1761491848538',
                event_type: 'book'
                }
            */
            const token = tokens.find(t => t.tokenId === update.asset_id)
            if (!token) return

            if (update.bids.length > 0) {
                const bid = update.bids[update.bids.length - 1]
                const slPrice = token.price * (1 - config.LISTEN_STOP_LOSS)
                const tpPrice = token.price * (1 + config.LISTEN_TAKE_PROFIT)
                if (bid.price < slPrice || bid.price >= tpPrice) {
                    console.debug(`${token.tokenId} 触发止损止盈`)
                    const msg = `卖出token:[${token.tokenId}]\n价格:${bid.price} 最大数量:${bid.size}\n市场:[${update.market}]`
                    await sendAlert(msg)
                }
            }
            return
        }

    };

    ws.onclose = () => {
        console.log('WS disconnected. Reconnect in 5s...');
        setTimeout(() => setupWebSocketListener(tokens), 5000);
    };

    ws.onerror = (error) => console.error('WS error:', error);
}

setupWebSocketListener(config.LISTEN_TOKENS)