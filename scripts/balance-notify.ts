import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, `../${process.env.ENV_FILE || ''}.env`) });

import { ethers } from 'ethers';
import { initTelegramBot, sendAlert } from '../src/notifiers/telegram-notifier';
import { BalanceInfo, getBalancesBatch, getPositionsBatch } from "../src/utils/balance-helper";

// 配置项
interface Config {
    rpcUrl: string;
    telegramBotToken: string;
    telegramChatId: string;
    addresses: string[];
    tokenContracts: string[];
}

class BalanceMonitor {
    private provider: ethers.providers.JsonRpcProvider;
    private config: Config;

    constructor(config: Config) {
        this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
        this.config = config;
        initTelegramBot(config.telegramBotToken, config.telegramChatId)
    }

    // 批量获取余额（使用multicall3方式）
    async getBalancesBatch() {
        const results: BalanceInfo[] = await getBalancesBatch(this.provider, this.config.tokenContracts, this.config.addresses)
        const positions = await getPositionsBatch(this.config.addresses)
        results.forEach(bInfo => {
            bInfo.balanceFormatted = (parseFloat(bInfo.balanceFormatted) + (positions[bInfo.address.toLowerCase()] ?? 0)).toFixed(4)
        })
        return results;
    }

    // 发送Telegram消息
    async sendTelegramMessage(message: string): Promise<void> {
        await sendAlert(message, true)
    }

    // 格式化余额报告
    formatBalanceReport(balances: BalanceInfo[]): string {
        let message = '<b>💰 Polymarket 余额监控报告</b>\n\n';

        // 按地址分组
        const balancesByAddress: { [address: string]: BalanceInfo[] } = {};
        balances.forEach(balance => {
            if (!balancesByAddress[balance.address]) {
                balancesByAddress[balance.address] = [];
            }
            balancesByAddress[balance.address].push(balance);
        });

        // 为每个地址生成报告
        Object.entries(balancesByAddress).forEach(([address, tokenBalances]) => {
            message += `<b>地址:</b> <a href="https://polygonscan.com/address/${address}">${address}</a>\n`;

            tokenBalances.forEach(balance => {
                if (parseFloat(balance.balanceFormatted) > 0) {
                    message += `  ${balance.token.symbol}: ${balance.balanceFormatted}\n`;
                }
            });

            message += '\n';
        });

        // 汇总信息
        const totalTokens = new Set(balances.map(b => b.token.symbol)).size;
        const totalAddresses = Object.keys(balancesByAddress).length;
        const nonZeroBalances = balances.filter(b => parseFloat(b.balanceFormatted) > 0).length;

        message += `<i>统计: ${totalAddresses}个地址, ${totalTokens}种代币, ${nonZeroBalances}个非零余额</i>`;

        return message;
    }

    // 主执行函数
    async run(): Promise<void> {
        console.log('开始获取ERC20余额...');

        try {
            // 获取所有余额
            const balances = await this.getBalancesBatch();

            // 过滤掉余额为0的记录
            const nonZeroBalances = balances.filter(balance => parseFloat(balance.balanceFormatted) > 0);

            if (nonZeroBalances.length === 0) {
                console.log('所有余额均为0, 不发送通知');
                return;
            }

            // 格式化报告
            const report = this.formatBalanceReport(nonZeroBalances);

            // 发送Telegram消息
            await this.sendTelegramMessage(report);

            console.log('余额监控完成');

        } catch (error: any) {
            console.error('执行余额监控失败:', error);
            await this.sendTelegramMessage(`❌ 余额监控执行失败: ${error.message}`);
        }
    }
}

// 使用示例
async function main() {
    // 从环境变量或配置文件读取配置
    const config: Config = {
        rpcUrl: process.env.RPC_URL || 'https://polygon-rpc.com',
        telegramBotToken: process.env.TG_API_KEY || '',
        telegramChatId: process.env.TG_CHAT_ID || '',
        addresses: JSON.parse(process.env.CHECK_BALANCE_ADDRESS || '[]'),
        tokenContracts: ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174']
    };

    // 检查必要配置
    if (!config.telegramBotToken || !config.telegramChatId) {
        console.error('请设置TELEGRAM_BOT_TOKEN和TELEGRAM_CHAT_ID环境变量');
        process.exit(1);
    }

    const monitor = new BalanceMonitor(config);
    await monitor.run();
}

// 如果直接运行此文件
if (require.main === module) {
    main().catch(console.error);
}

export { BalanceMonitor, Config, BalanceInfo };