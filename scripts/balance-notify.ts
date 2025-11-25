import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, `../${process.env.ENV_FILE || ''}.env`) });

import { ethers } from 'ethers';
import { initTelegramBot, sendAlert } from '../src/notifiers/telegram-notifier';

// ERC20合约ABI（简化版，只包含我们需要的方法）
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
];

// Multicall3合约ABI
const MULTICALL3_ABI = [
    'function aggregate(tuple(address target, bytes callData)[] calls) public view returns (uint256 blockNumber, bytes[] returnData)',
    'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) public view returns (tuple(bool success, bytes returnData)[] returnData)'
];

// Multicall3合约地址（主网）
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// 配置项
interface Config {
    rpcUrl: string;
    telegramBotToken: string;
    telegramChatId: string;
    addresses: string[];
    tokenContracts: {
        [symbol: string]: {
            address: string;
            name?: string;
            decimals?: number;
        }
    };
}

// 余额信息
interface BalanceInfo {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    balance: string;
    balanceFormatted: string;
}

class BalanceMonitor {
    private provider: ethers.providers.JsonRpcProvider;
    private config: Config;

    constructor(config: Config) {
        this.provider = new ethers.providers.JsonRpcProvider(config.rpcUrl);
        this.config = config;
        initTelegramBot(config.telegramBotToken, config.telegramChatId)
    }

