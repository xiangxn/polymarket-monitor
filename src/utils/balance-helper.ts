import { ethers } from 'ethers';
import { readFile } from 'fs/promises';
import { chunkArray, fetchWithProxy } from './helper';

// ERC20合约ABI（简化版，只包含我们需要的方法）
export const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)'
];

// Multicall3合约ABI
export const MULTICALL3_ABI = [
    'function aggregate(tuple(address target, bytes callData)[] calls) public view returns (uint256 blockNumber, bytes[] returnData)',
    'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) public view returns (tuple(bool success, bytes returnData)[] returnData)'
];

// Multicall3合约地址（主网）
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// 余额信息
export interface BalanceInfo {
    address: string;
    token: TokenInfo;
    balance: string;
    balanceFormatted: string;
}

export interface TokenInfo {
    address: string; symbol: string; name: string; decimals: number;
}

export async function getTokenInfosBatch(provider: ethers.providers.JsonRpcProvider, tokenContracts: string[]): Promise<{ [address: string]: TokenInfo }> {
    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    const calls = [];

    // 为每个代币合约创建3个调用：symbol、name、decimals
    for (const tokenAddress of tokenContracts) {
        const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

        calls.push({
            target: tokenAddress,
            callData: contract.interface.encodeFunctionData('symbol')
        });
        calls.push({
            target: tokenAddress,
            callData: contract.interface.encodeFunctionData('name')
        });
        calls.push({
            target: tokenAddress,
            callData: contract.interface.encodeFunctionData('decimals')
        });
    }

    const tokenInfos: { [address: string]: TokenInfo } = {};
    try {
        const [, returnData] = await multicall.aggregate(calls);


        const tokenAddresses = tokenContracts

        // 解析返回数据
        for (let i = 0; i < tokenAddresses.length; i++) {
            const tokenAddress = tokenAddresses[i];
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

            const symbolData = returnData[i * 3];
            const nameData = returnData[i * 3 + 1];
            const decimalsData = returnData[i * 3 + 2];

            try {
                const symbol = contract.interface.decodeFunctionResult('symbol', symbolData)[0] || 'UNKNOWN';
                const name = contract.interface.decodeFunctionResult('name', nameData)[0] || 'Unknown Token';
                const decimals = contract.interface.decodeFunctionResult('decimals', decimalsData)[0] || 18;

                tokenInfos[tokenAddress] = { symbol, name, decimals, address: tokenAddress };
            } catch (error) {
                console.error(`解析代币信息失败 ${tokenAddress}:`, error);
                tokenInfos[tokenAddress] = { symbol: 'UNKNOWN', name: 'Unknown Token', decimals: 18, address: tokenAddress };
            }
        }
    } catch (error) {
        console.error('Multicall获取代币信息失败:', error);
    }
    return tokenInfos;
}

export async function getBalancesBatch(provider: ethers.providers.JsonRpcProvider, tokenContracts: string[], addresses: string[]): Promise<BalanceInfo[]> {
    const results: BalanceInfo[] = [];

    // 批量获取代币信息
    const tokenInfos = await getTokenInfosBatch(provider, tokenContracts);

    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
    const calls = [];
    const callMapping: { index: number; address: string; tokenAddress: string }[] = [];

    // 为每个地址和每个代币创建balanceOf调用
    let callIndex = 0;
    for (const address of addresses) {
        for (const tokenAddress of tokenContracts) {
            const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);

            calls.push({
                target: tokenAddress,
                callData: contract.interface.encodeFunctionData('balanceOf', [address])
            });

            callMapping.push({
                index: callIndex,
                address: address,
                tokenAddress
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
            if (!tokenInfo) continue;

            if (success && data && data !== '0x') {
                try {
                    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
                    const balance = contract.interface.decodeFunctionResult('balanceOf', data)[0];
                    const balanceFormatted = ethers.utils.formatUnits(balance, tokenInfo.decimals);

                    results.push({
                        address,
                        token: { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals, address: tokenInfo.address },
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
                    token: { symbol: tokenInfo.symbol, name: tokenInfo.name, decimals: tokenInfo.decimals, address: tokenInfo.address },
                    balance: '0',
                    balanceFormatted: '0'
                });
            }
        }
    } catch (error) {
        console.error('Multicall获取余额失败:', error);
    }

    return results;
}

export async function loadJson(path: string) {
    return JSON.parse(await readFile(path, 'utf8'));
};

export async function getPositionsBatch(addresses: string[]) {
    const result: { [address: string]: number } = {};
    const chunks = chunkArray(addresses, 5)
    for (const chunk of chunks) {
        const pos = await Promise.all(chunk.map(address => searchPositions(address)))
        pos.forEach(p => {
            p.forEach(item => {
                let old = result[item.proxyWallet] ?? 0
                result[item.proxyWallet] = old + item.size * item.curPrice
            })
        })
    }
    return result;
}

export async function searchPositions(proxyWallet: string, proxy: string | undefined = process.env.SOCKS_PROXY) {
    if (ethers.utils.isAddress(proxyWallet)) {
        try {
            const params = new URLSearchParams({
                redeemable: 'false',
                sizeThreshold: '0',
                limit: '100',
                sortBy: 'TOKENS',
                sortDirection: 'DESC',
                user: proxyWallet
            })
            const url = `https://data-api.polymarket.com/positions?${params.toString()}`
            // console.debug(`searchPositions url: ${url}`)
            const response = await fetchWithProxy(url, {}, proxy);
            if (!response.ok) throw new Error(`Data API failed: ${response.status}`);
            const data = await response.json() as any[];
            return data
        } catch (e) {
            console.error("searchPositions error:", e)
        }
    }
    return []
}