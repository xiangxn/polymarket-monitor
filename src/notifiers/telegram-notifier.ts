import TelegramBot from 'node-telegram-bot-api';
import { SocksProxyAgent } from 'socks-proxy-agent';

let bot: TelegramBot;
let chatId: string;

export function initTelegramBot(token: string, chat_id: string, proxyUrl?: string) {
    chatId = chat_id;

    if (proxyUrl) {
        const agent = new SocksProxyAgent(proxyUrl);

        bot = new TelegramBot(token, {
            polling: false,
            request: {
                agent,
            } as any
        });
    } else {
        bot = new TelegramBot(token, { polling: false });
    }
}

export async function sendAlert(message: string) {
    if (!bot || !chatId) {
        console.warn('[Telegram] Bot 未初始化，无法发送');
        return;
    }

    return bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch((err) => {
        console.error('[Telegram] 发送失败：', err.message);
    });
}