    // 获取单个token的信息
    async getTokenInfo(contractAddress: string): Promise<{ symbol: string; name: string; decimals: number }> {
        try {
            const contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);

            const [symbol, name, decimals] = await Promise.all([
                contract.symbol(),
                contract.name(),
                contract.decimals()
            ]);

            return {
                symbol: symbol || 'UNKNOWN',
                name: name || 'Unknown Token',
                decimals: decimals || 18
            };
        } catch (error) {
            console.error(`获取token信息失败 ${contractAddress}:`, error);
            return {
                symbol: 'UNKNOWN',
                name: 'Unknown Token',
                decimals: 18
            };
        }
    }

    // 使用multicall3批量获取代币信息
    async getTokenInfosBatch(): Promise<{ [address: string]: { symbol: string; name: string; decimals: number } }> {
        const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.provider);
        const calls = [];

        // 为每个代币合约创建3个调用：symbol、name、decimals
        for (const tokenInfo of Object.values(this.config.tokenContracts)) {
            const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, this.provider);

            calls.push({
                target: tokenInfo.address,
                callData: contract.interface.encodeFunctionData('symbol')
            });
            calls.push({
                target: tokenInfo.address,
                callData: contract.interface.encodeFunctionData('name')
            });
            calls.push({
                target: tokenInfo.address,
                callData: contract.interface.encodeFunctionData('decimals')
            });
        }

        try {
            const [, returnData] = await multicall.aggregate(calls);

            const tokenInfos: { [address: string]: { symbol: string; name: string; decimals: number } } = {};
            const tokenAddresses = Object.values(this.config.tokenContracts).map(t => t.address);

            // 解析返回数据
            for (let i = 0; i < tokenAddresses.length; i++) {
                const tokenAddress = tokenAddresses[i];
                const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);

                const symbolData = returnData[i * 3];
                const nameData = returnData[i * 3 + 1];
                const decimalsData = returnData[i * 3 + 2];

                try {
                    const symbol = contract.interface.decodeFunctionResult('symbol', symbolData)[0] || 'UNKNOWN';
                    const name = contract.interface.decodeFunctionResult('name', nameData)[0] || 'Unknown Token';
                    const decimals = contract.interface.decodeFunctionResult('decimals', decimalsData)[0] || 18;

                    tokenInfos[tokenAddress] = { symbol, name, decimals };
                } catch (error) {
                    console.error(`解析代币信息失败 ${tokenAddress}:`, error);
                    tokenInfos[tokenAddress] = { symbol: 'UNKNOWN', name: 'Unknown Token', decimals: 18 };
                }
            }

            return tokenInfos;
        } catch (error) {
            console.error('Multicall获取代币信息失败:', error);
            // 降级为单个获取
            const tokenInfos: { [address: string]: { symbol: string; name: string; decimals: number } } = {};

            for (const [symbol, tokenInfo] of Object.entries(this.config.tokenContracts)) {
                const tokenInfoFromChain = await this.getTokenInfo(tokenInfo.address);
                tokenInfos[tokenInfo.address] = {
                    symbol: tokenInfoFromChain.symbol,
                    name: tokenInfoFromChain.name,
                    decimals: tokenInfoFromChain.decimals
                };
            }

            return tokenInfos;
        }
    }

    // 批量获取余额（使用multicall3方式）
    async getBalancesBatch(): Promise<BalanceInfo[]> {
        const results: BalanceInfo[] = [];

        // 批量获取代币信息
        const tokenInfos = await this.getTokenInfosBatch();

        const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, this.provider);
        const calls = [];
        const callMapping: { index: number; address: string; tokenAddress: string }[] = [];

        // 为每个地址和每个代币创建balanceOf调用
        let callIndex = 0;
        for (const address of this.config.addresses) {
            for (const [symbol, tokenInfo] of Object.entries(this.config.tokenContracts)) {
                const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, this.provider);

                calls.push({
                    target: tokenInfo.address,
                    callData: contract.interface.encodeFunctionData('balanceOf', [address])
                });

                callMapping.push({
                    index: callIndex,
                    address: address,
                    tokenAddress: tokenInfo.address
                });

                callIndex++;
            }
        }

        try {
            // 使用tryAggregate，即使部分调用失败也不影响其他调用
            const returnData = await multicall.tryAggregate(false, calls);

            // 解析返回数据
            for (const mapping of callMapping) {
                const { index, address, tokenAddress } = mapping;
                const { success, returnData: data } = returnData[index];

                const tokenInfo = tokenInfos[tokenAddress];
                const configTokenInfo = Object.values(this.config.tokenContracts).find(t => t.address === tokenAddress);

                if (success && data && data !== '0x') {
                    try {
                        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, this.provider);
                        const balance = contract.interface.decodeFunctionResult('balanceOf', data)[0];
                        const balanceFormatted = ethers.utils.formatUnits(balance, tokenInfo.decimals);

                        results.push({
                            address,
                            symbol: tokenInfo.symbol,
                            name: configTokenInfo?.name || tokenInfo.name,
                            decimals: tokenInfo.decimals,
                            balance: balance.toString(),
                            balanceFormatted
                        });
                    } catch (error) {
                        console.error(`解析余额失败 ${address} ${tokenInfo.symbol}:`, error);
                    }
                } else {
                    // 调用失败，添加0余额记录
                    results.push({
                        address,
                        symbol: tokenInfo.symbol,
                        name: configTokenInfo?.name || tokenInfo.name,
                        decimals: tokenInfo.decimals,
                        balance: '0',
                        balanceFormatted: '0'
                    });
                }
            }
        } catch (error) {
            console.error('Multicall获取余额失败:', error);
            // 降级为单个获取
            for (const [symbol, tokenInfo] of Object.entries(this.config.tokenContracts)) {
                const tokenInfoFromChain = tokenInfos[tokenInfo.address];

                for (const address of this.config.addresses) {
                    try {
                        const contract = new ethers.Contract(tokenInfo.address, ERC20_ABI, this.provider);
                        const balance = await contract.balanceOf(address);
                        const balanceFormatted = ethers.utils.formatUnits(balance, tokenInfoFromChain.decimals);

                        results.push({
                            address,
                            symbol: tokenInfoFromChain.symbol,
                            name: tokenInfo.name || tokenInfoFromChain.name,
                            decimals: tokenInfoFromChain.decimals,
                            balance: balance.toString(),
                            balanceFormatted
                        });
                    } catch (error) {
                        console.error(`获取余额失败 ${address} ${symbol}:`, error);
                        results.push({
                            address,
                            symbol: tokenInfoFromChain.symbol,
                            name: tokenInfo.name || tokenInfoFromChain.name,
                            decimals: tokenInfoFromChain.decimals,
                            balance: '0',
                            balanceFormatted: '0'
                        });
                    }
                }
            }
        }

        return results;
    }

    // 发送Telegram消息
    async sendTelegramMessage(message: string): Promise<void> {
        await sendAlert(message)
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

            tokenBalances.forEach(token => {
                if (parseFloat(token.balanceFormatted) > 0) {
                    message += `  ${token.symbol}: ${token.balanceFormatted}\n`;
                }
            });

            message += '\n';
        });

        // 汇总信息
        const totalTokens = new Set(balances.map(b => b.symbol)).size;
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
        tokenContracts: {
            'USDC': {
                address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
                name: 'USD Coin',
                decimals: 6
            }
        }
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