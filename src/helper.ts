import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { config } from './config';

export async function fetchWithProxy(url: string, options: any = {}) {
    const proxy = config.HTTPS_PROXY;
    if (proxy) {
        options.agent = new HttpsProxyAgent(proxy);
    }
    return fetch(url, options);
}

export function convertTokens(market: any) {
    const tokens: { tokenId: string; outcome: string, price: number, bid: { price: number, size: number }, ask: { price: number, size: number } }[] = []
    if (typeof market.clobTokenIds === 'string') {
        market.clobTokenIds = JSON.parse(market.clobTokenIds)
    }
    if (typeof market.outcomes === 'string') {
        market.outcomes = JSON.parse(market.outcomes)
    }
    if (typeof market.outcomePrices === 'string') {
        market.outcomePrices = JSON.parse(market.outcomePrices)
    }
    for (let i = 0; i < market.clobTokenIds.length; i++) {
        const price = parseFloat(market.outcomePrices[i]?.toString() ?? "0")
        tokens.push({
            tokenId: market.clobTokenIds[i],
            outcome: market.outcomes[i],
            price: price,
            bid: {
                price: 0,
                size: 0
            },
            ask: {
                price: 0,
                size: 0
            }
        })
    }
    return tokens
}

export function calcTotalPrice(outcomePrices: string | string[]): number {
    if (typeof outcomePrices === 'string') {
        outcomePrices = JSON.parse(outcomePrices)
    }
    return (outcomePrices as string[]).reduce((a: any, b: any) => parseFloat(a) + parseFloat(b), 0)
}

export const sleep = async (seconds: number) => {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(void 0);
        }, seconds * 1000);
    })
}

export function calculateTimeToEnd(endDateIso: string): number {
    return new Date(endDateIso).getTime() - Date.now(); // ms
}

export function formatTimeFromMs(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}