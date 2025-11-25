import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, `../${process.env.ENV_FILE || ''}.env`) });

import { initEncryptor } from "../src/config";
initEncryptor()

import '../src/utils/console'

import { MarketMonitor } from '../src/market-monitor';
import { CryptoPriceStrategy } from "../src/strategies/crypto-price-strategy";



async function main() {

    const marketMonitor = new MarketMonitor()
    const fifteenStrategy = new CryptoPriceStrategy()

    process.on('SIGINT', async () => {
        console.info('SIGINT received — shutting down gracefully...');
        await marketMonitor.stop()
        process.exit(0);
    });


    // 清除控制台
    console.clear()

    fifteenStrategy.start()
    await marketMonitor.start();
}

main().catch(err => {
    console.error('Fatal error in monitor:', err);
    process.exit(1);
});