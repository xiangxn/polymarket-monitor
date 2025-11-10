import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import Table from 'cli-table3';

dotenv.config();

// ERC20 ABI 片段 - 只需要 balanceOf 和 decimals 方法
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
];

interface TokenInfo {
    address: string;
    symbol: string;
    name: string;
    decimals: number;
}

interface TokenBalance {
    token: TokenInfo;
    balance: string;
    balanceFormatted: string;
}

interface AddressSummary {
    address: string;
    tokenBalances: TokenBalance[];
    totalUSD: number;
}

// 常见ERC20代币列表
const COMMON_TOKENS: TokenInfo[] = [
    {
        address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', // USDC
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6
    }
];

class ERC20BalanceChecker {
    private provider: ethers.providers.JsonRpcProvider;
    private tokens: TokenInfo[];

    constructor(rpcUrl: string, tokens: TokenInfo[] = COMMON_TOKENS) {
        this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        this.tokens = tokens;
    }

    // 获取单个地址的ERC20余额
    async getAddressBalances(address: string): Promise<TokenBalance[]> {
        const results: TokenBalance[] = [];

        for (const token of this.tokens) {
            try {
                const contract = new ethers.Contract(token.address, ERC20_ABI, this.provider);
                const balance = await contract.balanceOf(address);

                if (balance.gt(0)) {
                    const formattedBalance = ethers.utils.formatUnits(balance, token.decimals);

                    results.push({
                        token,
                        balance: balance.toString(),
                        balanceFormatted: formattedBalance
                    });
                }
            } catch (error: any) {
                console.error(`查询代币 ${token.symbol} 余额失败:`, error.message);
            }
        }

        return results;
    }

    // 批量获取多个地址的余额
    async getBatchBalances(addresses: string[]): Promise<AddressSummary[]> {
        const summaries: AddressSummary[] = [];

        for (const address of addresses) {
            console.log(`正在查询地址: ${address}`);

            const balances = await this.getAddressBalances(address);

            // 计算总价值
            const totalUSD = balances.reduce((total, balance) => total + parseFloat(balance.balanceFormatted), 0);

            summaries.push({
                address,
                tokenBalances: balances,
                totalUSD
            });
        }

        return summaries;
    }

    // 显示单个地址的余额详情
    displayAddressBalances(summary: AddressSummary, index: number): void {
        console.log(`\n=== 地址 ${index + 1}: ${summary.address} ===`);

        if (summary.tokenBalances.length > 0) {
            const table = new Table({
                head: ['代币符号', '代币名称', '余额', '代币地址'],
                colWidths: [15, 25, 20, 42]
            });

            summary.tokenBalances.forEach(balance => {
                table.push([
                    balance.token.symbol,
                    balance.token.name,
                    balance.balanceFormatted,
                    balance.token.address
                ]);
            });

            console.log(table.toString());
        } else {
            console.log('该地址没有检测到ERC20代币余额');
        }
    }

    // 显示汇总信息
    displaySummary(summaries: AddressSummary[]): void {
        console.log('\n=== 汇总信息 ===');
        const summaryTable = new Table({
            head: ['地址', '代币数量', '总余额(USD)'],
            colWidths: [46, 15, 20]
        });

        let totalTokens = 0;
        let totalUSD = 0;

        summaries.forEach(summary => {
            const tokenCount = summary.tokenBalances.length;
            totalTokens += tokenCount;
            totalUSD += summary.totalUSD;

            summaryTable.push([
                summary.address,
                tokenCount.toString(),
                `$${summary.totalUSD.toFixed(2)}`
            ]);
        });

        // 总计行
        summaryTable.push([
            '总计',
            totalTokens.toString(),
            `$${totalUSD.toFixed(2)}`
        ]);

        console.log(summaryTable.toString());
    }
}

// 主函数
async function main() {
    // 从环境变量获取RPC URL，如果没有则使用默认值
    const RPC_URL = process.env.RPC_URL || 'https://polygon-rpc.com';

    // 要查询的地址列表（可以修改为从文件读取或参数传入）
    const addresses = JSON.parse(process.env.CHECK_BALANCE_ADDRESS || '[]');
    if (addresses.length === 0) {
        console.log('请设置CHECK_BALANCE_ADDRESS环境变量')
        return
    }

    // 可以添加自定义代币
    const customTokens: TokenInfo[] = [
        // 在这里添加自定义代币
        // {
        //   address: '0x...',
        //   symbol: 'CUSTOM',
        //   name: 'Custom Token',
        //   decimals: 18
        // }
    ];

    const allTokens = [...COMMON_TOKENS, ...customTokens];
    const checker = new ERC20BalanceChecker(RPC_URL, allTokens);

    console.log('开始批量查询ERC20余额...');
    console.log(`RPC节点: ${RPC_URL}`);
    console.log(`查询地址数量: ${addresses.length}`);
    console.log(`监控代币数量: ${allTokens.length}`);

    const summaries = await checker.getBatchBalances(addresses);

    // 显示每个地址的详细余额
    summaries.forEach((summary, index) => {
        checker.displayAddressBalances(summary, index);
    });

    // 显示汇总信息
    checker.displaySummary(summaries);
}

// 运行脚本
if (require.main === module) {
    main().catch(console.error);
}

export { ERC20BalanceChecker, COMMON_TOKENS };