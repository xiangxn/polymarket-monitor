import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, `../${process.env.ENV_FILE || ''}.env`) });

import { initEncryptor } from "./config";
initEncryptor()

import './utils/console'

import './strategies/fifteen-strategy'; // 启动策略监听
import { MarketMonitor } from './market-monitor';



async function main() {

    const marketMonitor = new MarketMonitor()

    process.on('SIGINT', async () => {
        console.info('SIGINT received — shutting down gracefully...');
        await marketMonitor.stop()
        process.exit(0);
    });


    // 清除控制台
    console.clear()

    await marketMonitor.start();
}

main().catch(err => {
    console.error('Fatal error in monitor:', err);
    process.exit(1);
});