import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getConfig } from './config';

const config = getConfig()

export async function fetchWithProxy(url: string, options: any = {}) {
    const proxy = config.HTTPS_PROXY;
    if (proxy) {
        options.agent = new HttpsProxyAgent(proxy);
    }
    return fetch(url, options);
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