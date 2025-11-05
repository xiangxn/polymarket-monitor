import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { access, stat } from 'fs/promises';
import { constants } from 'fs';


export async function fetchWithProxy(url: string, options: any = {}, proxy: string | undefined) {
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

export async function fileExists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK); // F_OK 表示检查文件是否存在
        return true;
    } catch {
        return false;
    }
}

export async function dirExists(path: string): Promise<boolean> {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false; // 不存在 或 无访问权限
    }
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
    return arr.reduce<T[][]>((acc, curr, index) => {
        if (index % size === 0) acc.push([]);
        acc[acc.length - 1].push(curr);
        return acc;
    }, []);
}