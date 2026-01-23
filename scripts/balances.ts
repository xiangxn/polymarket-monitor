import { ethers } from 'ethers';
import Table from 'cli-table3';
import { BalanceInfo, getBalancesBatch, getPositionsBatch, loadJson } from '../src/utils/balance-helper';
import dotenv from "dotenv"
dotenv.config()

interface AddressSummary {
    address: string;
    tokenBalances: BalanceInfo[];
    totalUSD: number;
}

// 常见ERC20代币列表
const COMMON_TOKENS = ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174']


class ERC20BalanceChecker {
    private provider: ethers.providers.JsonRpcProvider;
    private tokens: string[];

    constructor(rpcUrl: string, tokens: string[] = COMMON_TOKENS) {
        this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
        this.tokens = tokens;
    }

    // 批量获取多个地址的余额
    async getBatchBalances(addresses: string[], isPosition: boolean): Promise<AddressSummary[]> {
        const summaries: AddressSummary[] = [];

        console.log(`正在查询 ${addresses.length} 个地址...`);
        const balances = await getBalancesBatch(this.provider, this.tokens, addresses)
        let positions: { [address: string]: number } = {}
        if (isPosition) {
            positions = await getPositionsBatch(addresses)
            // console.log("positions:", positions)
        }

        for (const address of addresses) {
            const userBalances = balances.filter(b => b.address === address)
            userBalances.forEach(bInfo => {
                bInfo.balanceFormatted = (parseFloat(bInfo.balanceFormatted) + (positions[address.toLowerCase()] ?? 0)).toFixed(4)
            })
            const totalUSD = userBalances.reduce((total, balance) => total + parseFloat(balance.balanceFormatted), 0);
            summaries.push({
                address,
                tokenBalances: userBalances,
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
    const args = process.argv.slice(2);
    let addresFile = "all_address.json"
    let isPosition = false
    if (args.length > 0) {
        addresFile = args[0]
    }
    if (args.length > 1 && args[1] === "P") {
        isPosition = true
    }
    let addresses: string[] = []
    try { addresses = await loadJson(addresFile) } catch { }

    // 从环境变量获取RPC URL，如果没有则使用默认值
    const RPC_URL = process.env.RPC_URL || 'https://polygon-rpc.com';

    // 要查询的地址列表（可以修改为从文件读取或参数传入）
    let envAddresses = JSON.parse(process.env.CHECK_BALANCE_ADDRESS || '[]');
    envAddresses = envAddresses.concat(addresses);
    if (envAddresses.length === 0) {
        console.log('请设置CHECK_BALANCE_ADDRESS环境变量')
        return
    }
    envAddresses = [...new Set(envAddresses)]

    // 可以添加自定义代币
    const customTokens: string[] = [];

    const allTokens = [...COMMON_TOKENS, ...customTokens];
    const checker = new ERC20BalanceChecker(RPC_URL, allTokens);

    console.log('开始批量查询ERC20余额...');
    console.log(`RPC节点: ${RPC_URL}`);
    console.log(`查询地址数量: ${envAddresses.length}`);
    console.log(`监控代币数量: ${allTokens.length}`);

    const summaries = await checker.getBatchBalances(envAddresses, isPosition);

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