import Table from 'cli-table3';
import UpdateManager from 'stdout-update';

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";

dotenvConfig({ path: resolve(__dirname, `../${process.env.ENV_FILE || ''}.env`) });

import { initEncryptor } from "./config";
initEncryptor()

import './utils/console'

import { EventMonitor } from './event-monitor';
import { UserMonitor } from './user-monitor';
import { calculateTimeToEnd, formatTimeFromMs } from './helper';
import { getCash, getPositions, initPositions, savePositions } from './position';
import { initOrderQueue } from './order-queue';

import './strategy'; // 启动策略监听
import { PriceMonitor } from './price-monitor';



async function main() {

    const manager = UpdateManager.getInstance();

    const monitor = new EventMonitor();
    const userMonitor = new UserMonitor();
    const priceMonitor = new PriceMonitor();

    process.on('SIGINT', async () => {
        console.info('SIGINT received — shutting down gracefully...');
        await priceMonitor.stop()
        await userMonitor.stop()
        await monitor.stop();
        await savePositions();
        process.exit(0);
    });

    const renderTable = () => {
        // positions
        const cash = getCash()
        const positions = getPositions()
        const events = monitor.getEvents()
        const pt = new Table({
            wordWrap: true,
            head: [
                "EventId",
                "TokenId",
                "Outcome",
                "EntryPrice",
                "CurrentPrice",
                "Size",
                "PnL"
            ],
        })
        positions.forEach(p => {
            pt.push([
                `${p.eventId}`,
                `${p.tokenId}`,
                `${p.outcome}`,
                `${p.entryPrice}`,
                `${p.currentPrice}`,
                `${p.size}`,
                `${p.realizedPnL ? +p.realizedPnL.toFixed(4) : 0}`
            ])
        })
        // event list
        const et = new Table({
            wordWrap: true,
            head: [
                "title",
                "volume",
                "endsIn",
                "tradeCount",
                "negRisk",
                "yesPrices"
            ],
        });

        events.forEach(e => {
            const timeToEnd = calculateTimeToEnd(e.endDate);
            et.push([
                `${e.title}[${e.id}]`,
                e.volume.toLocaleString(),
                timeToEnd < 0 ? "00:00:00" : formatTimeFromMs(timeToEnd),
                e.tradeCount ?? 0,
                e.negRisk ? "Y" : "N",
                e.markets.map((m, i) => ((i + 1) % 5 === 0 ? `${m.tokens[0].ask.price}\n` : `${m.tokens[0].ask.price ?? 0}`)).join(",")
            ]);
        });
        const data = `Cash:${cash}\nPositions:\n${pt.toString()}\n\nEvents:\n${et.toString()}`.split("\n")
        manager.update(data)
    }

    // 清除控制台
    console.clear()
    manager.hook()
    // 每秒刷新 UI
    const interval = setInterval(renderTable, 1000);
    // 加载 positions
    await initPositions();
    await initOrderQueue();
    userMonitor.start();
    priceMonitor.start();
    await monitor.start();
    clearInterval(interval);
    manager.unhook(false);
}

main().catch(err => {
    console.error('Fatal error in monitor:', err);
    process.exit(1);
});